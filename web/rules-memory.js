(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports;
const M=node?require('./model.js'):root.QuoteModel,F=node?require('./formulas.js'):root.QuoteFormulas,K=node?require('./knowledge.js'):root.Knowledge;
const PF=node?require('./price-features.js'):root.QuotePriceFeatures;
const A=node?require('./assembly-pricing.js'):root.QuoteAssemblyPricing;
const norm=v=>String(v??'').normalize('NFKC').toUpperCase().replace(/\s+/g,'').replace(/×/g,'*');
let rules=[],available=false;
const material=row=>row.geometry?.material||F.tankParameters(row.spec).params.material||K.describeRow(row).parameters.material;
function features(q,row){const context=[q.currency||'',q.taxMode||'',q.taxRate??'',q.enterpriseId||'',q.pricingDefaults?.scopeDefault||''];if(row.priceContext||['currency','taxMode','taxRate','enterpriseId'].some(k=>row[k]!=null)||q.pricingDefaults?.enterpriseId)context.push(K.effectiveContext(row,q));return K.priceFeatures(row,JSON.stringify(context));}
function rememberedFeatures(rule){const f=rule.match.features;return f.featureVersion===2?f:K.priceFeatures({...f,material:f.material},f.context);}
function candidates(q,row,list=rules){const f=features(q,row);return list.filter(r=>r.enabled&&r.kind==='price').map(rule=>{const match=PF.compare(f,rememberedFeatures(rule));return {id:'memory:'+rule.id,isMemory:true,ruleId:rule.id,revision:rule.revision,price:rule.value.unitPrice,priceMode:rule.value.priceMode||'base',source:rule.value.source,confirmedAt:rule.value.confirmedAt,name:rule.match.features.sourceName||rule.match.features.name,spec:rule.match.features.spec,unit:rule.match.features.unit,bookName:'企业价格记忆',confidence:match.score,canAdopt:match.exact,canRecommend:match.tier==='similar',requiresReview:!match.exact,differences:[...match.differences,...match.hardConflicts],warnings:[],rule};}).filter(c=>c.canAdopt||c.canRecommend).sort((a,b)=>b.confidence-a.confidence||a.id.localeCompare(b.id));}
function priceRule(q,row,unitPrice,options={}){const f=features(q,row);if(!f.name||!f.spec||!f.unit||!f.material||f.material==='SUS'||f.issues.length||f.missing.length)throw Error('此组缺少明确材质、规格或单位，或参数冲突，暂不能保存自动价格规则');return {kind:'price',match:{signature:JSON.stringify(f),features:f},value:{unitPrice:Number(unitPrice),...(options.priceMode==='fixed_sale'?{priceMode:'fixed_sale',source:String(options.source||'人工确认'),confirmedAt:new Date().toISOString()}: {})},enabled:true};}
function defaultRule(q,g,value){const row=q.rows.find(r=>r.id===g.items[0].id),m=material(row);if(g.type!=='thickness'||!F.MATERIALS[m])throw Error('仅明确材质的缺板厚分组可保存此默认规则');return {kind:'default',match:{material:m},value:{thickness:Number(value)},enabled:true};}
function linkedRules(q,policy){if(!['factor','extra','stations'].includes(policy.method))throw Error('仅递增系数、每增节加价或各单槽价合计可设为企业联槽默认');const materials=[...new Set(q.rows.filter(r=>A.linked(r)&&r.selected!==false).map(material))];if(!materials.length||materials.some(m=>!F.MATERIALS[m]))throw Error('须先明确所有联槽的主体材质');return materials.map(m=>({kind:'default',match:{material:m},value:{linkedPolicy:{method:policy.method,...(policy.method==='factor'?{extraFactor:Number(policy.extraFactor)}:policy.method==='extra'?{extraPrice:Number(policy.extraPrice)}:{})}},enabled:true}));}
function sameValue(values){return values.length>0&&values.every(v=>JSON.stringify(v)===JSON.stringify(values[0]));}
function defaultMatches(rule,row){return Object.entries(rule.match).every(([key,value])=>norm(key==='material'?material(row):key==='operation'?row.bom?.operation:row.name)===norm(value));}
function note(q,row,rule,field,value){
 row.ruleApplications=[...(row.ruleApplications||[]),{ruleId:rule.id,revision:rule.revision,field,value,at:new Date().toISOString()}];
 const text=rule.kind==='price'?'已按价格记忆计价':'已按默认规则补齐';
 const detail=field==='linkedPolicy'?'联槽 '+A.METHODS[value.method]+(value.method==='factor'?' '+value.extraFactor:value.method==='extra'?' ¥'+value.extraPrice:''):(field==='unitPrice'?'单价 ¥':field==='thickness'?'板厚 ':'材质 ')+value+(field==='thickness'?'mm':'');
 const line=row.name+'：'+text+'（'+detail+'）';
 if(!(q.notes||'').split('\n').includes(line))q.notes=[q.notes,line].filter(Boolean).join('\n');
}
function apply(q,list=rules,ids=null){
 let count=0;const conflicts=[];const allowed=ids?new Set(ids):null;
 for(const row of q.rows){
  if(allowed&&!allowed.has(row.id)||M.isRequirement(row)||M.isIncluded(row)||row.selected===false)continue;
  if(row.parameterConflicts?.length||row.geometry?.dimensionIssue||F.tankParameters(row.spec).issues.length)continue;
  const tank=row.bom?.role==='tank'||F.candidate(row)==='tank';
  for(const field of ['material','thickness','linkedPolicy']){
   if(!tank||M.number(row.basePrice)!==null||row.override!=null||row.pricing?.mode==='manual')continue;
   const p={...F.resolve(row)?.params,...F.tankParameters(row.spec).params,...row.geometry};
   if(field==='linkedPolicy'&&(!A.linked(row)||q.linkedPricing?.confirmed||row.linkedPricingPolicy?.confirmed))continue;
   if(p[field]!=null&&p[field]!=='')continue;
   const candidates=list.filter(r=>r.enabled&&r.kind==='default'&&field in r.value&&defaultMatches(r,row));
   if(!candidates.length)continue;
   if(!sameValue(candidates.map(r=>r.value[field]))){conflicts.push({rowId:row.id,field,message:'企业默认规则冲突，请在报价字典核对'});continue;}
   const rule=candidates[0],value=rule.value[field];
   if(field==='linkedPolicy'){row.linkedPricingPolicy={...structuredClone(value),material:material(row),version:A.VERSION,confirmed:true,ruleId:rule.id,revision:rule.revision};note(q,row,rule,field,value);count++;continue;}
   if(field==='thickness'&&value>=Math.min(p.length||Infinity,p.width||Infinity,p.height||Infinity)/2){conflicts.push({rowId:row.id,field,message:'默认板厚与槽体尺寸不符'});continue;}
   // Preserve the original source description; append an explicit enterprise decision.
   F.edit(row,'spec',[row.spec,field==='material'?'材质 '+value:'主体板厚 '+value+'mm'].filter(Boolean).join('\n'));
   row.geometry={...row.geometry,[field]:value};note(q,row,rule,field,value);count++;
  }
  if(M.number(row.basePrice)!==null||row.override!=null||row.pricing?.mode==='manual')continue;
  const exact=candidates(q,row,list).filter(c=>c.canAdopt);
  if(!exact.length)continue;
  if(!sameValue(exact.map(c=>c.price))){conflicts.push({rowId:row.id,field:'unitPrice',message:'价格记忆存在不同单价，请在报价字典核对'});continue;}
  const r=exact[0].rule;F.edit(row,'basePrice',r.value.unitPrice);if(r.value.priceMode==='fixed_sale'){row.override=r.value.unitPrice;row.priceKind='confirmed_sale';}row.priceSource='企业价格记忆';row.priceEvidence={priceNature:'enterprise_quote',ruleId:r.id,revision:r.revision,confirmed:true,confidence:100,source:r.value.source,confirmedAt:r.value.confirmedAt,priceMode:r.value.priceMode||'base'};note(q,row,r,'unitPrice',r.value.unitPrice);count++;
 }
 q.rulesMemoryConflicts=[...(q.rulesMemoryConflicts||[]).filter(c=>allowed&&!allowed.has(c.rowId)),...conflicts];
 if(count)M.autoPrice(q);return {quote:q,count,conflicts};
}
async function load(){try{rules=await api('rules-memory');available=true;return rules;}catch(e){rules=[];available=false;throw e;}}
async function save(batch){rules=await api('rules-memory',{rules:batch});available=true;return rules;}
function unresolvedConflicts(q){return (q.rulesMemoryConflicts||[]).filter(c=>{const row=q.rows.find(r=>r.id===c.rowId);if(!row)return false;if(c.field==='unitPrice')return M.number(row.basePrice)===null&&row.override==null;const p={...F.resolve(row)?.params,...F.tankParameters(row.spec).params,...row.geometry};return p[c.field]==null||p[c.field]==='';});}
function recommendation(q,plan){
 const choices={},conflicts=[],memoryConflicts=new Set(unresolvedConflicts(q).map(c=>c.rowId));let groups=0;
 for(const g of plan.groups){
  if(g.items.some(i=>memoryConflicts.has(i.id))){conflicts.push(g.id);continue;}
  if(g.type==='price'&&g.offers.length){
   const safe=g.offers.filter(o=>!o.requiresReview),prices=new Set(safe.map(o=>o.price));
   if(prices.size===1){choices[g.id]={candidateId:safe[0].id};groups++;}else if(prices.size>1)conflicts.push(g.id);
  }else if(g.type==='quantity'){choices[g.id]='stations';groups++;}
  else if(g.type==='thickness'&&g.suggestion>0){choices[g.id]=g.suggestion;groups++;}
 }
 return {choices,groups,conflicts};
}
root.QuoteRulesMemory={features,candidates,priceRule,defaultRule,linkedRules,apply,load,save,recommendation,unresolvedConflicts,get rules(){return rules;},get available(){return available;}};
if(node)module.exports=root.QuoteRulesMemory;
})(typeof window!=='undefined'?window:globalThis);
