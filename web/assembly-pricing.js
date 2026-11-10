(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const VERSION='2026-11-05.assembly.1',number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const METHODS={extra:'每增一节固定加价',factor:'每增一节按单槽价系数加价',fixed:'按整组固定价',stations:'按单槽价 × 节数'};
const dependencyBasis=row=>JSON.stringify([row.geometry||null,row.bom?.memberGeometry||null,...(row.assemblyResolution?[row.assemblyResolution]:[]),row.extraPricing||null,...(row.linkedPricingPolicy?[row.linkedPricingPolicy]:[])]);
function linked(row){return Math.max(Number(row.bom?.chamberCount)||1,Number(row.geometry?.chambers)||1)>1;}
function layers(row){return F.tankParameters(row.spec).layers.filter(l=>l.role!=='body');}
function insulated(row){return layers(row).some(l=>['insulation','outer_shell','coating'].includes(l.role))||/保温|岩棉|外封|外包/.test(row.spec||'');}
function key(row){return JSON.stringify([String(row.name||'').replace(/^(?:[一二两三四五六七八九十]+|\d+)[联连]/,''),Number(row.bom?.chamberCount||row.geometry?.chambers||1),...['length','width','height','thickness','material'].map(k=>row.geometry?.[k]??F.tankParameters(row.spec).params[k]??'')]);}
function body(row){
 const parsed=F.tankParameters(row.spec),chambers=Math.max(Number(row.bom?.chamberCount)||1,Number(row.geometry?.chambers)||1),members=row.bom?.memberGeometry;
 if(row.assemblyResolution&&(row.assemblyResolution.identityBasis&&row.assemblyResolution.identityBasis!==F.basis({...row,spec:''})||row.assemblyResolution.chambers!==chambers||['length','width','height','material','thickness'].some(k=>{const original=row.assemblyResolution.originalGeometry[k];return original!=null&&(row.geometry?.[k]!=null&&row.geometry[k]!==original||parsed.params[k]!=null&&parsed.params[k]!==original); })))return {price:null,issues:['尺寸或材质已改变，需重新核对联槽尺寸解释'],stations:[],chambers};
 if(/油水分离|水浴.*(?:内槽|内胆)|加热内槽|夹套|内衬|钢衬|双层|内外槽|圆形|圆筒|槽盖|封闭结构|异形/.test(row.spec||''))return {price:null,issues:['主体并非标准开口矩形槽，需对应主体计价依据'],stations:[],chambers};
 const conflicts=[...(row.parameterConflicts||[]),row.geometry?.dimensionIssue].filter(Boolean);
 if(conflicts.length)return {price:null,issues:[...new Set(conflicts)],stations:[],chambers};
 const geometry=members?.length?members:Array.from({length:chambers},()=>row.geometry||parsed.params),stations=[];
 for(const g of geometry){
  if(g.dimensionIssue)return {price:null,issues:[g.dimensionIssue],stations:[],chambers};
  const material=F.parameters('材质 '+(g.material||''),{scope:'tank'}).params.material;
  const params={...parsed.params,...Object.fromEntries(['length','width','height','thickness'].filter(k=>g[k]!==undefined).map(k=>[k,g[k]])),...(material?{material}:{})};
  const result=F.evaluate('tank',params);stations.push({params,price:result.price,issues:result.issues,missing:result.missing,steps:result.steps});
 }
 if(stations.length!==chambers)return {price:null,issues:['工位尺寸条数与联数不一致，需核对'],stations,chambers};
 const invalid=stations.find(s=>s.price===null);
 return {price:invalid?null:round(stations.reduce((a,s)=>a+s.price,0)),issues:invalid?[...invalid.issues,...invalid.missing.map(k=>'缺 '+F.LABELS[k])]:[],stations,chambers};
}
function adjustments(row){
 const details=layers(row).filter(l=>['insulation','outer_shell','coating'].includes(l.role));
 if(!details.length&&/保温/.test(row.spec||''))details.push({role:'insulation',text:'保温配置',parameters:{}});
 const names={insulation:'保温',outer_shell:'外包 / 外封',coating:'涂层加工'};
 const g=row.geometry||F.tankParameters(row.spec).params;
 const area=['length','width','height'].every(k=>number(g[k])!==null)?round((g.length*g.width+2*g.length*g.height+2*g.width*g.height)/1e6):null;
 return [...new Map(details.map(l=>[l.role,{kind:l.role,label:names[l.role],spec:l.text,area,unit:'㎡',choice:row.extraPricing?.[l.role]?.choice||'pending',rate:number(row.extraPricing?.[l.role]?.rate),fixedPrice:number(row.extraPricing?.[l.role]?.fixedPrice)}])).values()].map(a=>({...a,price:a.choice==='included'?0:a.choice==='separate'?(a.fixedPrice!==null?a.fixedPrice:a.area!==null&&a.rate!==null?round(a.area*a.rate):null):null}));
}
function proposal(row,policy){
 const base=body(row),extra=adjustments(row),p={mode:'assembly',version:VERSION,basis:F.basis(row),dependencyBasis:dependencyBasis(row),scope:linked(row)?'linked':'tank_body',stations:base.stations,chambers:base.chambers,bodyPrice:base.price,adjustments:extra,price:null,issues:base.issues,method:null};
 if(linked(row)){
  p.policyKey=key(row);p.policy=policy?structuredClone(policy):null;
  if(!policy?.confirmed||!METHODS[policy.method]){p.issues=[...base.issues,'联槽计价口径待确认；在待补齐中选择本组计算方式'];return p;}
  p.method=policy.method;
  if(policy.method==='stations')p.price=base.price;
  if(policy.material&&base.stations.some(s=>s.params.material!==policy.material)){p.issues=['默认联槽口径的材质与当前槽体不同'];return p;}
  if(policy.method==='factor'){
   const factor=number(policy.extraFactor),uniform=base.stations.every(s=>JSON.stringify(s.params)===JSON.stringify(base.stations[0].params));
   if(!uniform){p.issues=['递增系数仅用于每节尺寸、材质及板厚一致的联槽'];return p;}
   if(factor===null||factor>10){p.issues=['请填写0至10的每增节系数'];return p;}
   if(base.price!==null)p.price=round(base.stations[0].price*(1+(base.chambers-1)*factor));
  }
  if(policy.method==='extra'){const increment=number(policy.extraPrice);if(increment!==null&&base.stations[0]?.price!=null)p.price=round(base.stations[0].price+(base.chambers-1)*increment);else if(increment===null)p.issues=['统一每增节加价金额待填写'];}
  if(policy.method==='fixed'){const fixed=number(policy.prices?.[p.policyKey]??policy.fixedPrice);if(fixed!==null)p.price=fixed;else p.issues=['统一整组价表中此规格尚未填写'];}
 }else if(base.price!==null)p.price=base.stations[0].price;
 if(p.price!==null){p.issues=[];p.price=round(p.price+extra.reduce((a,e)=>a+(e.choice==='separate'&&e.price!==null?e.price:0),0));}
 p.pendingInclusions=extra.filter(e=>e.choice==='pending'||e.choice==='separate'&&e.price===null).map(e=>e.label+'含 / 另计待确认');
 return p;
}
function apply(q){
 for(const row of q.rows||[]){
  if(row.calculation||row.kind==='requirement'||row.bom?.role!=='tank'||!linked(row)&&!insulated(row))continue;
  if(row.pricing?.mode==='manual'||row.pricing?.mode!=='assembly'&&number(row.basePrice)!==null)continue;
  const p=proposal(row,row.linkedPricingPolicy||q.linkedPricing);row.pricing=p;row.basePrice=p.price;
  row.priceSource=p.price===null?(p.scope==='linked'?'联槽统一口径待确认':'槽体主体条件待补'):p.scope==='tank_body'?'槽体主体公式 · 保温含 / 另计待确认':'联槽报价 · '+METHODS[p.method];
  if(p.price!==null&&p.scope==='tank_body'&&!p.pendingInclusions.length)row.priceSource='槽体主体公式 · 配套结构已确认';
 }
 return q;
}
function setPolicy(q,policy){
 if(!METHODS[policy.method])throw Error('请选择联槽报价口径');
 if(policy.method==='extra'&&number(policy.extraPrice)===null)throw Error('请填写每增一节的统一加价');
 if(policy.method==='factor'&&(number(policy.extraFactor)===null||number(policy.extraFactor)>10))throw Error('请填写0至10的每增节系数');
 if(policy.method==='fixed'&&number(policy.fixedPrice)===null&&!Object.keys(policy.prices||{}).length)throw Error('请填写整组固定价或统一规格价表');
 const previous=q.linkedPricing?structuredClone(q.linkedPricing):null;
 q.linkedPricingHistory=[...(q.linkedPricingHistory||[]),{at:new Date().toISOString(),policy:previous,rows:q.rows.filter(linked).map(r=>({id:r.id,basePrice:r.basePrice,override:r.override,pricing:structuredClone(r.pricing),priceSource:r.priceSource,linkedPricingPolicy:r.linkedPricingPolicy?structuredClone(r.linkedPricingPolicy):undefined}))}];
 q.linkedPricing={...structuredClone(policy),version:VERSION,confirmed:true,confirmedAt:new Date().toISOString()};
 for(const r of q.rows.filter(linked)){if(r.pricing?.mode==='manual'||r.override!==null&&r.override!==undefined)continue;delete r.linkedPricingPolicy;r.basePrice=null;r.pricing={mode:'assembly'};}
 return apply(q);
}
function undoPolicy(q){const previous=q.linkedPricingHistory?.pop();if(!previous)throw Error('没有上次联槽口径');q.linkedPricing=previous.policy;for(const old of previous.rows){const row=q.rows.find(r=>r.id===old.id);if(row)Object.assign(row,old);}return q;}
function interpretationGroups(q){
 const groups=new Map();
 for(const row of q.rows||[]){
  const label=String(row.name||'').match(/([二两三四五六七八九十\d]+)[联连]/),count=label?({'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10}[label[1]]||Number(label[1])):null;
  if(row.bom?.role!=='tank'||!count||count<2||row.override!=null||row.pricing?.mode==='manual'||row.assemblyResolution&&!body(row).issues.some(s=>s.includes('重新核对联槽'))&&(row.linkedPricingPolicy?.confirmed||q.linkedPricing?.confirmed)&&row.quantity!=null)continue;
  const source=[row.sourceDocumentId,(row.source||'').replace(/\s*\/\s*第\d+行.*$/,'')],g={...row.geometry,...F.tankParameters(row.spec).params};
  const id=JSON.stringify([source,row.name,count,...['length','width','height','material','thickness'].map(k=>g[k]),row.geometry?.dimensionIssue,row.parameterConflicts]);
  if(!groups.has(id))groups.set(id,{id,name:row.name,chambers:count,geometry:g,rows:[]});groups.get(id).rows.push(row.id);
 }
 return [...groups.values()];
}
function resolveInterpretation(q,group,choice,source){
 if(!['section','total_length','total_width','total_height'].includes(choice.dimensions))throw Error('请选择单节尺寸或整组尺寸所在方向');
 if(!choice.confirmed||!source)throw Error('联槽尺寸解释须有本次确认依据');
 const qty=number(choice.quantity);if(qty===null)throw Error('请填写每处实际采购组数');
 if(choice.method!=='stations'&&choice.method!=='existing')throw Error('请选择适用的计价口径');
 for(const id of group.rows){const row=q.rows.find(r=>r.id===id);if(!row||row.quantityEdited&&row.quantity!==qty)throw Error('已有人工数量不同，请逐项核对');
  if(row.parameterConflicts?.length||row.geometry?.dimensionIssue)throw Error('原文尺寸存在冲突，须先修正规格');
  if(choice.method==='existing'&&!q.linkedPricing?.confirmed)throw Error('本单尚无已确认联槽计价口径');
 }
 for(const id of group.rows){const row=q.rows.find(r=>r.id===id),original=structuredClone({...row.geometry,...F.tankParameters(row.spec).params}),g={...original};
  if(choice.dimensions!=='section'){const axis=choice.dimensions.slice(6);if(!(g[axis]>0))throw Error('对应整组尺寸缺失');g[axis]/=group.chambers;}
  row.assemblyResolution={dimensions:choice.dimensions,chambers:group.chambers,source,at:new Date().toISOString(),originalGeometry:original,identityBasis:F.basis({...row,spec:''})};
  row.bom={...row.bom,chamberCount:group.chambers,memberGeometry:Array.from({length:group.chambers},()=>structuredClone(g))};row.geometry={...original,chambers:group.chambers};
  row.quantity=qty;row.quantityEdited=true;row.basePrice=null;row.pricing={mode:'assembly'};
  row.linkedPricingPolicy=choice.method==='stations'?{method:'stations',version:VERSION,confirmed:true,source}:structuredClone(q.linkedPricing);
 }
 return apply(q);
}
function summary(q){const rows=(q.rows||[]).filter(r=>r.bom?.role==='tank'&&linked(r));return {linkedRows:rows.length,method:q.linkedPricing?.confirmed?METHODS[q.linkedPricing.method]:null,groups:[...new Map(rows.map(r=>[key(r),{key:key(r),name:r.name,chambers:body(r).chambers,body:body(r),rows:rows.filter(v=>key(v)===key(r)).map(v=>v.id)}])).values()]};}
root.QuoteAssemblyPricing={VERSION,METHODS,dependencyBasis,linked,insulated,layers,key,body,adjustments,proposal,apply,setPolicy,undoPolicy,summary,interpretationGroups,resolveInterpretation};
if(typeof module!=='undefined')module.exports=root.QuoteAssemblyPricing;
})(typeof window!=='undefined'?window:globalThis);
