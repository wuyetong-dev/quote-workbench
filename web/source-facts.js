(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const VERSION='2026-11-07.source-facts.1',text=v=>String(v??'').normalize('NFKC').trim(),norm=v=>text(v).replace(/\s/g,'');
const present=v=>v!==null&&v!==undefined&&v!=='';
function context(q,row){
 const candidates=(q.sources||[]).filter(s=>(!row.sourceDocumentId||!s.documentId||row.sourceDocumentId===s.documentId)&&row.source?.startsWith(s.filename+' / '+s.sheet+' /'));
 if(candidates.length!==1)return null;
 const source=candidates[0],number=row.sourceRow||row.bom?.stationMembers?.[0]?.sourceRow;
 const sections=(source.standardProcess?.sections||[]).filter(s=>s.stations?.some(t=>t.row===number));
 const section=sections.length===1?sections[0]:null,station=section?.stations.find(s=>s.row===number);
 return {source,section,station,key:JSON.stringify([source.documentId||source.filename,source.sheet,section?.headerRow??null]),label:[source.filename,source.sheet].join(' / ')};
}
function cell(source,range){
 const match=text(range).match(/^(.*?)!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/i);if(!match||match[1].replace(/^'|'$/g,'').replace(/''/g,"'")!==source.sheet)return undefined;
 let col=0;for(const c of match[2].toUpperCase())col=col*26+c.charCodeAt(0)-64;
 return source.rows?.[Number(match[3])-1]?.[col-1];
}
function notes(source){
 // Headers and station fields retain their own owners. Only genuinely separate
 // notes can state a rule for a sheet; a neighbouring device cell cannot.
 const headers=new Set((source.standardProcess?.sections||[]).flatMap(s=>Array.from({length:Math.max(0,s.startRow-s.headerRow)},(_,i)=>s.headerRow+i)));
 return (source.standardProcess?.otherRows||[]).filter(r=>!headers.has(r)).flatMap(r=>(source.rows?.[r-1]||[]).flatMap((value,c)=>{
  if(!text(value))return [];let index=c+1,letters='';while(index){index--;letters=String.fromCharCode(65+index%26)+letters;index=Math.floor(index/26);}
  return text(value).split(/[\n；;]/).filter(Boolean).map(quote=>({quote,range:source.sheet+'!'+letters+r,source:source.filename+' / '+source.sheet}));
 }));
}
const devices=[['整流机',/整流机|整流器/],['过滤机',/过滤机|过滤器/],['超声波发生器',/超声波发生器/],['冷水机',/冷水机/],['行车',/行车|天车|龙门车/]];
function scopedFacts(source){
 const facts=[];
 for(const evidence of notes(source)){
  const s=evidence.quote;if(/建议|暂按|拟用|默认|例如|待定|待确认|可选|或者|不采用/.test(s))continue;
  for(const [device,pattern]of devices){
   const match=s.match(new RegExp('('+pattern.source+')\\s*(?:统一)?(?:采用\\s*(.{1,24}?)品牌|品牌\\s*[:：为]\\s*([^，,。]{1,24}))'));
   const value=text(match?.[2]||match?.[3]);if(value&&!/未定|客户|自备|指定|可选|或|\/|采用|品牌|不/.test(value))facts.push({field:'brand',device,value,...evidence});
  }
  // A positive, explicit declaration must identify the shell and the scope.
  // A bare PP12T somewhere on a sheet is never a project-wide default.
  if(!/(?:本表|本页|所有|全部|统一)/.test(s)||!/(?:主槽|槽体|内槽)/.test(s)||!/板厚|壁厚|厚度/.test(s)||/外封|外槽|保温|内衬|举例/.test(s))continue;
  const parsed=F.parameters(s,{scope:'tank'});if(parsed.issues.length||!F.MATERIALS[parsed.params.material]||!(parsed.params.thickness>0))continue;
  facts.push({field:'thickness',material:parsed.params.material,value:parsed.params.thickness,...evidence});
 }
 return facts;
}
function rowValues(row,source){
 const result=[];
 for(const entry of row.bom?.geometrySources?.flatMap(g=>g.values||[])||[]){
  if(norm(cell(source,entry.range))!==norm(entry.value)||!present(entry.value))continue;
  if(['material','dimensions'].includes(entry.field)){
   const parsed=F.parameters(entry.value,{scope:'tank'});if(parsed.issues.length)continue;
   const known=entry.parsed&&typeof entry.parsed==='object'?entry.parsed:parsed.params;
   for(const key of ['length','width','height','material','thickness'])if(present(known[key]))result.push({field:key,value:known[key],quote:text(entry.value),range:entry.range,source:source.filename+' / '+source.sheet});
  }else if(['length','width','height','thickness'].includes(entry.field)){
   const raw=text(entry.value),number=Number(raw),unit=text(entry.label),scale=/cm|厘米/i.test(unit)?10:/mm|毫米/i.test(unit)?1:/(?:\(m\)|米)/i.test(unit)?1000:1;
   if(raw&&Number.isFinite(number)&&number>0&&!/英寸|英尺|inch|feet/i.test(unit))result.push({field:entry.field,value:number*scale,quote:raw,range:entry.range,source:source.filename+' / '+source.sheet});
  }
 }
 return result;
}
function apply(q){
 const cache=new Map(),changes=[],conflicts=[];
 for(const row of q.rows||[]){
  if(row.kind==='requirement'||row.bom?.role==='requirement'||row.bom?.supplyStatus==='included'||row.selected===false||row.calculation||row.pricing?.mode==='manual'||present(row.override)||present(row.basePrice)||row.quantityEdited||row.repairEvidence?.length||row.parameterConflicts?.length||row.geometry?.dimensionIssue)continue;
  const ctx=context(q,row);if(!ctx)continue;
  if(!cache.has(ctx.source))cache.set(ctx.source,scopedFacts(ctx.source));
  const known=F.parameters(row.spec,{scope:'tank'});if(known.issues.length)continue;
  const tank=row.bom?.role==='tank',material=known.params.material||row.geometry?.material;
  const candidates=[...(tank?rowValues(row,ctx.source):[]),...cache.get(ctx.source).filter(f=>f.field==='brand'?devices.find(d=>d[0]===f.device)?.[1].test(row.name||''):tank&&f.material===material)];
  for(const field of tank?['length','width','height','material','thickness','brand']:['brand']){
   if(present(field==='brand'?row.brand:known.params[field]??row.geometry?.[field])||row.sourceFacts?.some(f=>f.field===field))continue;
   const found=candidates.filter(f=>f.field===field);if(!found.length)continue;
   const values=[...new Set(found.map(f=>f.value))];
   if(values.length!==1){conflicts.push({rowId:row.id,field,evidence:found,message:(F.LABELS[field]||'品牌')+'有不同来源值，需核对'});continue;}
   const value=values[0];if(field==='thickness'&&value>=Math.min(known.params.length||Infinity,known.params.width||Infinity,known.params.height||Infinity)/2)continue;
   if(field==='brand')row.brand=value;
   else{
    const label=F.LABELS[field]?.split('（')[0]||field,addition=field==='material'?'材质 '+value:label+value+'mm';
    F.edit(row,'spec',[row.spec,addition].filter(Boolean).join('\n'));row.geometry={...(row.geometry||known.params),[field]:value};known.params[field]=value;
   }
   const record={field,value,evidence:found,version:VERSION};row.sourceFacts=[...(row.sourceFacts||[]),record];changes.push({rowId:row.id,...record});delete row.knowledgeEvidence;delete row.linkedPriceMatch;
  }
 }
 if(changes.length||conflicts.length||q.sourceResolution)q.sourceResolution={version:VERSION,recovered:(q.rows||[]).flatMap(row=>(row.sourceFacts||[]).map(f=>({rowId:row.id,...f}))),conflicts};
 return {quote:q,changes,conflicts};
}
root.QuoteSourceFacts={VERSION,apply,context,scopedFacts,cell,notes};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteSourceFacts;
})(typeof window!=='undefined'?window:globalThis);
