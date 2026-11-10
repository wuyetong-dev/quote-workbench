(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports,Q=node?require('./quantity.js'):root.QuoteQuantity,A=node?require('./assembly-pricing.js'):root.QuoteAssemblyPricing,S=node?require('./source-facts.js'):root.QuoteSourceFacts,F=node?require('./formulas.js'):root.QuoteFormulas;
const norm=v=>String(v??'').normalize('NFKC').replace(/\s/g,''),valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0,hash=v=>{let h=2166136261;for(const c of v)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(36);};
const parent=(q,r)=>q.rows.find(p=>p.id===(r.parentId||r.bom?.parentId));
function basis(q,ids){return JSON.stringify(ids.map(id=>{const r=q.rows.find(r=>r.id===id);return r?[r.id,r.name,r.unit,r.parentId||r.bom?.parentId,r.rawSpec||r.spec,['length','width','height','material','thickness'].map(k=>r.geometry?.[k]),r.quantity,r.quantityEdited||false,r.override,r.pricing?.mode==='manual'?r.basePrice:null,r.scopeReview]:null;}).concat([q.linkedPricing||null]));}
function tasks(q,fragments=[],baseline=[]){
 Q.totals(q);const out=[],byId=new Map(baseline.map(r=>[r.id,r]));
 const sources=ids=>[...new Set(ids.flatMap(id=>byId.get(id)?.sourceIds||[]))];
 const target=id=>{const r=q.rows.find(r=>r.id===id),p=parent(q,r);return {rowId:id,name:r.name,owner:p?.name||r.name,quantity:r.quantity,unit:r.unit,sourceIds:byId.get(id)?.sourceIds||[],geometry:r.geometry?Object.fromEntries(['length','width','height','material','thickness'].map(k=>[k,r.geometry[k]])):undefined};};
 for(const f of q.quantityFacts.filter(f=>f.rowIds.length>1&&f.status!=='allocated')){
  const evidence=f.evidence.map(e=>({...e,sourceId:fragments.find(s=>s.id.startsWith('s'+f.sourceIndex+':')&&norm(s.text).includes(norm(e.quote)))?.id}));
  out.push({id:'allocation-'+hash(f.id),type:'allocation',name:f.name,total:f.value,unit:f.unit,targets:f.rowIds.map(target),sourceIds:[...new Set([...sources(f.rowIds),...evidence.map(e=>e.sourceId).filter(Boolean)])],evidence,basis:basis(q,f.rowIds),factId:f.id});
 }
 for(const g of A.interpretationGroups(q))out.push({id:'assembly-'+hash(g.id),type:'assembly',name:g.name,chambers:g.chambers,geometry:Object.fromEntries(['length','width','height','material','thickness'].map(k=>[k,g.geometry[k]])),targets:g.rows.map(target),sourceIds:sources(g.rows),basis:basis(q,g.rows),group:g,pricingPolicy:q.linkedPricing?.confirmed?q.linkedPricing:null});
 return out;
}
function dimensionEvidence(q,row){
 const ctx=S.context(q,row);if(!ctx?.station||row.parameterConflicts?.length||row.geometry?.dimensionIssue)return null;
 const fields=ctx.station.fields.filter(f=>!f.blocked&&f.scope?.role==='main'),g={...row.geometry,...F.tankParameters(row.spec).params};
 const dimensions=['length','width','height'].map(k=>fields.find(f=>f.field===k&&/内/.test(f.label)&&Number(S.cell(ctx.source,f.range))>0&&Number(f.normalized)===g[k]));
 const count=fields.find(f=>f.field==='chambers'&&Number(S.cell(ctx.source,f.range))===Number(row.bom?.chamberCount)&&Number(f.normalized)>1);
 const volume=fields.find(f=>/容积\s*\/\s*(?:L|升)$/i.test(f.label)&&Number(S.cell(ctx.source,f.range))>0);
 if(!count||dimensions.some(f=>!f)||!volume)return null;
 const litres=g.length*g.width*g.height/1e6,original=Number(S.cell(ctx.source,volume.range));
 if(Math.abs(litres-original)>Math.max(1e-6,litres*1e-6))return null;
 // This row's typed internal dimensions and capacity agree. A neighbouring
 // tank of half its width is not evidence that this row gives a total width.
 const notes=[...fields.map(f=>String(f.raw||'')),...S.notes(ctx.source).filter(e=>/本表|本页|所有|统一/.test(e.quote)).map(e=>e.quote)].join('；');
 if(/整组(?:总)?[长宽高尺寸]|总[长宽高]\s*[:：=]?\s*\d/.test(notes))return null;
 return {dimensions:'section',label:'原表单工位内尺寸 · 容积相符',ranges:[count,...dimensions,volume].map(f=>f.range)};
}
function proposals(q,t){
 if(t.type==='allocation')return t.total===t.targets.length&&t.targets.every(r=>r.quantity==null)?[{label:t.targets.length+'处各1'+t.unit,allocations:t.targets.map(r=>({rowId:r.rowId,quantity:1}))}]:[];
 const known=[...new Set(t.targets.map(r=>r.quantity).filter(n=>n!=null))];if(known.length>1||t.targets.some(x=>{const r=q.rows.find(r=>r.id===x.rowId);return r.quantityEdited&&r.quantity==null;}))return [];const quantity=known[0]??1;
 const first=q.rows.find(r=>r.id===t.targets[0].rowId),ctx=S.context(q,first),g=t.geometry,independent=q.rows.filter(r=>ctx?.source&&r.bom?.role==='tank'&&!A.linked(r)&&!/[二两三四五六七八九十\d]+[联连]/.test(r.name)&&S.context(q,r)?.source===ctx.source);
 const owned=t.targets.map(x=>dimensionEvidence(q,q.rows.find(r=>r.id===x.rowId)));
 if(owned.every(e=>e?.dimensions==='section'))return [{label:'按原表单工位尺寸 · 每处'+quantity+'组',dimensions:'section',quantity,method:t.pricingPolicy?'existing':'stations'}];
 const confirmed=t.targets.map(x=>{const r=q.rows.find(r=>r.id===x.rowId);return A.body(r).issues.some(s=>s.includes('重新核对联槽'))?null:r.assemblyResolution?.dimensions;});if(confirmed.every(x=>x&&x===confirmed[0]))return [{label:'每处'+quantity+'组 · 沿用已核尺寸',dimensions:confirmed[0],quantity,method:t.pricingPolicy?'existing':'stations'}];
 const choices=[];
 for(const dimensions of ['total_length','total_width','section']){
  const predicted={...g};if(dimensions!=='section')predicted[dimensions.slice(6)]/=t.chambers;
  if(!independent.some(r=>['length','width','height','material','thickness'].every(k=>r.geometry?.[k]===predicted[k])))continue;
  choices.push({label:(dimensions==='section'?'按单节尺寸':dimensions==='total_length'?'总长分'+t.chambers+'节':'总宽分'+t.chambers+'节')+' · 每处'+quantity+'组',dimensions,quantity,method:t.pricingPolicy?'existing':'stations'});
 }
 return choices;
}
function evidenceValid(t,items,fragments){const byId=new Map(fragments.map(f=>[f.id,f]));return Array.isArray(items)&&items.length>0&&items.every(e=>t.sourceIds.includes(e.sourceId)&&norm(e.quote)&&norm(byId.get(e.sourceId)?.text).includes(norm(e.quote)));}
function assess(q,t,d,fragments){
 if(d.taskId!==t.id||d.taskBasis!==t.basis||!evidenceValid(t,d.evidence,fragments))return {ok:false,reason:'依据已变，请重新整理'};
 if(t.type==='allocation'){
  const allocations=d.allocations||[];if(allocations.length!==t.targets.length||new Set(allocations.map(a=>a.rowId)).size!==allocations.length||allocations.some(a=>!t.targets.some(r=>r.rowId===a.rowId)||!valid(a.quantity))||allocations.reduce((s,a)=>s+a.quantity,0)!==t.total)return {ok:false,reason:'分配合计不符'};
  const grounded=allocations.every(a=>{const r=q.rows.find(r=>r.id===a.rowId),owner=parent(q,r)?.name;
   const namedOwner=owner&&t.targets.filter(x=>x.owner===owner).length===1&&d.evidence.some(e=>e.quote.split(/[；;。\n]/).some(clause=>{const at=clause.indexOf(owner);return at>=0&&!t.targets.some(x=>x.owner!==owner&&clause.includes(x.owner))&&Q.named(clause.slice(at+owner.length),r)===a.quantity;}));
   return !r.quantityEdited&&(r.quantity==null||r.quantity===a.quantity)&&(Q.collect(q,r).some(f=>f.value===a.quantity)||namedOwner)||r.quantity===a.quantity;});
  return {ok:true,automatic:grounded};
 }
 if(!['section','total_length','total_width','total_height'].includes(d.dimensions))return {ok:false,reason:'尺寸含义未定'};
 const owned=t.targets.map(target=>dimensionEvidence(q,q.rows.find(r=>r.id===target.rowId)));
 if(owned.every(e=>e?.dimensions==='section'))return d.dimensions==='section'?{ok:true,automatic:true}:{ok:false,reason:'与原表单工位内尺寸及容积矛盾'};
 // A model's confidence is not evidence. Cross-row dimensional similarity is
 // a proposal; only explicit wording in the owned original can auto-resolve.
 const labels={total_length:'总长',total_width:'总宽',total_height:'总高'},axis=d.dimensions.slice(6);
 const explicit=target=>d.evidence.some(e=>{if(!target.sourceIds.includes(e.sourceId)||/待定|待确认|可能|建议|暂按|不确定/.test(e.quote))return false;
  return e.quote.split(/[；;\n]/).some(clause=>{if(!clause.includes(target.name))return false;
   if(d.dimensions==='section'){const p=F.tankParameters(clause).params;return /单节(?:尺寸|内径)|每节(?:尺寸|内径)/.test(clause)&&['length','width','height'].every(k=>p[k]===t.geometry[k]);}
   const m=clause.match(new RegExp(labels[d.dimensions]+'\\s*[:：=]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:mm|毫米)(?![a-z])','i'));return m&&Number(m[1])===t.geometry[axis];});});
 return {ok:true,automatic:t.targets.every(explicit)};
}
function geometry(q,t,d,provider){
 for(const target of t.targets){const r=q.rows.find(r=>r.id===target.rowId);if(r.quantityEdited||r.override!=null||r.scopeReview?.confirmedAt)continue;
  if(r.assemblyResolution?.dimensions===d.dimensions&&A.body(r).issues.length===0)continue;
  const original=structuredClone({...r.geometry,...F.tankParameters(r.spec).params}),g={...original};if(d.dimensions!=='section')g[d.dimensions.slice(6)]/=t.chambers;
  r.assemblyResolution={dimensions:d.dimensions,chambers:t.chambers,originalGeometry:original,identityBasis:F.basis({...r,spec:''}),source:'原文明确尺寸口径',provider,evidence:d.evidence,at:new Date().toISOString()};r.bom={...r.bom,chamberCount:t.chambers,memberGeometry:Array.from({length:t.chambers},()=>structuredClone(g))};r.geometry={...original,chambers:t.chambers};r.basePrice=null;r.pricing={mode:'assembly'};
 }
 A.apply(q);
}
function apply(q,decisions,fragments,requestTasks,provider='AI'){
 const states=q.relationReview||[];
 for(const d of decisions||[]){const t=(requestTasks||[]).find(t=>t.id===d.taskId);if(!t||basis(q,t.targets.map(r=>r.rowId))!==t.basis)continue;
  const signature=x=>JSON.stringify([x.dimensions,(x.allocations||[]).map(a=>[a.rowId,a.quantity]).sort()]);
  if((decisions||[]).some(other=>other.taskId===d.taskId&&signature(other)!==signature(d)))continue;
  const check=assess(q,t,d,fragments);if(!check.ok)continue;
  let status='proposal';
  if(check.automatic){if(t.type==='assembly')geometry(q,t,d,provider);else for(const a of d.allocations){const r=q.rows.find(r=>r.id===a.rowId);if(r.quantity==null&&!r.quantityEdited){r.quantity=a.quantity;r.quantityResolution={kind:'source',provider,value:a.quantity,evidence:d.evidence};}}status='applied';}
  const entry={taskId:t.id,taskBasis:t.basis,type:t.type,status,decision:structuredClone(d),evidence:d.evidence,reason:String(d.reason||'').slice(0,200)};
  const old=states.findIndex(r=>r.taskId===t.id);if(old>=0)states[old]=entry;else states.push(entry);
 }
 q.relationReview=states;Q.totals(q);return q;
}
function local(q,fragments,baseline){
 const requested=tasks(q,fragments,baseline),decisions=[];
 for(const t of requested)if(t.type==='assembly')for(const dimensions of ['section','total_length','total_width','total_height']){
  const d={taskId:t.id,taskBasis:t.basis,dimensions,evidence:fragments.filter(f=>t.sourceIds.includes(f.id)).map(f=>({sourceId:f.id,quote:f.text}))};
  if(assess(q,t,d,fragments).automatic)decisions.push(d);
 }
 return apply(q,decisions,fragments,requested,'local');
}
function choose(q,t,choice,source='本单确认'){
 const draft=structuredClone(q);if(basis(draft,t.targets.map(r=>r.rowId))!==t.basis)throw Error('内容已更新，请重新打开');
 if(t.type==='assembly'&&choice.dimensions!=='section'&&t.targets.every(target=>dimensionEvidence(q,q.rows.find(r=>r.id===target.rowId))?.dimensions==='section'))throw Error('原表内尺寸与容积对应单工位，不能按整组尺寸相除；请先核对并修正规格');
 if(t.type==='allocation'){
  const a=choice.allocations;if(!Array.isArray(a)||a.length!==t.targets.length||new Set(a.map(x=>x.rowId)).size!==a.length||a.some(x=>!t.targets.some(t=>t.rowId===x.rowId)||!valid(x.quantity))||a.reduce((s,x)=>s+x.quantity,0)!==t.total)throw Error('数量合计须为'+t.total+t.unit);
  for(const item of a){const r=draft.rows.find(r=>r.id===item.rowId);if(r.quantityEdited&&r.quantity!==item.quantity)throw Error('已有人工数量，请逐项核对');r.quantity=item.quantity;r.quantityEdited=true;r.quantityResolution={kind:'allocation',value:item.quantity,evidence:t.evidence,source};}
 }else A.resolveInterpretation(draft,t.group,{...choice,confirmed:true},source+(choice.method==='existing'?'；沿用本单计价口径':'；按各节主体计价'));
 draft.relationReview=(draft.relationReview||[]).filter(r=>r.taskId!==t.id);Q.totals(draft);return draft;
}
root.QuoteRelations={tasks,basis,proposals,assess,apply,choose,local,dimensionEvidence};if(node)module.exports=root.QuoteRelations;
})(typeof window!=='undefined'?window:globalThis);
