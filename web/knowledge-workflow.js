(function(root){
'use strict';
const M=typeof module!=='undefined'&&module.exports?require('./model.js'):root.QuoteModel;
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const K=()=>typeof module!=='undefined'&&module.exports?require('./knowledge.js'):root.Knowledge;
const copy=v=>structuredClone(v);
const priceBasis=row=>({name:row.name??'',spec:row.spec??'',unit:row.unit??'',brand:row.brand??'',scope:row.supplyScope??row.scope??''});
const priceState=row=>({basePrice:row.basePrice,override:row.override,pricing:copy(row.pricing||{}),priceSource:row.priceSource,priceEvidence:copy(row.priceEvidence||null),historyReuseBasis:copy(row.historyReuseBasis||null)});
const indexCache=new WeakMap(),rowCache=new WeakMap();
function reviewRequest(rows,choice){
 const evidenceIds=[...new Set(rows.flatMap(row=>{
  const category=K().describeRow(row).category;
  return K().search([row.name,row.spec].join(' '),{limit:20})
   .filter(entry=>entry.category===category||entry.category==='all').slice(0,3).map(entry=>entry.id);
 }))];
 return {rows:rows.map(row=>{
  const candidate=choice?.candidate||row.knowledgeEvidence?.priceMatches?.flatMap(m=>m.candidates||[]).find(c=>c.adoptionBasis?.sameComponent!==false);
  const comparison=candidate?{id:candidate.id,name:candidate.name,spec:candidate.spec,unit:candidate.unit,price:candidate.price,scope:candidate.record?.scope||candidate.scope||'',source:choice?.match?.bookName||candidate.record?.source||'',sourceRefs:copy(candidate.sourceRefs||[]),differences:copy(candidate.blockingDifferences||[]),missing:copy(candidate.technicalMissing||[]),warnings:copy(candidate.warnings||[]),canAdopt:candidate.canAdopt===true}:null;
  return {id:row.id,name:row.name,spec:row.spec,unit:row.unit,scope:row.supplyScope||row.scope||'',source:row.source,quantity:row.quantity,quantityBasis:row.quantityBasis||row.bom?.quantityBasis||'',comparison};
 }),evidenceIds};
}
function annotate(q,books=[],options={}){
 const indexes=books.map(book=>{const key=JSON.stringify(book.index),prior=indexCache.get(book.index);if(prior?.key===key)return prior.compiled;const compiled=K().compilePriceIndex(book.index);indexCache.set(book.index,{key,compiled});return compiled;});
 const context=JSON.stringify([q.currency,q.taxMode,q.taxRate,q.businessTerms,q.pricingDefaults,K().getCatalog().version,books.map(book=>[book.id,book.name])]);
 let matched=0;for(const row of q.rows){
  const key=JSON.stringify([priceBasis(row),row.quantity,row.kind,row.bom,row.geometry,row.pricing,row.parameterConflicts,row.formulaBlocked,row.priceContext,row.currency,row.taxMode,row.taxRate,row.enterpriseId,context]),prior=rowCache.get(row);
  const reusable=prior?.key===key&&prior.indexes.length===indexes.length&&prior.indexes.every((index,i)=>index===indexes[i]);
  const description=reusable?prior.description:K().describeRow(row),results=reusable?prior.results:books.map((book,i)=>({book,result:K().matchPrice(row,indexes[i],{quote:q})}));
  const exact=results.filter(x=>x.result.priceStatus==='exact_history'&&!x.result.candidates?.some(c=>c.record?.learnedCase));
  const values=[...new Set(exact.map(x=>Number(x.result.price)))];
  if(!reusable){row.knowledgeEvidence={...description,entries:K().search([row.name,row.spec].join(' '),{limit:4}),
   priceMatches:results.filter(x=>x.result.priceStatus!=='no_match'||x.result.candidates?.length).map(x=>({bookId:x.book.id,bookName:x.book.name,...x.result}))};rowCache.set(row,{key,indexes,description,results});}
   if(options.applyExact!==false&&values.length===1&&M.number(row.basePrice)===null&&!M.isRequirement(row)&&!K().isFinishedEquipment(row)&&!(description.parameters.linkedChambers>1)&&row.pricing?.mode!=='manual'&&row.override==null){
   const found=exact[0];row.basePrice=values[0];row.pricing={mode:'manual'};
   row.priceEvidence={...copy(found.result),bookId:found.book.id,bookName:found.book.name,priceNature:'historical_quote'};
   row.priceSource='企业历史报价 · '+found.book.name;matched++;
  }
 }
 q.knowledgeVersion=K().getCatalog().version;return {quote:q,matched};
}
function issues(q){
 const tasks=[];for(const row of q.rows){
  if(M.isRequirement(row))tasks.push({rowId:row.id,name:row.name,type:'scope',issue:'工艺要求的供货范围待核对',action:'核对原表覆盖工位及已包含配件，确定独立供货项。',source:row.source});
  else if(row.selected!==false){
   if(M.number(row.quantity)===null)tasks.push({rowId:row.id,name:row.name,type:'quantity',issue:'缺少供货数量',action:row.quantityBasis||'核对按工位、槽体、联槽还是整线计数。',source:row.source});
   if(M.number(row.basePrice)===null&&M.number(row.override)===null){
    const explanation=F.explain?.(row),blocked=explanation?.status==='blocked'||row.pricing?.blocked;
    tasks.push({rowId:row.id,name:row.name,type:'price',
     issue:explanation?.title||(blocked?'结构与报价依据待核':row.pricing?.mode==='formula'?'公式条件待补':'缺少同规格单价'),
     action:explanation?.action||(blocked?'保留已有尺寸与材料，核对特殊结构、供货包含范围及对应报价依据。':row.pricing?.missing?.join('、')||'查看可比历史规格或补供应商有效报价。'),
     pricingStatus:explanation?.status||(blocked?'blocked':row.pricing?.mode==='formula'?'missing':'unpriced'),
     fields:copy(explanation?.fields||[]),scopeIssues:copy(explanation?.scopeIssues||[]),source:row.source});
   }
  }
 }
 for(const item of q.knowledgeReview||[])tasks.push(copy(item));
 return tasks;
}
function adoptPrice(row,match,options={}){
 if(M.isRequirement(row))throw Error('先确认独立供货范围，再采用价格。');
 let chosen=match,adoption=null;
 if(options.candidateId!==undefined){
  const candidate=match.candidates?.find(item=>item.id===options.candidateId);
  if(!candidate?.record)throw Error('价格候选已变化，请重新查看本行候选。');
  const current=K().matchPrice(row,{records:[candidate.record]},{quote:options.quote}).candidates.find(item=>item.id===candidate.id);
  if(!current?.canAdopt&&!(current?.canRecommend&&options.confirmSimilar===true)){if(current?.pendingTechnical&&!current.blockingDifferences.length)throw Error('关键技术参数尚未齐全，不能作为同规格价格采用。'+current.technicalMissing.join('；'));throw Error('关键条件不同，不能作为同规格价格采用。'+(current?.blockingDifferences||[]).join('；'));}
  if(options.confirmed!==true)throw Error('请核对候选差异和原价口径后确认采用。');
  chosen={...copy(match),price:current.price,priceNature:current.priceNature,selectedCandidate:copy(current),candidates:[copy(current)]};
  adoption={candidateId:current.id,confirmed:true,similar:!current.canAdopt,confidence:current.confidence,confirmedAt:new Date().toISOString(),basis:copy(current.adoptionBasis),warnings:copy(current.warnings),differences:copy(current.differences),missingFields:copy(current.missingFields),effectiveContext:copy(current.effectiveContext)};
 }else if(match.priceStatus!=='exact_history'||M.number(match.price)===null)throw Error('先核对规格差异，再采用参考价格。');
 row.priceHistory=row.priceHistory||[];row.priceHistory.push({...priceState(row),basis:copy(priceBasis(row)),adoptedAt:new Date().toISOString()});
 row.basePrice=Number(chosen.price);row.override=null;row.pricing={mode:'manual'};
 if(chosen.selectedCandidate?.record?.learnedCase){row.override=Number(chosen.price);row.priceKind='confirmed_sale';row.historyReuseBasis=M.historyBasis(row,options.quote||{});}else delete row.historyReuseBasis;
 row.priceEvidence={...copy(chosen),priceNature:'historical_quote',...(adoption?{adoption}: {})};row.priceSource=(adoption?.similar?'相似历史价 · 本项目确认 · ':'企业历史报价 · ')+(match.bookName||'已确认候选');
 return row;
}
function priceAvailability(q){
 const summary={equipmentRows:0,pricedRows:0,adoptableRows:0,differentRows:0,noDataRows:0,zeroCandidateRows:0,relatedOnlyRows:0,pendingTechnicalRows:0};
 for(const row of q.rows||[]){
  if(row.selected===false||M.isRequirement(row)||!K().isFinishedEquipment(row))continue;
  summary.equipmentRows++;
  if(M.number(row.override)!==null||M.number(row.basePrice)!==null)summary.pricedRows++;
  const candidates=(row.knowledgeEvidence?.priceMatches||[]).flatMap(match=>match.candidates||[]),same=candidates.filter(candidate=>candidate.adoptionBasis?.sameComponent);
  if(same.some(candidate=>candidate.canAdopt))summary.adoptableRows++;
  else if(!candidates.length){summary.noDataRows++;summary.zeroCandidateRows++;}
  else if(!same.length)summary.relatedOnlyRows++;
  else if(same.some(candidate=>candidate.pendingTechnical&&!candidate.blockingDifferences?.length))summary.pendingTechnicalRows++;
  else summary.differentRows++;
 }
 return summary;
}
function priceDecision(row){
 const candidates=(row.knowledgeEvidence?.priceMatches||[]).flatMap(m=>m.candidates||[]).filter(c=>c.adoptionBasis?.sameComponent);
 candidates.sort((a,b)=>Number(b.canAdopt)-Number(a.canAdopt)||Number(b.name===row.name)-Number(a.name===row.name)||(b.confidence||0)-(a.confidence||0));
 const c=candidates[0];if(!c)return '';
 if(c.canAdopt)return '参考 ¥'+c.price+' · '+(c.needsConfirmation||c.warnings?.length?'核对价格口径':'条件匹配');
 const missing=[...new Set((c.technicalMissing||[]).map(s=>s.replace(/^本行|^历史/g,'').replace(/未记载|未提供|缺少/g,'').trim()))];
 const differences=(c.blockingDifferences||[]).map(s=>s.startsWith('计量单位不同')?'单位 '+row.unit+' / '+c.unit:s);
 return '参考 ¥'+c.price+' · '+[missing.length?'补'+missing.join('、'):'',...differences].filter(Boolean).join('；');
}
function undoPrice(row){
 const previous=Array.isArray(row.priceHistory)?row.priceHistory.at(-1):null;
 if(!previous)throw Error('没有可撤销的采用价格记录。');
 if(!previous.basis)throw Error('这条历史价格缺少规格依据，请重新核价。');
 if(JSON.stringify(previous.basis)!==JSON.stringify(priceBasis(row)))throw Error('规格已变化，请重新核价；不能恢复旧规格价格。');
 const before=priceState(row),restored=priceState(previous);
 Object.assign(row,restored);row.priceHistory.pop();
 row.priceAudit=row.priceAudit||[];row.priceAudit.push({event:'undo_price',at:new Date().toISOString(),adoptedAt:previous.adoptedAt,basis:copy(previous.basis),before,after:copy(restored)});
 return row;
}
function projectDraft(process,reference,comparison){
 const draft=M.copy(process),pairs=comparison.pairs||[];
 draft.title=reference.title||process.title;draft.customer=reference.customer||process.customer;
 draft.date=reference.date||process.date;draft.markup=reference.markup||0;draft.taxMode=reference.taxMode||'none';draft.taxRate=reference.taxRate||0;
 draft.notes=reference.notes||'';draft.sources=[...copy(process.sources||[]).map(s=>({...s,role:'process'})),...copy(reference.sources||[]).map(s=>({...s,role:'project_reference'}))];
 draft.rows=reference.rows.map((r,index)=>{
  if(M.isRequirement(r))return null;
  const paired=pairs.find(p=>p.referenceIndex===index),source=paired?process.rows[paired.processIndex]:null;
  const row={...copy(r),id:M.uid(),pricing:{mode:'manual'},
   priceSource:'本项目参考报价 · '+(r.source||''),
   priceEvidence:{priceNature:'project_reference',source:r.source,sourceRow:r.sourceRow,referenceId:reference.id},
   reconciliation:{origin:source?'process_and_reference':'project_reference',processId:source?.id||null,
    processSource:source?.source||null,issues:copy(paired?.issues||[]),referenceId:r.id}};
  if(source){row.processEvidence={source:source.source,bom:copy(source.bom||{}),name:source.name,spec:source.spec,unit:source.unit,quantity:source.quantity,...priceState(source)};}
  row.reconciliation.adoptedReason='用户选择本项目最终报价作为项目参考，原配置值保留在独立拆解稿及对应记录中。';
  return row;
 }).filter(Boolean);
 draft.knowledgeReview=[...(comparison.processOnly||[]).map(x=>({name:x.row?.name||x.name||'未对应部件',type:'comparison',issue:'配置拆解项未在参考报价中对应',action:x.nextAction||'核对是否包含、取消或替代，保留源记录。',source:x.row?.source||x.source})),
  ...process.rows.filter(M.isRequirement).map(r=>({rowId:r.id,name:r.name,type:'scope',issue:'原工艺要求保留核对',action:'对照参考供货项检查是否已覆盖。',source:r.source}))];
 draft.knowledgeRun={mode:'project_reference',processId:process.id,referenceId:reference.id,summary:copy(comparison.summary),
  generatedAt:new Date().toISOString(),note:'本项目参考报价校准，未变更行业规则或公式参数。'};
 return draft;
}
root.KnowledgeWorkflow={annotate,issues,adoptPrice,undoPrice,priceAvailability,priceDecision,projectDraft,reviewRequest};
if(typeof module!=='undefined'&&module.exports)module.exports=root.KnowledgeWorkflow;
})(typeof window!=='undefined'?window:globalThis);
