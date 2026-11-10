(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const A=typeof module!=='undefined'&&module.exports?require('./assembly-pricing.js'):root.QuoteAssemblyPricing;
const C=typeof module!=='undefined'&&module.exports?require('./calculation.js'):root.QuoteCalculation;
const S=typeof module!=='undefined'&&module.exports?require('./source-facts.js'):root.QuoteSourceFacts;
const uid=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const text=v=>String(v??'').trim();
const clean=v=>text(v).normalize('NFKC').replace(/\s/g,'');
// Search caches and derived engineering projections are rebuilt on load; source
// documents, confirmed price evidence and calculation snapshots must survive.
const quoteReplacer=(key,value)=>['knowledgeEvidence','linkedPriceMatch','engineering'].includes(key)?undefined:value;
function number(v){if(typeof v==='number')return Number.isFinite(v)&&v>=0?v:null;const s=clean(v).replace(/[,，￥¥]/g,'').replace(/(?:人民币|RMB|CNY|元)/gi,'');return /^\d+(?:\.\d+)?$/.test(s)?Number(s):null;}
function fraction(v){const s=String(v),m=s.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);if(!m)throw Error('请输入有效非负数');let n=BigInt(m[1]+(m[2]||'')),d=10n**BigInt((m[2]||'').length);const exp=Number(m[3]||0);if(exp>=0)n*=10n**BigInt(exp);else d*=10n**BigInt(-exp);return [n,d];}
function product(...values){let a=1n,b=1n;for(const v of values){const [x,y]=fraction(v);a*=x;b*=y;}return Number((a*100n*2n+b)/(2n*b))/100;}
function historyBasis(row,q){return [row.name||'',row.spec||'',row.unit||'',row.brand||'',number(row.quantity),row.supplyScope||row.scope||'',q.currency||'CNY',q.taxMode||'none',number(q.taxRate)||0,q.businessTerms||''];}
function historyTechnicalValid(row,q){return !!row.historyReuseBasis&&JSON.stringify(row.historyReuseBasis.slice(0,7))===JSON.stringify(historyBasis(row,q).slice(0,7));}
function refreshHistoryConditions(q){for(const row of q.rows||[]){const s=row.automaticSuggestions?.price;if(s?.group?.startsWith('historical-case:')&&historyTechnicalValid(row,q)&&JSON.stringify(row.historyReuseBasis)!==JSON.stringify(historyBasis(row,q)))s.status='pending';}}
function price(row,q,evaluated){const check=evaluated||(C?C.evaluate(row,q):null),base=check?check.basePrice:number(row.basePrice);if(row.historyReuseBasis&&JSON.stringify(row.historyReuseBasis)!==JSON.stringify(historyBasis(row,q))||check?.status==='stale'||row.calculation&&check?.status!=='priced')return null;return row.override!==null&&row.override!==undefined?product(row.override,1):base===null?null:product(base,100+Number(q.markup||0),0.01);}
function isRequirement(row){return row.kind==='requirement'||row.bom?.role==='requirement';}
function isIncluded(row){return row.bom?.supplyStatus==='included'||row.decomposition?.relationship==='included';}
function calculate(q){let total=0,missing=0,selected=0,requirements=0;const rows=q.rows.map(r=>{const requirement=isRequirement(r),included=isIncluded(r),evaluated=C?C.evaluate(r,q):null,unitPrice=requirement||included?null:price(r,q,evaluated),quantity=number(r.quantity),amount=unitPrice!==null&&quantity!==null?product(unitPrice,quantity):null;if(requirement)requirements++;else if(!included&&r.selected!==false){selected++;if(amount===null)missing++;else total=Math.round((total+amount)*100)/100;}return {...r,unitPrice,amount,...(evaluated?{priceStatus:evaluated.status,priceIssues:evaluated.issues}:{})};});const commercial=(typeof module!=='undefined'&&module.exports?require('./commercial.js'):root.QuoteCommercial).apply(total,q);total=commercial.total;const tax=q.taxMode==='excluded'?product(total,Number(q.taxRate||0)/100):0;return {rows,...commercial,total,tax,grandTotal:Math.round((total+tax)*100)/100,missing,selected,requirements,...(C?{completeness:C.inspect(q,rows)}:{})};}
function draft(){return {id:uid(),title:'未命名报价',customer:'',date:new Date().toLocaleDateString('en-CA'),quoteNo:'HJ-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+Date.now().toString().slice(-5),markup:0,taxMode:'none',taxRate:0,notes:'',rows:[],sources:[],updatedAt:new Date().toISOString()};}
function copy(q){const result={...structuredClone(q),id:uid(),quoteNo:draft().quoteNo,updatedAt:new Date().toISOString()};delete result.aiTask;delete result.deliveryConfirmation;result.exportMode='draft';return result;}
function matchParts(q,parts){for(const r of q.rows){if(isRequirement(r)||number(r.basePrice)!==null||r.pricing?.mode==='manual')continue;if(r.pricing?.mode==='formula'&&Object.keys(r.pricing.supplied||{}).length){F.apply(r);continue;}const found=parts.filter(p=>['name','spec','unit','brand'].every(k=>clean(p[k])===clean(r[k]))&&(number(p.price)!==null||p.pricing?.mode==='formula'));if(found.length===1){const p=found[0];if(p.pricing?.mode==='formula'){r.pricing=structuredClone(p.pricing);F.apply(r,{force:true});}else{r.basePrice=number(p.price);r.pricing={mode:'manual'};r.priceSource='部件库 · '+p.name;}}else F.apply(r);}return q;}
function autoPrice(q){refreshHistoryConditions(q);const Q=typeof module!=='undefined'&&module.exports?require('./quantity.js'):root.QuoteQuantity;if(Q)Q.apply(q);const B=typeof module!=='undefined'&&module.exports?require('./condition-binding.js'):root.QuoteConditionBinding;if(B)B.apply(q);if(S)S.apply(q);q.rows.forEach(r=>{if(!r.calculation&&!r.engineeringBill&&!isRequirement(r)&&!['assembly','linked_reference'].includes(r.pricing?.mode))F.apply(r);});if(A)A.apply(q);const L=typeof module!=='undefined'&&module.exports?require('./linked-pricebook.js'):root.QuoteLinkedPricebook;if(L)L.apply(q,{table:q.linkedPriceTable});if(C)for(const r of q.rows){if(r.calculation||r.engineeringBill)r.basePrice=C.evaluate(r,q).basePrice;}return q;}
function geometrySpec(g){const labels={length:'长',width:'宽',height:'高',thickness:'厚度'},items=Object.entries(labels).filter(([k])=>number(g[k])!==null).map(([k,label])=>label+g[k]+'mm');if(g.material)items.push('材质 '+text(g.material));return [items.join(' '),number(g.chambers)>1?g.chambers+'联槽；尺寸为单工位内尺寸':'',g.specSuffix||''].filter(Boolean).join('\n');}
function geometryFromSpec(row){
 const tank=F.isTankBody(row),parsed=F.parameters(row.spec,{scope:tank?'tank':undefined});
 function remainder(line){
  if(/^\s*\d+联槽[（；]/.test(line))return '';
  const n='\\d+(?:\\.\\d+)?',u='(?:mm|毫米|cm|厘米|m|米)?';
  let rest=line.replace(new RegExp(n+'\\s*'+u+'\\s*[×x*]\\s*'+n+'\\s*'+u+'\\s*[×x*]\\s*'+n+'\\s*'+u+'(?:\\s*[×x*]\\s*'+n+'\\s*(?:mm|毫米|T))?','gi'),'')
   .replace(new RegExp('(?:长度|宽度|高度|板厚|壁厚|厚度|长|宽|高|厚|\\b[LWHT]\\b)\\s*(?:[（(](?:mm|毫米|cm|厘米|m|米)[)）])?\\s*[:：=]?\\s*'+n+'\\s*'+u,'gi'),'')
   .replace(/(?:材质|材料)?\s*(?:进口\s*PP|SUS\s*(?:304|316)L?(?:镜面)?|PP\s*-?\s*S|PPS?|PVDF|PTFE|PVC|FRP|TI)(?![A-Za-z0-9])/gi,'');
  if(!/承重/.test(line))rest=rest.replace(new RegExp(n+'\\s*T(?![A-Za-z0-9])','gi'),'');
  rest=rest.replace(new RegExp('(?:主体|主槽|槽体)\\s*[:：]?\\s*'+n+'\\s*(?:mm|毫米|cm|厘米)','gi'),'');
  return /^(?:尺寸|内净尺寸|材质|材料|主体|主槽|槽体|[\s:：/，,；;])*$/i.test(rest)?'':rest.trim();
 }
 const original=text(row.spec),sourceText=layer=>{const raw=original.slice(layer.start,layer.end).trim();return raw.normalize('NFKC')===layer.text?raw:layer.text;};
 const suffix=parsed.issues.length?original:tank?parsed.layers.map(layer=>{const rest=layer.role==='body'?remainder(layer.text):layer.text;return rest===layer.text?sourceText(layer):rest;}).filter(Boolean).join('\n'):original.split('\n').filter(line=>remainder(line)).join('\n');
 return {...parsed.params,chambers:row.bom?.chamberCount||row.geometry?.chambers||1,specSuffix:suffix};
}
function editGeometry(row,geometry){row.geometry=structuredClone(geometry);return F.edit(row,'spec',geometrySpec(geometry));}
root.QuoteModel={uid,text,clean,quoteReplacer,number,product,price,calculate,draft,copy,matchParts,autoPrice,isRequirement,isIncluded,geometrySpec,geometryFromSpec,editGeometry,historyBasis,historyTechnicalValid};
if(typeof module!=='undefined')module.exports=root.QuoteModel;
})(typeof window!=='undefined'?window:globalThis);
