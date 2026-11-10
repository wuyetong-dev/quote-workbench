(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const K=typeof module!=='undefined'&&module.exports?require('./knowledge.js'):root.Knowledge;
const VERSION='2026-11-06.linked-reference.2';
const norm=value=>String(value??'').normalize('NFKC').trim();
const copy=value=>JSON.parse(JSON.stringify(value));
const unique=values=>[...new Set(values)];
const number=value=>value!==null&&value!==undefined&&norm(value)!==''&&Number.isFinite(Number(value))?Number(value):null;
const positive=value=>number(value)!==null&&Number(value)>0;
const axes=['length','width','height'];
const units=value=>/^(?:m|米)$/i.test(value||'')?1000:/^(?:cm|厘米)$/i.test(value||'')?10:1;
const dimensions=value=>axes.every(key=>positive(value?.[key]))?Object.fromEntries(axes.map(key=>[key,Number(value[key])])):null;
const sameDimensions=(a,b)=>a&&b&&axes.every(key=>Math.abs(a[key]-b[key])<1e-7);
const rotatedDimensions=(a,b)=>a&&b&&a.length===b.width&&a.width===b.length&&a.height===b.height&&!sameDimensions(a,b);
function countValue(value){
 const n=number(value);if(n!==null)return Number.isInteger(n)&&n>0?n:null;
 const digits={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};const s=norm(value);
 if(s==='十')return 10;if(s.includes('十')){const [a,b]=s.split('十');if((!a||digits[a])&&(!b||digits[b]))return (a?digits[a]:1)*10+(b?digits[b]:0);}
 return digits[s]||null;
}
function namedCount(name){const match=norm(name).match(/^([一二两三四五六七八九十\d]+)[联连]/);return match?countValue(match[1]):null;}
function typeName(name){
 return norm(name).replace(/^([一二两三四五六七八九十\d]+)[联连]/,'').replace(/^单(?=.+(?:槽|位)$)/,'').replace(/\s*[（(][^()]*[）)]\s*$/,'').replace(/\s+/g,'').replace(/(?:槽体|槽|位)$/,'').replace(/(?:第)?\d+[号#]?$/,'').replace(/槽$/,'').replace(/^超纯水(?:洗)?$/,'超纯水洗').replace(/^纯水(?:洗)?$/,'纯水洗');
}
function namesFrom(name){return norm(name).replace(/^([一二两三四五六七八九十\d]+)[联连]/,'').split(/[、,，;；+＋/]/).map(typeName).filter(Boolean);}
function material(row){
 const detail=K.describeRow(row),primary=detail.primaryText||row.spec||'';
 const imported=/进口[^\n；;]{0,14}\bPP\b|PP[^\n；;]{0,8}进口/i.test(primary)||/进口|IMPORT_PP/.test(norm(row.geometry?.material));
 return {value:imported&&detail.parameters.material==='PP'?'IMPORT_PP':detail.parameters.material||null,thickness:detail.parameters.thickness??null,issues:[...(detail.issues||[]),...(detail.parameters.material==='SUS'?['不锈钢具体牌号未明确']:[])]};
}
function splitAxes(value){
 let text=norm(value).replace(/[×xX＊]/g,'*').replace(/\(\s*L\s*\*\s*W\s*\*\s*H[^)]*\)/gi,'').trim();
 text=text.replace(/^(?:尺寸|规格|单节尺寸|每节尺寸)\s*[:：]?\s*/,'').trim();
 const trailing=text.match(/(mm|毫米|cm|厘米|m|米)\s*$/i)?.[1]||'';
 text=text.replace(/\s*(mm|毫米|cm|厘米|m|米)\s*$/i,'').trim();
 if(text[0]==='('&&text.at(-1)===')'){
  let depth=0,encloses=true;for(let i=0;i<text.length-1;i++){if(text[i]==='(')depth++;if(text[i]===')')depth--;if(!depth){encloses=false;break;}}
  if(encloses)text=text.slice(1,-1);
 }
 const parts=[];let depth=0,last=0;for(let i=0;i<text.length;i++){if(text[i]==='(')depth++;if(text[i]===')')depth--;if(text[i]==='*'&&!depth){parts.push(text.slice(last,i));last=i+1;}}parts.push(text.slice(last));
 return parts.length===3?{parts,trailing}:null;
}
function referenceDimensions(row,count){
 const line=norm(row.spec).split('\n').find(text=>/尺寸|\d\s*[*×x＊]/i.test(text))||norm(row.spec).split('\n')[0],split=splitAxes(line),values={},products=[];
 if(split){
  for(let i=0;i<3;i++){
   const text=split.parts[i].trim().replace(/^\((.*)\)$/,'$1'),single=text.match(/^(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?$/i),product=text.match(/^(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?\s*\*\s*(\d+)$/i);
   if(single)values[axes[i]]=Number(single[1])*units(single[2]||split.trailing);
   else if(product){const factor=Number(product[3]);if(factor<2||!Number.isInteger(factor))return {dimensions:null,count,basis:line,issues:['组合尺寸表达式的节数不明确']};products.push(factor);values[axes[i]]=Number(product[1])*units(product[2]||split.trailing);}
   else return {dimensions:null,count,basis:line,issues:['尺寸表达式无法明确还原单节长宽高']};
  }
  if(products.length>1)return {dimensions:null,count,basis:line,issues:['多个轴都有重复因子，组合方向需确认']};
  if(products.length){if(count&&count!==products[0])return {dimensions:null,count,basis:line,issues:['名称节数与组合尺寸重复因子不同']};return {dimensions:dimensions(values),count:products[0],basis:'原文明确重复尺寸：'+line,issues:[]};}
  if((count||1)>1&&!/单节|每节|单工位/.test(line))return {dimensions:null,rawDimensions:dimensions(values),count,basis:line,issues:['参考仅列组合尺寸，未明确单节尺寸或重复轴向，不按节数相除']};
  return {dimensions:dimensions(values),count:count||1,basis:'参考单槽/明示单节尺寸：'+line,issues:[]};
 }
 const parsed=F.parameters(row.spec,{scope:'tank'}),d=dimensions(parsed.params);
 if((count||1)>1&&!/单节|每节|单工位/.test(line))return {dimensions:null,rawDimensions:d,count,basis:line,issues:['参考未明确单节尺寸或组合轴向']};
 return {dimensions:d,count:count||1,basis:'参考标注尺寸：'+line,issues:d?[]:['缺少明确的单节长宽高']};
}
function keyOf(type,d,mat,count){return type&&d&&mat&&count?JSON.stringify([type,Math.min(d.length,d.width),Math.max(d.length,d.width),d.height,mat,count]):null;}
function sourceRefs(row,source){return [{sourceId:source.id,filename:source.filename,sheet:source.sheet,sha256:source.sha256||null,location:row.source||[source.filename,source.sheet,'第'+row.sourceRow+'行'].filter(Boolean).join(' / '),sourceRow:row.sourceRow??null,sourceRanges:copy(row.bom?.sourceRanges||[])}];}
function build(referenceQuote,metadata={}){
 const first=referenceQuote.sources?.[0]||{},source={filename:metadata.filename||first.filename||'',sheet:metadata.sheet||first.sheet||'',sha256:metadata.sha256||first.sha256||null,...copy(metadata),priceNature:'project_reference'};source.id=metadata.id||'project-reference-'+(source.sha256?source.sha256.slice(0,16):referenceQuote.id||'imported');
 const entries=[],rejected=[];
 for(const [index,row]of (referenceQuote.rows||[]).entries()){
  if(row.kind==='requirement'||!F.isTankBody(row))continue;
  const parts=namesFrom(row.name),known=namedCount(row.name),read=referenceDimensions(row,known||(parts.length>1?parts.length:null)),mat=material(row),type=parts.join('＋'),price=number(row.offeredUnitPrice??row.unitPrice??row.override??row.basePrice??row.price),issues=[...read.issues];
  if(!type)issues.push('槽型未明确');if(!mat.value)issues.push('主体材质未明确');if(price===null)issues.push('没有整组参考单价');if(mat.issues.length)issues.push(...mat.issues);
  const entry={id:source.id+':'+(row.sourceRow??index+1)+':'+index,key:keyOf(type,read.dimensions,mat.value,read.count),type,chambers:read.count,dimensions:read.dimensions,rawDimensions:read.rawDimensions||null,material:mat.value,thickness:mat.thickness,price,unit:norm(row.unit),name:row.name,spec:row.spec,sourceRefs:sourceRefs(row,source),basis:{dimensionSource:read.basis,sectionSource:known?'名称明示节数':parts.length>1?'原文逐项工序名称及尺寸表达式':'原文单槽/尺寸表达式',orientation:'ordered',sourceRow:row.sourceRow??null},issues:unique(issues),usable:!issues.length&&!!keyOf(type,read.dimensions,mat.value,read.count),priceNature:'project_reference',needsConfirmation:true};
  entries.push(entry);if(!entry.usable)rejected.push({id:entry.id,name:entry.name,sourceRefs:entry.sourceRefs,issues:entry.issues});
 }
 return {version:VERSION,source,entries,rejected,confirmed:false};
}
function sourceShape(row){
 const info=K.describeRow(row),mat=material(row),counts=unique([countValue(row.bom?.chamberCount),countValue(row.geometry?.chambers),namedCount(row.name)].filter(Boolean)),issues=[...mat.issues];
 if(counts.length>1)issues.push('原配置节数存在冲突');const chambers=counts[0]||info.parameters.linkedChambers||1;
 const allMembers=row.bom?.stationMembers||[],members=allMembers.map(member=>({name:member.name,type:typeName(member.name),sourceRow:member.sourceRow,sourceRanges:copy(member.sourceRanges||[]),dimensions:dimensions(member.geometry),material:material({name:member.name,spec:'',geometry:member.geometry,bom:{role:'tank'},unit:row.unit}).value}));
 const names=members.map(member=>member.type),mixed=unique(names.length?names:namesFrom(row.name)).length>1;
 let pattern=namesFrom(row.name),partMembers=members;
 if(members.length){
  if(mixed&&members.length!==chambers){
   const n=number(row.quantity);if(!n||members.length!==chambers*n)issues.push('原工位成员数量与每组节数/组数不一致');
   else{const first=members.slice(0,chambers);if(members.some((member,i)=>member.type!==first[i%chambers].type||!sameDimensions(member.dimensions,first[i%chambers].dimensions)||member.material!==first[i%chambers].material))issues.push('不同整组的工序/尺寸不一致');partMembers=first;}
  }
  pattern=mixed?partMembers.map(member=>member.type):[names[0]];
 }
 if(mixed&&!members.length)issues.push('混工序缺少逐工位原名称与尺寸，不能按合并名称猜工序次数');
 const d=dimensions(row.geometry)||(/单节|每节|单工位/.test(row.spec||'')?dimensions(F.parameters(row.spec,{scope:'tank'}).params):chambers===1?dimensions(info.parameters):null);
 if(!d)issues.push('原配置单节尺寸未明确');if(!mat.value)issues.push('原配置主体材质未明确');
 if(members.length&&members.some(member=>member.dimensions&&!sameDimensions(member.dimensions,d)||member.material&&member.material!==mat.value))issues.push('各工位尺寸/材质不一致，需逐工位核对');
 if(row.parameterConflicts?.length||row.geometry?.dimensionIssue)issues.push(...row.parameterConflicts||[],row.geometry?.dimensionIssue);
 return {type:pattern.join('＋'),chambers,dimensions:d,material:mat.value,thickness:mat.thickness,mixed,members:partMembers,issues:unique(issues.filter(Boolean)),basis:{name:row.name,spec:row.spec,unit:row.unit,quantity:row.quantity,type:pattern.join('＋'),chambers,dimensions:d,material:mat.value,geometry:copy(row.geometry||{}),stationMembers:copy(allMembers)}};
}
function compareEntry(shape,entry){
 const differences=[];if(shape.type!==entry.type)differences.push('槽型不同：'+shape.type+' / '+entry.type);if(shape.chambers!==entry.chambers)differences.push('节数不同：'+shape.chambers+' / '+entry.chambers);if(shape.material!==entry.material)differences.push('材质不同：'+shape.material+' / '+entry.material);
 const rotated=rotatedDimensions(shape.dimensions,entry.dimensions),ordered=sameDimensions(shape.dimensions,entry.dimensions);
 if(!ordered&&!rotated)differences.push('单节长宽高不同或未明确');
 if(shape.thickness!==null&&entry.thickness!==null&&shape.thickness!==entry.thickness)differences.push('主体板厚不同：'+shape.thickness+' / '+entry.thickness);
 return {...copy(entry),matchKind:!differences.length&&entry.usable?(rotated?'rotated':'exact'):entry.usable?'different':'incomplete',canAdopt:!differences.length&&entry.usable,dimensionEquivalence:ordered?'ordered':rotated?'rotated':null,warnings:rotated?['矩形槽长宽互换等价；保留原标注及项目参考价供确认']:[],differences};
}
function matchShape(shape,table){
 const candidates=(table?.entries||[]).filter(entry=>entry.type===shape.type||shape.mixed&&entry.type.split('＋').some(type=>shape.type.split('＋').includes(type))).map(entry=>compareEntry(shape,entry)).sort((a,b)=>Number(b.canAdopt)-Number(a.canAdopt)||Number(b.matchKind==='exact')-Number(a.matchKind==='exact')||Number(b.matchKind==='rotated')-Number(a.matchKind==='rotated')||a.differences.length-b.differences.length);
 if(shape.issues.length)return {status:shape.mixed?'mixed_pending':'unmatched',entry:null,candidates,parts:[],reason:shape.issues.join('；'),basis:shape.basis};
 const exact=candidates.filter(entry=>entry.canAdopt),prices=unique(exact.map(entry=>entry.price));
 if(prices.length>1)return {status:'ambiguous',entry:null,candidates,parts:[],reason:'同槽型、单节尺寸、材质及节数有不同整组参考价，需逐项确认来源',basis:shape.basis};
 if(exact.length)return {status:'matched',entry:{...exact[0],equivalentEntryIds:exact.map(entry=>entry.id),sourceRefs:exact.flatMap(entry=>entry.sourceRefs)},candidates,parts:[],reason:exact[0].matchKind==='rotated'?'槽型、材质、节数及板厚一致，矩形槽单节长宽互换等价；原整组项目参考价，可确认采用':'槽型、单节长宽高、材质及节数精确对应；原整组项目参考价，可确认采用',basis:shape.basis};
 const closest=candidates[0];
 return {status:shape.mixed?'mixed_pending':'unmatched',entry:null,candidates,parts:[],reason:shape.mixed?'混工序未建立唯一整组参考价，按原工位拆开核对，不相加外推':closest?.differences?.length?closest.differences.join('；'):'未找到同槽型、单节尺寸、材质及节数的整组参考价',basis:shape.basis};
}
function match(row,table,options={}){
 const shape=sourceShape(row),result=matchShape(shape,table);
 if(shape.mixed)result.parts=shape.members.map(member=>({name:member.name,type:member.type,sourceRow:member.sourceRow,sourceRanges:member.sourceRanges,dimensions:member.dimensions,material:member.material,chambers:1,match:matchShape({...shape,type:member.type,chambers:1,dimensions:member.dimensions,material:member.material,mixed:false,issues:member.dimensions&&member.material?[]:['工位尺寸或材质未明确'],basis:{sourceRow:member.sourceRow,name:member.name,dimensions:member.dimensions,material:member.material,chambers:1}},table)}));
 return {...result,tableSource:copy(table?.source||{}),priceNature:'project_reference',needsConfirmation:true};
}
const tableBasis=table=>JSON.stringify([table.source,(table.entries||[]).map(entry=>[entry.id,entry.key,entry.price,entry.spec,entry.usable])]);
function remember(row,event){row.linkedPriceHistory=row.linkedPriceHistory||[];row.linkedPriceHistory.push({event,at:new Date().toISOString(),basePrice:row.basePrice,override:row.override,pricing:copy(row.pricing||{}),priceSource:row.priceSource,priceEvidence:copy(row.priceEvidence||null)});}
function invalidate(row,status,basis,source){
 if(number(row.basePrice)===null&&row.pricing?.confirmed===false&&row.pricing?.basis===basis&&row.pricing?.status===status)return;
 remember(row,'reference_invalidated');row.basePrice=null;row.pricing={mode:'linked_reference',version:VERSION,status,confirmed:false,basis};row.priceSource='整组项目参考价待确认';row.priceEvidence={priceNature:'project_reference',status,previous:copy(row.priceEvidence||null),source:copy(source||{})};
}
function apply(q,options={}){
 const table=options.table||q.linkedPriceTable,previewOnly=options.confirmed===false;
 if(!table){if(!previewOnly)for(const row of q.rows||[])if(row.pricing?.mode==='linked_reference'&&number(row.override)===null)invalidate(row,'unmatched','table-missing',{});return q;}
 if(options.table)q.linkedPriceTable=table;
 const signature=tableBasis(table);let confirmed=options.confirmed===undefined?table.confirmed===true:options.confirmed===true;
 const selectedIds=options.rowIds?new Set(options.rowIds):null;
 q.linkedReferenceSelections=q.linkedReferenceSelections||{};
 if(options.confirmed===true){table.confirmed=true;table.confirmedBasis=signature;table.confirmedAt=new Date().toISOString();}
 else if(table.confirmedBasis&&table.confirmedBasis!==signature){confirmed=false;table.confirmed=false;}
 if(confirmed){if(!table.confirmedBasis)table.confirmedBasis=signature;if(!table.confirmedAt)table.confirmedAt=new Date().toISOString();}
 for(const row of q.rows||[]){
  if(row.calculation)continue;
  if(row.kind==='requirement'||!F.isTankBody(row)||Math.max(countValue(row.bom?.chamberCount)||1,countValue(row.geometry?.chambers)||1,namedCount(row.name)||1)<2){
   if(row.pricing?.mode==='linked_reference'&&number(row.override)===null&&!previewOnly){const basis=JSON.stringify([row.name,row.spec,row.bom?.chamberCount,row.geometry]);invalidate(row,'unmatched',basis,table.source);row.linkedPriceMatch={status:'unmatched',entry:null,candidates:[],parts:[],reason:'当前部件已不是原联槽规格，原整组价失效',applied:false};}
   continue;
  }
  const result=match(row,table,{quote:q}),basis=JSON.stringify(result.basis),owned=row.pricing?.mode==='linked_reference';row.linkedPriceMatch={...result,basisSignature:basis,matchedAt:new Date().toISOString(),applied:false};
  if(previewOnly){row.linkedPriceMatch.skipReason='预览，不改当前单价';continue;}
  if(row.pricing?.mode==='manual'||number(row.override)!==null){row.linkedPriceMatch.skipReason='保留当前人工确认价';continue;}
  if(options.confirmed===true&&(!selectedIds||selectedIds.has(row.id))&&result.status==='matched')q.linkedReferenceSelections[row.id]={basis,entryId:result.entry.id,tableBasis:signature,confirmedAt:new Date().toISOString()};
  const selection=q.linkedReferenceSelections[row.id],selected=selection?.basis===basis&&selection?.entryId===result.entry?.id&&selection?.tableBasis===signature;
  if(!confirmed||result.status!=='matched'||!selected){
   if(owned)invalidate(row,result.status,basis,table.source);
   row.linkedPriceMatch.skipReason=selected?'项目参考价待确认':'尚未点采用，当前单价不变';
   continue;
  }
  const entry=result.entry,changed=!owned||row.pricing.basis!==basis||row.pricing.tableBasis!==signature||number(row.basePrice)!==entry.price;
  if(changed)remember(row,'project_reference_adopted');row.basePrice=entry.price;row.pricing={mode:'linked_reference',version:VERSION,status:'matched',confirmed:true,key:entry.key,basis,tableBasis:signature};row.priceSource='整组项目参考价 · '+(table.source.filename||'参考报价')+' · 需确认来源';
  row.priceEvidence={priceNature:'project_reference',version:VERSION,source:copy(table.source),sourceRefs:copy(entry.sourceRefs),entry:copy(entry),basis:copy(result.basis),confirmed:true,confirmedAt:table.confirmedAt||new Date().toISOString(),note:'按完整规格取原整组单价；未按单槽乘节数，未统一加价，保留项目参考价来源'};row.linkedPriceMatch.applied=true;
 }
 return q;
}
const api={VERSION,build,match,apply,keyOf,typeName};root.LinkedPricebook=api;root.QuoteLinkedPricebook=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
