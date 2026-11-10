(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const norm=v=>String(v??'').normalize('NFKC').toUpperCase().trim();
// Only equivalent expressions belong here. Unqualified stainless is SUS,
// never a guessed grade, and mass flow is not converted to volumetric flow.
function text(value){return norm(F.parameterText(value)).replace(/聚丙烯/g,'PP').replace(/(?:SUS\s*)?(304|316)(L)?\s*不锈钢|不锈钢\s*(?:SUS\s*)?(304|316)(L)?/g,(_,a,b,c,d)=>'SUS'+(a||c)+(b||d||'')).replace(/((?:材质|材料)\s*[:：]?\s*)(304|316)(L)?(?!\d)/g,'$1SUS$2$3').replace(/不锈钢/g,'SUS').replace(/(PP|SUS(?:304|316)L?)\s*板(?:材)?/g,'$1').replace(/(\d+(?:\.\d+)?)\s*吨\s*(?:\/\s*(?:小时|时)|每小时)/g,'$1T/H').replace(/立方米\s*\/\s*(?:小时|时)/g,'M3/H').replace(/(T|M[3³]|L)\s*\/\s*(H|MIN)/g,'$1/$2').replace(/毫米/g,'MM').replace(/厘米/g,'CM').replace(/千瓦/g,'KW').replace(/千赫兹/g,'KHZ').replace(/[×＊]/g,'*');}
const compact=v=>text(v).replace(/\s+/g,'');
const labels={material:'材质',length:'长度',width:'宽度',height:'高度',thickness:'板厚',flow:'流量',flowUnit:'流量单位',power:'功率',frequency:'频率',voltage:'电压',current:'电流',linkedChambers:'联数',chambers:'联数',surfaceFinish:'表面处理',transducerCount:'振子数量'};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function qualifiers(spec){
 return text(spec)
  .replace(/(?:规格|材质|材料|流量|总功率|功率|频率)\s*(?:\([^)]*\))?\s*[:：=]?/g,' ')
  .replace(/(?:SUS\s*(?:304|316)L?|IMPORT_PP|进口\s*PP|PP-S|PPS|PP|SUS|PVDF|PTFE|PVC|FRP)(?![A-Z])/g,' ')
  .replace(/(?:长(?:度)?|宽(?:度)?|高(?:度)?|厚度|板厚|壁厚)\s*[:：=]?\s*\d+(?:\.\d+)?\s*(?:MM|CM|M)?/g,' ')
  .replace(/\d+(?:\.\d+)?\s*(?:MM|CM|M)?\s*[*X]\s*\d+(?:\.\d+)?\s*(?:MM|CM|M)?\s*[*X]\s*\d+(?:\.\d+)?\s*(?:MM|CM|M)?/g,' ')
  .replace(/\d+(?:\.\d+)?\s*(?:T\/H|M[3³]\/H|L\/MIN|KHZ|HZ|KW|W|MM|T)(?![A-Z/])/g,' ')
  .replace(/[\s:：;；,，、()（）]+/g,' ').trim().split(' ').filter(Boolean).sort().join('|');
}
function features(row,detail,identity,context=''){
 const parameters=Object.fromEntries(Object.entries(detail.parameters||{}).sort(([a],[b])=>a.localeCompare(b)));
 return {featureVersion:2,name:compact(identity||row.name),sourceName:row.name,category:detail.category,spec:text(row.spec||(Object.values(parameters).some(v=>typeof v==='number')?row.name:'')),parameters,material:parameters.material||'',brand:compact(row.brand),unit:compact(row.unit),scope:compact(row.supplyScope||row.scope||row.bom?.role||''),context,qualifiers:qualifiers(row.spec),missing:detail.missingFields||[],issues:detail.issues||[]};
}
function compare(a,b){
 const differences=[],hardConflicts=[],matched=[],ap=a.parameters||{},bp=b.parameters||{};let score=100;
 if(a.name!==b.name||a.category!==b.category)hardConflicts.push('设备类型不同');
 for(const [key,label]of [['unit','计量单位'],['brand','品牌'],['scope','供货范围'],['context','税价及企业口径']]){
  if(a[key]!==b[key]){if(a[key]&&b[key])hardConflicts.push(label+'不同');else{score-=5;differences.push(label+'有一方未注明');}}
 }
 let numericMatched=0,numericCompared=0;
 for(const key of new Set([...Object.keys(ap),...Object.keys(bp)])){
  const x=ap[key],y=bp[key],label=labels[key]||key;if(equal(x,y)){matched.push(key);if(typeof x==='number')numericMatched++;continue;}
  if(x==null||y==null||key==='material'&&(x==='SUS'||y==='SUS')&&/^SUS/.test(x)&&/^SUS/.test(y)){score-=key==='material'?20:12;differences.push(label+'有一方未注明或牌号未明确');continue;}
  if(typeof x==='number'&&typeof y==='number'){
   numericCompared++;
   const distance=Math.abs(x-y)/Math.max(Math.abs(x),Math.abs(y),1);score-=Math.max(10,Math.ceil(distance*50));
   differences.push(label+'不同：'+x+' / '+y);if(distance>.25)hardConflicts.push(label+'规格差异超过25%');
  }else hardConflicts.push(label+'不同：'+x+' / '+y);
 }
 if(a.qualifiers!==b.qualifiers){score-=15;differences.push('未量化配置或型号文字不同');}
 if((a.issues||[]).length||(b.issues||[]).length)hardConflicts.push('参数存在冲突');
 if((a.missing||[]).length||(b.missing||[]).length){score=Math.min(score,85);differences.push('关键参数待核对');}
 if(!numericMatched&&!numericCompared&&a.spec!==b.spec)score=Math.min(score,49);
 if(!a.spec||!b.spec)score=Math.min(score,49);
 if(hardConflicts.length)score=Math.min(score,49);
 if(differences.length)score=Math.min(score,90);
 score=Math.max(0,score);
 return {score,tier:score===100?'exact':score>=70?'similar':'manual',exact:score===100,matched,differences,hardConflicts};
}
root.QuotePriceFeatures={text,features,compare,qualifiers};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuotePriceFeatures;
})(typeof window!=='undefined'?window:globalThis);
