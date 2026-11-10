(function(root){
'use strict';
const M=typeof module!=='undefined'&&module.exports?require('./model.js'):root.QuoteModel;
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const A=typeof module!=='undefined'&&module.exports?require('./assembly-pricing.js'):root.QuoteAssemblyPricing;
const S=typeof module!=='undefined'&&module.exports?require('./source-facts.js'):root.QuoteSourceFacts;
const K=()=>typeof module!=='undefined'&&module.exports?require('./knowledge.js'):root.Knowledge;
const W=()=>typeof module!=='undefined'&&module.exports?require('./knowledge-workflow.js'):root.KnowledgeWorkflow;
const U=()=>typeof module!=='undefined'&&module.exports?require('./rules-memory.js'):root.QuoteRulesMemory;
const norm=v=>String(v??'').normalize('NFKC').replace(/\s/g,'');
function hash(value){let n=2166136261;for(const c of value)n=Math.imul(n^c.charCodeAt(0),16777619);return (n>>>0).toString(36);}
const linked=row=>A.linked(row)||/(?:[二两三四五六七八九十\d]+)[联连]/.test(row.name||'');
const writable=row=>row.selected!==false&&!M.isRequirement(row)&&!M.isIncluded(row)&&!row.calculation&&row.pricing?.mode!=='manual'&&row.override==null;
function applicability(q,row){
 const context=S.context(q,row),parsed=F.tankParameters(row.spec),temperature=context?.station?.fields.filter(f=>/(?:工艺)?温度(?:\(|℃|$)|槽温/.test(norm(f.label))&&!/加热|仪表|传感器|温控器/.test(norm(f.label))&&/\d|室温|常温/.test(norm(f.value))).map(f=>norm(f.value).replace(/常温/g,'室温').replace(/[～~至]/g,'-')).filter(Boolean).join(' / ');
 const layers=parsed.layers.filter(l=>l.role!=='body').map(l=>[l.role,norm(l.text)]);
 const process=temperature||norm(context?.station?.operation||row.bom?.operation||row.name);
 return {key:JSON.stringify([context?.key||(row.source||'').replace(/\/\s*第\d+行.*$/,''),process,layers]),label:[context?.label||row.group||'当前来源',temperature?'工艺温度 '+temperature:context?.station?.operation||'当前工艺',layers.length?'同结构配置':'标准主体'].join(' · ')};
}
function priceGroups(q){
 const groups=new Map();
 for(const row of q.rows||[]){
  if(!writable(row)||M.isIncluded(row)||M.number(row.basePrice)!==null||!K().isFinishedEquipment(row)&&!row.knowledgeEvidence?.priceMatches?.some(m=>m.candidates?.some(c=>c.record?.learnedCase&&c.canAdopt&&c.exactSpec)))continue;
  const offers=[];
  for(const match of row.knowledgeEvidence?.priceMatches||[])for(const candidate of match.candidates||[])if((candidate.canAdopt||candidate.canRecommend)&&candidate.record){
   const key=JSON.stringify([match.bookId,candidate.id]);if(!offers.some(o=>o.id===key))offers.push({id:key,price:candidate.price,bookName:match.bookName,bookId:match.bookId,candidateId:candidate.id,name:candidate.name,spec:candidate.spec,unit:candidate.unit,confidence:candidate.confidence,exactSpec:candidate.exactSpec,canAdopt:candidate.canAdopt,requiresReview:!candidate.canAdopt||candidate.record.learnedCase&&!!(candidate.needsConfirmation||candidate.warnings?.length),automaticReady:match.priceStatus==='exact_history'&&candidate.canAdopt&&!candidate.needsConfirmation&&!candidate.warnings?.length,warnings:candidate.warnings||[],differences:[...(candidate.differences||[]),...(candidate.technicalMissing||[])],record:candidate.record});
  }
  offers.push(...(U()?.candidates(q,row)||[]));offers.sort((a,b)=>Number(a.requiresReview)-Number(b.requiresReview)||(b.confidence||0)-(a.confidence||0)||a.id.localeCompare(b.id));
  const key=JSON.stringify([row.name,norm(row.spec),row.brand||'',row.unit,row.scope||row.supplyScope||'',K().effectiveContext(row,q),offers.map(o=>[o.id,o.price])]);
  if(!groups.has(key))groups.set(key,{id:'price:'+hash(key),type:'price',label:row.name+' · '+(row.unit||'单位待核'),spec:row.spec||'',offers,items:[],status:offers.length?'candidate':'inquiry'});
  groups.get(key).items.push({id:row.id,source:row.source});
 }
 return [...groups.values()].map(g=>({...g,id:g.id+':'+hash(g.items.map(i=>i.id).sort().join('|'))}));
}
function dependencies(q,groups,linkedIds,computed=M.calculate(q)){
 const index=new Map();for(const g of groups)for(const item of g.items){const key=item.id+'|'+g.type+(g.kind?':'+g.kind:'');if(!index.has(key))index.set(key,g.id);}
 return computed.rows.filter(r=>r.selected!==false&&!M.isRequirement(r)&&!M.isIncluded(r)).map(row=>{
  const blockers=[],add=(type,label,decisionId=null)=>{if(!blockers.some(b=>b.type===type&&b.label===label))blockers.push({type,label,decisionId});};
  if(M.number(row.quantity)===null)add('quantity','供货数量',index.get(row.id+'|quantity'));
  if(row.unitPrice===null){
   if(row.bom?.role==='tank'){
    const params={...row.geometry,...F.tankParameters(row.spec).params};
    for(const key of ['length','width','height','material','thickness'])if(params[key]==null||params[key]==='')add(key,F.LABELS[key],key==='thickness'?index.get(row.id+'|thickness'):null);
    if(linkedIds.includes(row.id))add('linked','联槽计价口径','linked');
    else if(linked(row)&&!A.linked(row))add('structure','联槽尺寸与节数的关系');
    const explanations=[...(row.parameterConflicts||[]),row.geometry?.dimensionIssue,...(row.pricing?.issues||[]),...(row.priceIssues||[])].filter(Boolean);
    if(!blockers.some(b=>b.type!=='quantity'))add('price',explanations.join('；')||'槽体适用计价依据');
   }else add('price','销售单价',index.get(row.id+'|price'));
   if(row.calculation)for(const message of row.priceIssues||[])add('calculation',message);
  }
  for(const extra of A.adjustments(row).filter(a=>a.choice==='pending'||a.choice==='separate'&&a.price===null))add('scope',extra.label+'含 / 另计待确认',index.get(row.id+'|inclusion:'+extra.kind));
  return {id:row.id,name:row.name,source:row.source,priced:row.amount!==null,blockers};
 });
}
function plan(q){
 const rows=q.rows||[],allTanks=rows.filter(r=>r.selected!==false&&!M.isRequirement(r)&&!M.isIncluded(r)&&r.bom?.role==='tank'),tanks=allTanks.filter(writable);
 const origin=r=>(r.source||'').replace(/\/\s*第\d+行.*$/,'');
 const identities=new Map();
 for(const row of rows)for(const m of row.bom?.stationMembers||[]){const key=origin(row)+'|'+m.stationNumber;if(!identities.has(key))identities.set(key,new Set());identities.get(key).add(row.id);}
 const groups=[];
 const quantities=new Map();
 for(const row of allTanks){
  const members=row.bom?.stationMembers||[];
  if(row.quantity!=null||row.quantityEdited||linked(row)||row.parameterConflicts?.length||row.geometry?.dimensionIssue||!members.length)continue;
  if(!members.every(m=>m.stationNumber&&identities.get(origin(row)+'|'+m.stationNumber)?.size===1)||new Set(members.map(m=>m.stationNumber)).size!==members.length)continue;
  const key=origin(row);if(!quantities.has(key))quantities.set(key,[]);quantities.get(key).push({id:row.id,quantity:members.length,stations:members.map(m=>m.stationNumber),source:row.source});
 }
 for(const [source,items] of quantities)groups.push({id:'quantity:'+source,type:'quantity',label:'按独立工位确认供货数量',source,items});
 const thicknesses=new Map();
 for(const row of tanks){
  const params=F.tankParameters(row.spec).params,material=params.material;
  if(!F.MATERIALS[material]||params.thickness!=null||row.geometry?.thickness!=null||row.parameterConflicts?.length||row.geometry?.dimensionIssue||M.number(row.basePrice)!=null)continue;
  const scope=applicability(q,row),key=material+'|'+scope.key;if(!thicknesses.has(key))thicknesses.set(key,{material,scope,items:[]});thicknesses.get(key).items.push({id:row.id,source:row.source});
 }
 for(const {material,items,scope}of thicknesses.values()){
  const evidence=tanks.filter(r=>F.tankParameters(r.spec).params.material===material&&F.tankParameters(r.spec).params.thickness>0&&applicability(q,r).key===scope.key).map(r=>({value:F.tankParameters(r.spec).params.thickness,source:r.source}));
  const counts=new Map();for(const e of evidence)counts.set(e.value,(counts.get(e.value)||0)+1);
  const suggestion=counts.size===1?[...counts.keys()][0]:null;
  groups.push({id:'thickness:'+material+':'+hash(scope.key),type:'thickness',label:F.MATERIALS[material].label+'主体板厚',scope:scope.label,items,suggestion,evidence});
 }
 const additions=new Map();
 for(const row of tanks)for(const extra of A.adjustments(row).filter(a=>a.choice==='pending'||a.choice==='separate'&&a.price===null)){
  const scope=applicability(q,row),key=JSON.stringify([scope.key,F.tankParameters(row.spec).params.material,extra.kind,extra.spec]);
  if(!additions.has(key))additions.set(key,{id:'inclusion:'+hash(key),type:'inclusion',kind:extra.kind,label:extra.label+'含价范围',scope:scope.label,spec:extra.spec,items:[]});
  additions.get(key).items.push({id:row.id,source:row.source});
 }
 groups.push(...[...additions.values()].map(g=>({...g,id:g.id+':'+hash(g.items.map(i=>i.id).sort().join('|'))})));
 groups.push(...priceGroups(q));
 const linkedIds=tanks.filter(r=>A.linked(r)&&!q.linkedPricing?.confirmed&&!r.linkedPricingPolicy?.confirmed).map(r=>r.id),rowsWithDependencies=dependencies(q,groups,linkedIds);
 const decisions=[...groups,...(linkedIds.length?[{id:'linked',type:'linked',label:'联槽计价口径',items:linkedIds.map(id=>({id}))}]:[])];
 for(const g of decisions){const affected=rowsWithDependencies.filter(r=>g.items.some(i=>i.id===r.id));g.impact={affected:affected.length,ready:affected.filter(r=>!r.priced&&r.blockers.filter(b=>b.type!=='scope').every(b=>b.decisionId===g.id)).length,otherDecisions:[...new Set(affected.flatMap(r=>r.blockers.map(b=>b.decisionId).filter(id=>id&&id!==g.id)))],remaining:[...new Set(affected.flatMap(r=>r.blockers.filter(b=>!b.decisionId).map(b=>b.label)))]};}
 groups.sort((a,b)=>b.impact.ready-a.impact.ready||b.items.length-a.items.length||a.id.localeCompare(b.id));
 return {groups,linked:linkedIds,linkedImpact:decisions.find(g=>g.id==='linked')?.impact,rows:rowsWithDependencies,recovered:q.sourceResolution?.recovered||[],conflicts:q.sourceResolution?.conflicts||[],summary:{decisions:decisions.length,affected:new Set(decisions.flatMap(g=>g.items.map(i=>i.id))).size,inquiryGroups:groups.filter(g=>g.status==='inquiry').length,candidateGroups:groups.filter(g=>g.status==='candidate').length}};
}
function apply(q,choices,{confirmed=false}={}){
 if(!confirmed)throw Error('请确认本项目的整理口径');
 if(!Object.entries(choices).some(([key,value])=>key!=='linkedPrice'&&value!==''&&value!=null))return {quote:q,count:0,decisions:0,affectedIds:[]};
 // Derived search caches can dwarf the quote itself. Preview a business-data
 // copy and revalidate only selected candidates; never copy all caches per key.
 const current=plan(q),draft=structuredClone({...q,engineering:undefined,rows:q.rows.map(({knowledgeEvidence,linkedPriceMatch,...row})=>row)}),byId=new Map(draft.rows.map(r=>[r.id,r])),at=new Date().toISOString(),affectedIds=new Set();let count=0;
 for(const [key,value]of Object.entries(choices))if(/^(?:price|thickness|inclusion):/.test(key)&&value!==''&&value!=null&&!current.groups.some(g=>g.id===key))throw Error('适用范围或价格候选已变化，请重新打开核对窗口');
 for(const group of current.groups){
  const value=choices[group.id];if(value==null||value==='')continue;
  if(group.type==='quantity'&&value!=='stations')throw Error('请选择独立工位供货口径');
  if(group.type==='thickness'&&(!(Number(value)>0)||!Number.isFinite(Number(value))))throw Error('请输入有效主体板厚');
  if(group.type==='price'&&typeof value!=='object')throw Error('请明确选择候选或填写销售单价');
  for(const item of group.items){const row=byId.get(item.id);
   row.repairEvidence=[...(row.repairEvidence||[]),{type:group.type,source:item.source,value:group.type==='quantity'?item.quantity:['price','inclusion'].includes(group.type)?structuredClone(value):Number(value),confirmedAt:at}];
   if(group.type==='quantity'){row.quantity=item.quantity;row.quantityEdited=true;row.bom.quantityBasis='项目确认：每个独立工位供货1个；工位 '+item.stations.join('、');}
   else if(group.type==='thickness'){const old=structuredClone(row.geometry||F.tankParameters(row.spec).params);if(Number(value)>=Math.min(old.length,old.width,old.height)/2)throw Error('主体板厚与槽体尺寸不相符');row.repairEvidence.at(-1).previousSpec=row.spec;M.editGeometry(row,{...old,thickness:Number(value)});}
   else if(group.type==='price'){
    if(value.candidateId){const offer=group.offers.find(o=>o.id===value.candidateId);if(!offer)throw Error('所选价格候选已经变化，请重新核对');if(offer.requiresReview&&value.confirmSimilar!==true)throw Error('请先核对相似特征的差异，再勾选确认采用参考价');if(offer.isMemory){F.edit(row,'basePrice',offer.price);if(offer.priceMode==='fixed_sale'){row.override=offer.price;row.priceKind='confirmed_sale';}row.priceSource=offer.requiresReview?'相似价格记忆 · 本项目确认':'企业价格记忆';row.priceEvidence={ruleId:offer.ruleId,revision:offer.revision,priceMode:offer.priceMode||'base',source:offer.source,confirmedAt:offer.confirmedAt,confirmed:true,confidence:offer.confidence,differences:offer.differences,priceNature:'enterprise_quote'};}else W().adoptPrice(row,{bookId:offer.bookId,bookName:offer.bookName,candidates:[{id:offer.candidateId,record:offer.record}]},{candidateId:offer.candidateId,confirmed:true,confirmSimilar:value.confirmSimilar===true,quote:draft});}
    else{const amount=M.number(value.unitPrice);if(amount===null||amount>1e12)throw Error('请输入有效销售单价');row.priceHistory=[...(row.priceHistory||[]),{basePrice:row.basePrice,override:row.override,priceSource:row.priceSource,at}];F.edit(row,'basePrice',amount);row.priceSource='人工确认销售单价 · 集中核价';row.priceEvidence={priceNature:'enterprise_quote',confirmed:true,confirmedAt:at,source:item.source};}
   }
   else if(group.type==='inclusion'){
    if(!['included','separate'].includes(value?.choice))throw Error('请选择结构费用的含价范围');
    const policy={choice:value.choice};if(value.choice==='separate'){const rate=M.number(value.rate);if(rate===null||rate>1e8)throw Error('请输入有效的结构每平方米加价');policy.rate=rate;}
    row.repairEvidence.at(-1).previousExtraPricing=structuredClone(row.extraPricing||{});row.extraPricing={...(row.extraPricing||{}),[group.kind]:policy};row.basePrice=null;row.pricing={mode:'assembly'};
   }
   count++;affectedIds.add(row.id);
  }
 }
 if(choices.linked){
  if(!current.linked.length)throw Error('当前没有可应用的联槽项目');
  const policy={method:choices.linked};if(choices.linked==='extra')policy.extraPrice=choices.linkedPrice;if(choices.linked==='fixed')policy.fixedPrice=choices.linkedPrice;if(choices.linked==='factor')policy.extraFactor=choices.linkedPrice;
  A.setPolicy(draft,policy);count+=current.linked.length;current.linked.forEach(id=>affectedIds.add(id));
 }
 if(!count)return {quote:q,count:0};
 M.autoPrice(draft);const decisions=Object.keys(choices).filter(k=>k!=='linkedPrice'&&choices[k]!==''&&choices[k]!=null).length,before=M.calculate(q),after=M.calculate(draft);
 draft.repairHistory=[...(draft.repairHistory||[]),{at,choices:structuredClone(choices),count,decisions,affectedIds:[...affectedIds],before:{priced:before.selected-before.missing,total:before.total,missing:before.missing},after:{priced:after.selected-after.missing,total:after.total,missing:after.missing}}];
 return {quote:draft,count,affectedIds:[...affectedIds],decisions};
}
root.QuoteRepair={plan,apply,dependencies,applicability};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteRepair;
})(typeof window!=='undefined'?window:globalThis);
