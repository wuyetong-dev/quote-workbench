(function(root){
'use strict';
const M=typeof module!=='undefined'?require('./model.js'):root.QuoteModel;
const B=typeof module!=='undefined'?require('./business-structure.js'):root.QuoteBusinessStructure;
const I=typeof module!=='undefined'?require('./importer.js'):root.QuoteImporter;
const BOM=typeof module!=='undefined'?require('./process-bom.js'):root.QuoteBOM;
const K=typeof module!=='undefined'?require('./knowledge.js'):root.Knowledge;
const Q=typeof module!=='undefined'?require('./quantity.js'):root.QuoteQuantity;
const R=typeof module!=='undefined'?require('./relations.js'):root.QuoteRelations;
const text=v=>String(v??'').trim(),key=v=>text(v).normalize('NFKC').replace(/\s+/g,'').toLowerCase();
function fragments(q){
 const out=[];
 for(const [si,source]of(q.sources||[]).entries()){
  if(source.pages){for(const page of source.pages)if(text(page.text))out.push({id:'s'+si+':'+page.id,text:page.text,source:page.source,recognition:page.recognition,recognitionStatus:page.recognitionStatus});continue;}
  const rows=source.rows||[],standard=source.standardProcess||I.standardProcess(source),sections=standard?.sections||[];
  for(const [ri,row]of rows.entries()){
   if(!row.some(v=>text(v)))continue;
   const section=sections.find(s=>ri+1>=s.startRow&&ri+1<=s.endRow);
   const content=row.map((v,c)=>text(v)?(section?(section.columns?.[c]?.modelLabel||'原列'+(c+1)):'列'+(c+1))+'：'+text(v):'').filter(Boolean).join('；');
   out.push({id:'s'+si+':r'+(ri+1),text:content,source:source.filename+' / '+source.sheet+' / 第'+(ri+1)+'行',sourceRow:ri+1});
  }
 }
 return out;
}
function modules(q){
 const out=[],seen=new Set();
 for(const row of q.rows||[]){if(M.isRequirement(row))continue;const name=text(row.name),system=text(row.rawGroup||row.group),identity=key(system+'|'+name);if(!name||seen.has(identity))continue;seen.add(identity);out.push({id:'m'+out.length,name,system,spec:text(row.spec).slice(0,450),unit:row.unit||'',source:row.source||''});}
 return out;
}
// Coverage belongs to an original field at a station, never merely to its row.
// A tank, pump and valve may share one source ID and remain different objects.
function topic(value){
 const v=key(value);
 const object=(BOM.CONFIGURATION_FAMILIES||[]).find(f=>!/配置|系统/.test(f.name)&&v.endsWith(key(f.name)));
 if(object)return object.id;
 for(const [id,pattern]of [['air_agitation',/空气搅拌|鼓气|气搅拌/],['overflow',/溢流/],['bottom_valve',/底阀/],['insulation',/保温/],['temperature_control',/温控系统|温控要求|温度控制|温控$/]])if(pattern.test(v))return id;
 if(/侧抽|顶抽|侧吸|顶吸/.test(v))return 'ventilation';
 return BOM?.configurationFamily?.(v)?.id||(/槽体|槽$/.test(v)?'tank':null);
}
function sourceIdsFor(row,sourceMap,ranges=row.bom?.sourceRanges||[],source=row.source){
 const ids=new Set([...(row.decomposition?.sourceIds||[]),...(row.sourceIds||[])].filter(id=>sourceMap.has(id)));
 const location=text(source).replace(/\s*\/\s*第\d+行(?:起)?$/,'');
 for(const [id,f]of sourceMap){
  if(f.source===source){ids.add(id);continue;}
  if(!location||!text(f.source).startsWith(location+' / '))continue;
  const n=Number(f.sourceRow);if(!n)continue;
  if(!ranges.length&&n===Number(row.sourceRow)){ids.add(id);continue;}
  if(ranges.some(range=>{const m=text(range).match(/!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/i);return m&&n>=Number(m[1])&&n<=Number(m[2]||m[1]);}))ids.add(id);
 }
 return [...ids];
}
function coverage(q,sourceMap){
 const out=[],add=(row,family,value,kind,ranges,source)=>{if(!family||!text(value))return;const sourceIds=sourceIdsFor(row,sourceMap,ranges,source);if(sourceIds.length)out.push({row,family,text:text(value),kind,sourceIds});};
 for(const row of q.rows||[]){
  if(row.decomposition)continue;
  const isRequirement=M.isRequirement(row),family=row.bom?.role==='tank'?'tank':topic(row.name)||row.bom?.deviceFamily;
  if(!isRequirement){
   const identifying=(row.bom?.fieldSources||[]).filter(f=>/数量|规格|型号|设备名称/.test(f.label||''));
   const members=row.bom?.stationMembers||[];
   const ranges=members.length?members.map(m=>'_!A'+m.sourceRow):identifying.length?identifying.map(f=>f.range):row.bom?.sourceRanges;
   add(row,family,[row.name,row.rawSpec||row.spec].join('\n'),'device',ranges);
  }
  if(isRequirement){
   // Legacy requirement.deviceFamily can describe its parent (e.g. ultrasonic
   // tank temperature); its own field/name takes priority.
   for(const part of text(row.rawSpec||row.spec).split(/[\n；;]/))add(row,topic(part.split(/[:：]/)[0])||topic(row.name)||row.bom?.deviceFamily,part,'configuration');
  }
  if(isRequirement)for(const field of row.bom?.fieldSources||[])add(row,topic(field.label)||row.bom?.deviceFamily,field.label+'：'+(field.raw??field.value),'configuration',[field.range]);
  for(const config of row.bom?.configurations||[])add(row,config.family,config.family,'configuration',config.sourceRanges);
  for(const fact of row.engineeringRequirements||[]){const content=typeof fact==='string'?fact:fact.text;
   for(const part of text(content).split(/[\n；;]/)){const factFamily=topic(part.replace(/^原表功能要求[:：]/,'').split(/[:：]/)[0]);if(!isRequirement&&factFamily===family)continue;add(row,factFamily,part,'configuration',fact.sourceRanges,fact.source||row.source);}
  }
 }
 return out;
}
function baseline(q,sourceMap=new Map(fragments(q).map(f=>[f.id,f]))){
 const profiles=coverage(q,sourceMap);
 return (q.rows||[]).map(row=>{const owned=profiles.filter(p=>p.row.id===row.id);return {id:row.id,name:row.name,role:M.isRequirement(row)?'requirement':'component',parentId:row.parentId||row.bom?.parentId||null,deviceFamily:row.bom?.role==='tank'?'tank':topic(row.name)||row.bom?.deviceFamily||null,source:row.source,sourceIds:owned.length?[...new Set(owned.flatMap(p=>p.sourceIds))]:sourceIdsFor(row,sourceMap),sourceSpec:text(row.rawSpec||row.spec).slice(0,1200),scope:row.scope||'',quantity:row.quantity,unit:row.unit,configurationFacts:owned.filter(p=>p.kind==='configuration').map(p=>({family:p.family,text:p.text.slice(0,500),sourceIds:p.sourceIds})),confirmed:row.decomposition?.reviewState==='confirmed'||row.bom?.confirmed||false};});
}
function request(q,example){
 Q?.apply(q);
 const fs=fragments(q),knowledge=new Map();let base=baseline(q,new Map(fs.map(f=>[f.id,f])));
 R.local(q,fs,base);base=baseline(q,new Map(fs.map(f=>[f.id,f])));
 const relationTasks=R.tasks(q,fs,base);
 const tasks=fs.map(f=>{const known=base.filter(r=>r.sourceIds.includes(f.id)),devices=known.filter(r=>r.role==='component');
  const hits=K?.search?.(f.text,{limit:2})||[];for(const hit of hits)if(knowledge.size<40)knowledge.set(hit.id,Object.fromEntries(['id','title','summary','conditions','sourceRefs'].map(k=>[k,hit[k]])));
  return {sourceId:f.id,deviceIds:devices.map(r=>r.id),knowledgeIds:hits.map(h=>h.id).filter(id=>knowledge.has(id)),quantityGaps:devices.filter(r=>r.quantity==null).map(r=>({rowId:r.id,name:r.name,unit:r.unit,parentId:r.parentId})),requirementIds:known.filter(r=>r.role==='requirement').map(r=>r.id),task:known.length?'check_uncovered_fields_and_relations':'check_unstructured_source',knownConditions:known.flatMap(r=>r.configurationFacts.map(c=>c.family)).filter((v,i,a)=>a.indexOf(v)===i)};
 });
 return {quoteId:q.id,fragments:fs,relationTasks,sourcePages:(q.sources||[]).flatMap((source,sourceIndex)=>(source.pages||[]).filter(page=>page.image&&page.recognitionStatus!=='transcribed').map(page=>({...page,sourceIndex}))),modules:example?.modules||[],baseline:base,recognitionPlan:{version:'semantic-gaps-2',tasks,pricingPolicy:'已有公式及企业价格先用；缺价格不等于未识别，不猜价格、数量或工程默认值；逐段补查并检查整线遗漏'},knowledgeContext:[...knowledge.values()]};
}
function deviceQualifier(name){
 const n=key(name);for(const [id,pattern]of [['chiller',/冰水机|冷水机/],['exchanger',/换热器|交换器/],['boiler',/锅炉/],['heat_pump',/热泵/],['blower',/鼓风机|空气压缩机|空压机/],['fan',/风机/],['tower',/处理塔|洗涤塔/],['pipe',/管路|管道|连接管/],['instrument',/传感器|温控器|液位计|控制器|控制柜/]])if(pattern.test(n))return id;
 return null;
}
function deviceName(name){return key(name).replace(/^(?:[一二三四五六七八九十\d]+[联连])/,'');}
function objectIdentity(value){
 const v=key(value),terms=K?.getCatalog?.().terms||[];
 const known=terms.flatMap(t=>[t.name,...t.aliases||[]].filter(a=>key(a).length>=2&&v.includes(key(a))).map(a=>({id:t.id,size:key(a).length}))).sort((a,b)=>b.size-a.size)[0];
 if(known)return 'term:'+known.id;
 const named=(BOM.CONFIGURATION_FAMILIES||[]).filter(f=>!/配置|系统/.test(f.name)&&v.includes(key(f.name))).sort((a,b)=>b.name.length-a.name.length)[0];
 return named?'family:'+named.id:null;
}
function coveredAlignment(item,profiles){
 const matches=alignment(item,profiles);if(!matches)return null;
 const identity=objectIdentity(item.name),qualifier=deviceQualifier(item.name),proof=(item.evidence||[]).map(e=>e.quote).join('\n');
 if(!matches.every(m=>{
  const known=objectIdentity(m.row.name+' '+(m.row.rawSpec||m.row.spec||''));
  if(m.kind==='existing_device'||identity&&identity===known)return true;
  // A concrete machine inferred from a functional requirement is an option
  // for that requirement, not a second supplied machine. Explicit new hardware
  // in the source remains independently editable.
  if(m.kind==='design_suggestion')return !!qualifier&&deviceQualifier(proof)!==qualifier;
  return M.isRequirement(m.row)&&!identity&&!known&&!qualifier;
 }))return null;
 return matches.map(m=>({...m,kind:'verified_enrichment',quantityComparable:!M.isRequirement(m.row)&&profiles.filter(p=>p.row.id===m.row.id&&p.kind==='device').every(p=>p.sourceIds.every(id=>item.sourceIds.includes(id)))}));
}
function existingFactAlignment(item,rows,sourceMap){
 if(item.intent!=='requirement'||!item.evidence?.length)return null;
 const matches=new Map();
 for(const e of item.evidence){
  const fields=text(e.quote).split(/[\n；;]/).map(key).filter(Boolean);if(!fields.length)return null;
  for(const field of fields){
   if(field.length<4)return null;
   const row=rows.find(r=>M.isRequirement(r)&&sourceIdsFor(r,sourceMap).includes(e.sourceId)&&key(r.rawSpec||r.spec).includes(field));
   if(!row)return null;
   const old=matches.get(row.id);if(old)old.sourceIds.push(e.sourceId);else matches.set(row.id,{row,family:topic(item.name)||'engineering_condition',sourceIds:[e.sourceId],kind:'verified_enrichment',quantityComparable:false});
  }
 }
 return [...matches.values()].map(m=>({...m,sourceIds:[...new Set(m.sourceIds)]}));
}
function targetedAlignment(item,profiles,rows){
 if(!item.targetExistingId)return null;
 const row=rows.find(r=>r.id===item.targetExistingId);if(!row)return null;
 const family=topic(item.name),owned=profiles.filter(p=>p.row.id===row.id),proof=(item.evidence||[]).map(e=>key(e.quote)).join(' ');
 const local=owned.some(p=>p.sourceIds.some(id=>item.sourceIds.includes(id))),named=proof.includes(key(row.name))&&rows.filter(r=>key(r.name)===key(row.name)).length===1;
 // A model-selected ID alone is insufficient to join separate stations. A
 // global brand note may enrich the one supplied object in that source file.
 const compatible=family&&owned.some(p=>p.family===family),qualifier=deviceQualifier(item.name);
 const unique=family&&new Set(profiles.filter(p=>p.kind==='device'&&p.family===family&&p.sourceIds.some(id=>item.sourceIds.some(s=>s.split(':')[0]===id.split(':')[0]))).map(p=>p.row.id)).size===1;
 const global=compatible&&unique&&/品牌|均采用|全部|整线|统一|所有/.test(proof);
 if(!(local||named||global))return null;
 if(item.intent==='enrich_existing'&&(!compatible&&!named||qualifier&&owned.every(p=>deviceQualifier(p.text)!==qualifier)))return null;
 return [{row,family:family||'engineering',sourceIds:item.sourceIds,kind:'verified_enrichment'}];
}
function alignment(item,profiles){
 const family=topic(item.name);if(!family||!item.sourceIds?.length)return null;
 const result=[],qualifier=deviceQualifier(item.name),tag=key(item.equipmentTag||''),model=text(item.name).match(/[A-Za-z][A-Za-z0-9_-]*型|[A-Za-z]型/);
 for(const sourceId of item.sourceIds){
  let matches=profiles.filter(p=>p.family===family&&p.sourceIds.includes(sourceId));
  let designOnly=false;
  if(!matches.length&&family==='heating'&&!qualifier&&item.quantity==null){
   const quotes=(item.evidence||[]).filter(e=>e.sourceId===sourceId).map(e=>e.quote).join(' ').replace(/(?:槽温\s*\/\s*)?加热设备\s*\/\s*温度[^：:]*[:：]/g,'温度：');
   if(/温度|槽温|温控/.test(quotes)&&!/加热|加温|蒸汽|热水|热泵|锅炉/.test(quotes)){matches=profiles.filter(p=>p.family==='temperature_control'&&p.sourceIds.includes(sourceId));designOnly=true;}
  }
  if(tag)matches=matches.filter(p=>key(p.text).includes(tag));
  if(model)matches=matches.filter(p=>key(p.text).includes(key(model[0])));
  matches=matches.filter(p=>!qualifier||p.kind==='configuration'||deviceQualifier(p.row.name)===qualifier||key(p.row.name)===key(item.name));
  // Multiple same-family supplied devices in one row need a discriminating
  // equipment name/model. A generic label is insufficient to merge either.
  const devices=[...new Map(matches.filter(p=>p.kind==='device').map(p=>[p.row.id,p])).values()];
  if(devices.length>1){const exact=devices.filter(p=>deviceName(p.row.name)===deviceName(item.name));if(exact.length!==1)return null;matches=exact;}
  if(!matches.length)return null;
  const exact=matches.filter(p=>key(p.row.name)===key(item.name));if(exact.length)matches=exact;
  for(const p of matches){
   const record=result.find(v=>v.row.id===p.row.id);if(record){record.sourceIds.push(sourceId);continue;}
   result.push({row:p.row,family,sourceIds:[sourceId],kind:designOnly?'design_suggestion':p.kind==='device'?(deviceName(p.row.name)===deviceName(item.name)?'existing_device':'configuration_interpretation'):qualifier&&!deviceQualifier(p.text)?'design_suggestion':'configuration_interpretation'});
  }
 }
 return result.map(r=>({...r,sourceIds:[...new Set(r.sourceIds)]}));
}
function unchangedPending(row){
 if(row.quantityEdited||row.scopeReview?.confirmedAt)return false;
 const placement=row.decomposition?.savedPlacement;
 if(placement&&JSON.stringify([row.parentId||null,row.bom?.parentId||null,row.bom?.role||null,row.bom?.relatedParentIds||[]])!==JSON.stringify(placement))return false;
 const d=row.decomposition;if(!d||d.reviewState!=='pending'||row.selected!==false||row.basePrice!=null||row.override!=null||row.pricing?.mode&&row.pricing.mode!=='manual')return false;
 if(key(row.name)!==key(d.name)||text(row.unit)!==text(d.unit)||row.quantity!==(d.quantity??null))return false;
 const original=(d.evidence||[]).map(e=>e.quote).join('\n');
 const displayed=B.exportFor({...row,spec:original}).spec;
 return key(row.rawSpec??row.spec)===key(original)&&(key(row.spec)===key(displayed)||key(row.spec)===key(original))&&row.scope==='供货及计价关系待确认'&&!row.bom?.confirmed&&!row.decomposition.confirmedAt;
}
function observation(row,item,match,plan){
 row.aiObservations??=[];
 const identity=item.entityKey||item.id,old=row.aiObservations.find(o=>o.entityKey===identity);
 const value={entityKey:identity,componentId:item.id,name:item.name,family:match.family,mappingKind:match.kind,sourceIds:match.sourceIds,evidence:(item.evidence||[]).filter(e=>match.sourceIds.includes(e.sourceId)),missing:item.missing||[],suggestedQuantity:item.quantity??null,suggestedRelationship:item.proposedRelationship||item.relationship,provider:plan.provider};
 if(match.quantityComparable!==false&&['existing_device','verified_enrichment'].includes(match.kind)&&item.quantity!=null&&row.quantity!=null&&Number(item.quantity)!==Number(row.quantity))value.conflict='AI数量与已有设备数量不同，保留现有数量';
 if(old){old.sourceIds=[...new Set([...old.sourceIds,...value.sourceIds])];old.evidence=[...new Map([...old.evidence,...value.evidence].map(e=>[e.sourceId+'|'+e.quote,e])).values()];old.missing=[...new Set([...old.missing,...value.missing])];}
 else row.aiObservations.push(value);
 if(old){if(value.conflict)old.conflict=value.conflict;else delete old.conflict;}
}
function reviewSignature(g){return JSON.stringify({sourceIds:[...new Set(g.sourceIds||[])].sort(),missing:[...new Set((g.missing||[]).map(key))].sort(),observations:[...new Set((g.observations||[]).map(o=>JSON.stringify([o.rowId,key(o.name),o.mappingKind])))].sort()});}
function candidateIdentity(d){return JSON.stringify([key(d.name),key(d.unit),d.intent,d.targetExistingId||d.parentId||null,d.equipmentTag||'',(d.evidence||[]).map(e=>e.sourceId+'|'+key(e.quote)).sort()]);}
function candidateScope(d){return JSON.stringify([d.targetExistingId||d.parentId||null,[...(d.sourceIds||[])].sort()]);}
function duplicates(q){
 const seen=new Map(),out=[];
 for(const row of q.rows||[]){const d=row.decomposition;if(!d?.entityKey||!unchangedPending(row)||row.quantityEdited||row.scopeReview?.confirmedAt||(q.rows||[]).some(r=>(r.parentId||r.bom?.parentId)===row.id))continue;
  const identity=JSON.stringify([candidateIdentity(d),[...(d.sourceIds||[])].sort(),row.parentId||null]);
  if(seen.has(identity))out.push({rowId:row.id,keepId:seen.get(identity)});else seen.set(identity,row.id);
 }
 return out;
}
function tidyDuplicates(q){
 const draft=structuredClone(q),pairs=duplicates(draft);draft.decomposition??={};draft.decomposition.reconciliationHistory??=[];
 for(const pair of pairs){const row=draft.rows.find(r=>r.id===pair.rowId);draft.decomposition.reconciliationHistory.push({rowId:row.id,mergedInto:[pair.keepId],row:structuredClone(row),reason:'相同结果身份、来源与归属的未编辑重复候选'});draft.rows=draft.rows.filter(r=>r.id!==pair.rowId);}
 return draft;
}
function restoreCandidates(q){
 const draft=structuredClone(q),at=new Date().toISOString();
 for(const entry of draft.decomposition?.reconciliationHistory||[]){
  if(entry.restoredAt||!entry.row||draft.rows.some(r=>r.id===entry.rowId))continue;
  draft.rows.push(structuredClone(entry.row));entry.restoredAt=at;
 }
 B.attach(draft);return draft;
}
function resolveCandidate(row,{mode,source,at=new Date().toISOString()}={}){
 if(!row.decomposition)return false;
 const price=row.override??row.basePrice,quantity=M.number(row.quantity),validPrice=M.number(price);
 if(mode==='separate'&&(quantity==null||validPrice==null)||!['separate','included','requirement'].includes(mode))return false;
 if(mode==='included'&&!(row.parentId||row.bom?.parentId))return false;
 row.decomposition.reviewState='confirmed';row.decomposition.confirmedAt=at;row.decomposition.confirmationSource=source;
 row.decomposition.relationship=mode==='included'?'included':'separate';row.scopeReview={status:mode==='requirement'?'requirement_only':mode==='included'?'included':'confirmed',confirmedAt:at,reason:source};
 row.selected=mode==='separate';return true;
}
function apply(q,plan,example){
 const result=structuredClone(q);
 const relationTasks=R.tasks(result,fragments(result),baseline(result));
 for(const page of plan.recognizedPages||[]){const source=result.sources?.[page.sourceIndex],original=source?.pages?.find(p=>p.id===page.id);if(original){for(const k of ['text','recognition','recognitionStatus','recognitionError'])if(k in page)original[k]=page[k];}}
 const quantityFacts=Q?.totals(result)||[];
 const sourceMap=new Map(fragments(result).map(f=>[f.id,f])),oldByName=new Map(),profiles=coverage(result,sourceMap);
 for(const row of result.rows||[]){const k=key(row.name);if(!oldByName.has(k))oldByName.set(k,[]);oldByName.get(k).push(row);}
 const candidates=[],mapped=new Map(),aliases=new Map(result.rows.flatMap(r=>[[r.id,r.id],...(r.decomposition?.id?[[r.decomposition.id,r.id]]:[])])),seen=new Map(),multipleTargets=new Set(),removed=new Set(),augmented=new Set(),reconciled=[],history=structuredClone(result.decomposition?.reconciliationHistory||[]);
 for(const item of plan.components||[]){
  if(!item.name||!Array.isArray(item.sourceIds)||item.sourceIds.some(id=>!sourceMap.has(id)))throw Error('拆解结果的来源无效，当前报价已保留');
  const previous=result.rows.find(row=>{const d=row.decomposition;if(!d)return false;
   const sameOwner=(d.targetExistingId||d.parentId||null)===(item.targetExistingId||item.parentId||null),overlap=(d.sourceIds||[]).some(id=>item.sourceIds.includes(id));
   const sameIdentity=d.id===item.id||item.entityKey&&d.entityKey===item.entityKey;
   return sameOwner&&(sameIdentity&&(overlap||candidateScope(d)===candidateScope(item))||candidateIdentity(d)===candidateIdentity(item));
  });
  if(previous&&!unchangedPending(previous)){aliases.set(item.id,previous.id);continue;}
  // Only enrichments can be consumed as existing facts. A new physical object
  // must never disappear merely because its parent has a similar requirement.
  let matches=(!previous||unchangedPending(previous))?(item.intent==='enrich_existing'||item.intent==='requirement'&&item.targetExistingId?targetedAlignment(item,profiles,result.rows):item.intent?null:alignment(item,profiles)):null;
  if(!matches&&item.intent==='new_device')matches=coveredAlignment(item,profiles);
  if(!matches&&item.intent==='requirement')matches=existingFactAlignment(item,result.rows,sourceMap)||coveredAlignment(item,profiles);
  if(!matches&&item.intent==='enrich_existing'){
   const fact=quantityFacts.find(f=>key(f.name)===key(item.name)&&key(f.unit)===key(item.unit)&&f.rowIds.length>1&&(item.evidence||[]).some(e=>e.sourceId.startsWith('s'+f.sourceIndex+':')&&sourceMap.get(e.sourceId)?.text.includes(e.quote)&&f.evidence.some(p=>key(p.quote).includes(key(e.quote))||key(e.quote).includes(key(p.quote)))));
   if(fact)matches=fact.rowIds.map(id=>({row:result.rows.find(r=>r.id===id),family:topic(item.name),kind:'verified_enrichment',sourceIds:item.sourceIds,quantityComparable:false}));
  }
  if(matches&&previous&&matches.length>1&&result.rows.some(r=>(r.parentId||r.bom?.parentId)===previous.id))matches=null;
  if(matches){
   if(matches.length===1){const match=matches[0],ownedIds=sourceIdsFor(match.row,sourceMap);Q?.applyAI(result,match.row,item,{...match,sourceIds:match.sourceIds.filter(id=>ownedIds.includes(id))},sourceMap,plan.provider);}
   for(const match of matches){observation(match.row,item,match,plan);augmented.add(match.row.id);}
   const targetIds=[...new Set(matches.map(m=>m.row.id))];
   aliases.set(item.id,targetIds[0]);if(targetIds.length>1)multipleTargets.add(item.id);
   reconciled.push({componentId:item.id,entityKey:item.entityKey||null,name:item.name,rowIds:targetIds,sourceIds:item.sourceIds,reason:'同来源、同设备或配置事实；保留既有数量、价格及供货范围'});
   if(previous){
    removed.add(previous.id);aliases.set(previous.id,targetIds[0]);
    if(!history.some(h=>h.rowId===previous.id&&!h.restoredAt))history.push({rowId:previous.id,componentId:item.id,mergedInto:targetIds,reason:'未人工改动的待确认候选回填已有配置',row:structuredClone(previous)});
   }
   continue;
  }
  // A replay owns its saved identity even when station alignment still fails.
  // Do not replace that row: IDs, user edits and dependent children survive.
  if(previous){observation(previous,item,{family:topic(item.name)||'engineering',kind:'candidate_evidence',sourceIds:item.sourceIds},plan);aliases.set(item.id,previous.id);continue;}
  const exact=item.intent==='enrich_existing'?null:(oldByName.get(key(item.name))||[]).find(row=>{
   if(item.entityKey&&row.decomposition?.entityKey)return item.entityKey===row.decomposition.entityKey&&candidateScope(item)===candidateScope(row.decomposition);
   return item.sourceIds.some(id=>sourceMap.get(id)?.source===row.source||row.decomposition?.sourceIds?.includes(id))||!item.sourceIds.length&&item.moduleId&&row.decomposition?.moduleId===item.moduleId;
  });
  if(exact){aliases.set(item.id,exact.id);continue;}
  const priorFact=item.intent==='requirement'&&topic(item.name)?[...seen.entries()].find(([,r])=>r.decomposition.intent==='requirement'&&topic(r.name)===topic(item.name)&&(item.evidence||[]).every(e=>r.decomposition.evidence.some(p=>p.sourceId===e.sourceId&&key(p.quote).includes(key(e.quote))))):null;
  const signature=priorFact?.[0]||(item.intent==='requirement'&&topic(item.name)?key(['requirement',topic(item.name),(item.evidence||[]).map(e=>e.sourceId+'|'+e.quote).sort().join('|')].join('|')):item.intent?key([item.intent,item.parentId||item.targetExistingId||item.sourceIds.slice().sort().join(','),item.name,item.equipmentTag||'',item.unit].join('|')):item.entityKey||key(item.system+'|'+item.name+'|'+item.unit+'|'+item.sourceIds.slice().sort().join(',')+'|'+(item.evidence||[]).map(e=>e.quote).sort().join('|')));
  if(seen.has(signature)){const prior=seen.get(signature);prior.decomposition.sourceIds=[...new Set([...prior.decomposition.sourceIds,...item.sourceIds])];prior.decomposition.evidence.push(...item.evidence);prior.decomposition.missing=[...new Set([...prior.decomposition.missing,...item.missing||[]])];if(prior.quantity!==item.quantity){prior.quantity=null;prior.decomposition.missing.push('跨来源数量不一致，需确认共享数量');}aliases.set(item.id,prior.id);continue;}
  const reviewPending=!!item.proposedRelationship||item.status==='needs_engineering';
  const row={id:M.uid(),name:item.name,spec:(item.evidence||[]).map(e=>e.quote).join('\n'),brand:'',unit:item.unit||'',quantity:item.quantity??null,basePrice:null,override:null,selected:item.relationship!=='included'&&!reviewPending,kind:'component',pricing:{mode:'manual'},priceSource:'',group:item.system||'待归类设备',decompositionSystem:item.system||'待归类设备',source:item.sourceIds.map(id=>sourceMap.get(id).source).join('；')||'拆解样例：'+(example?.name||''),decomposition:{...structuredClone(item),reviewState:reviewPending?'pending':'source_grounded',provider:plan.provider,exampleId:example?.id||null},scope:reviewPending?'供货及计价关系待确认':item.relationship==='included'?'包含在所属主项内，不另计价':item.relationship==='shared'?'整线共用；服务范围见来源':'独立供货候选'};
  if(item.intent==='requirement'||item.intent==='existing_asset'){
   row.kind='requirement';row.selected=false;row.quantity=null;row.unit='';row.scope=item.intent==='existing_asset'?'原文明确利用已有设备，不新增供货':'工程条件，不作为独立采购设备';
   row.decomposition.parentId=item.parentId||item.targetExistingId||null;
   if(item.intent==='existing_asset'){row.decomposition.reviewState='source_grounded';row.scopeReview={status:'requirement_only',source:'原文已有资产',basis:row.spec};if(!item.missing?.length)row.scopeReview.confirmedAt=new Date().toISOString();}
  }
  if(item.intent&&!row.decomposition.parentId&&!item.targetExistingId&&(topic(item.name)!=='tank'||item.equipmentTag)){
   const owners=[...new Set(profiles.filter(p=>p.kind==='device'&&p.row.bom?.role==='tank'&&p.sourceIds.some(id=>item.sourceIds.includes(id))).map(p=>p.row.id))];
   if(owners.length===1){row.decomposition.parentId=owners[0];row.decomposition.ownerBasis='同一原表工位且唯一主体';}
  }
  if(item.intent==='enrich_existing'){row.decomposition.missing.push('已有设备归属未通过来源核对，保留候选，未改已有设备');row.decomposition.reviewState='pending';row.selected=false;}
  candidates.push(row);mapped.set(item.id,row);aliases.set(item.id,row.id);seen.set(signature,row);
 }
 for(const [id,row]of mapped){const parent=row.decomposition.parentId;if(parent){const parentId=aliases.get(parent);if(!parentId)throw Error('拆解结果的所属部件缺失');if(multipleTargets.has(parent)){row.decomposition.missing.push('所属配置涉及多个工位，具体设备归属待确认');row.decomposition.reviewState='pending';row.selected=false;row.scope='供货及计价关系待确认';}else{row.parentId=parentId;row.bom={role:'component',parentId,quantityBasis:'工艺拆解候选；'+(row.decomposition.missing||[]).join('；')};}}}
 result.rows=result.rows.filter(row=>!removed.has(row.id));
 for(const row of result.rows){if(removed.has(row.parentId))row.parentId=aliases.get(row.parentId);if(removed.has(row.bom?.parentId))row.bom.parentId=aliases.get(row.bom.parentId);}
 result.rows.push(...candidates);
 const familyNames={air_agitation:'空气搅拌',overflow:'溢流',bottom_valve:'底阀',insulation:'保温',temperature_control:'温控',cooling:'冷却换热',heating:'加热',ventilation:'排风',spray:'喷淋',filter:'过滤',rectifier:'整流',ultrasonic:'超声波'};
 const groups=new Map();
 for(const row of result.rows)for(const o of row.aiObservations||[]){if(!o.conflict&&['existing_device','verified_enrichment'].includes(o.mappingKind))continue;const k=o.family;if(!groups.has(k))groups.set(k,{id:'configuration:'+k,family:k,title:(familyNames[k]||'设备')+'配置核对',status:'pending',rowIds:[],sourceIds:[],missing:[],observations:[]});const g=groups.get(k);g.rowIds.push(row.id);g.sourceIds.push(...o.sourceIds);g.missing.push(...o.missing,...(o.conflict?[o.conflict]:[]));g.observations.push({rowId:row.id,componentId:o.componentId,name:o.name,mappingKind:o.mappingKind});}
 const priorGroups=new Map((result.decomposition?.reviewGroups||[]).map(g=>[g.id,g]));
 const reviewGroups=[...groups.values()].map(g=>{const next={...g,rowIds:[...new Set(g.rowIds)],sourceIds:[...new Set(g.sourceIds)],missing:[...new Set(g.missing)],observations:[...new Map(g.observations.map(o=>[JSON.stringify([o.rowId,key(o.name),o.mappingKind]),o])).values()]},old=priorGroups.get(g.id);if(old?.status==='confirmed'&&reviewSignature(old)===reviewSignature(next)){next.status=old.status;for(const k of ['confirmedAt','reason','reviewedBy'])if(k in old)next[k]=old[k];}return next;});
 const names=[...new Set(result.rows.map(row=>row.decompositionSystem||row.group||'其他设备'))];
 const chapterNames=['一','二','三','四','五','六','七','八','九','十'];
 result.decomposition={version:plan.version,provider:plan.provider,status:plan.status||'completed',jobId:plan.jobId||null,batchStates:plan.batchStates||[],completedBatches:plan.completedBatches,failedBatches:plan.failedBatches,error:plan.error||'',rejectedComponents:plan.rejectedComponents||[],createdAt:new Date().toISOString(),example:example?{id:example.id,name:example.name}:null,addedRowIds:candidates.map(r=>r.id),augmentedRowIds:[...augmented],reconciledCandidates:reconciled,reconciliationHistory:history,reviewGroups,unresolvedSourceIds:plan.unresolvedSourceIds||[],sourceCount:plan.sourceCount,chapters:names.map((name,i)=>({chapterNo:i+1,chapterTitle:(chapterNames[i]||String(i+1))+'、'+name.replace(/^[一二三四五六七八九十\d]+[、.．]\s*/,''),key:name}))};
 for(const row of result.rows)row.decompositionSystem??=row.group||'其他设备';
 B.attach(result);R.apply(result,plan.relationDecisions,fragments(result),plan.relationTasks||relationTasks);
 for(const row of candidates)row.decomposition.savedPlacement=[row.parentId||null,row.bom?.parentId||null,row.bom?.role||null,row.bom?.relatedParentIds||[]];
 return result;
}
root.QuoteDecomposition={fragments,modules,request,apply,baseline,coverage,resolveCandidate,duplicates,tidyDuplicates,restoreCandidates};if(typeof module!=='undefined')module.exports=root.QuoteDecomposition;
})(typeof window!=='undefined'?window:globalThis);
