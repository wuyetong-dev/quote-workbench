(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports;
const F=node?require('./formulas.js'):root.QuoteFormulas,M=node?require('./model.js'):root.QuoteModel,S=node?require('./source-facts.js'):root.QuoteSourceFacts,D=node?require('./decomposition.js'):root.QuoteDecomposition;
const VERSION='2026-11-07.parameters.1',dims=['length','width','height','thickness'],keys=[...dims,'material'];
const text=v=>String(v??'').trim();
const editable=r=>r.selected!==false&&!M.isRequirement(r)&&!M.isIncluded(r)&&!r.calculation&&r.override==null&&r.pricing?.mode!=='manual'&&M.number(r.basePrice)===null&&!r.parameterConflicts?.length&&!r.geometry?.dimensionIssue;
function stamp(row){return JSON.stringify([row.name,row.spec,row.geometry,row.brand,row.quantity,row.quantityEdited,row.override,row.basePrice,row.pricing?.mode,row.repairEvidence,row.sourceFacts]);}
function cells(q,row){
 const context=S.context(q,row);if(!context)return [];
 const entries=(row.bom?.geometrySources||[]).flatMap(g=>g.values||[]),out=[];
 for(const e of entries){
  const a=text(e.range).match(/!([A-Z]+)(\d+)(?::|$)/);if(!a)continue;let col=0;for(const c of a[1])col=col*26+c.charCodeAt(0)-64;
  const original=text(context.source.rows?.[Number(a[2])-1]?.[col-1]);if(original!==text(e.value)||!original)continue;
  // Only the body portion of a layered cell may prove a body parameter.
  const body=F.tankParameters(original).layers.filter(l=>l.role==='body').map(l=>original.slice(l.start,l.end).trim()).join('\n');if(!body)continue;
  const fields=dims.includes(e.field)?[e.field]:['material','dimensions'].includes(e.field)?keys:[];
  if(!fields.length)continue;
  const unit=text(e.label).match(/mm|毫米|cm|厘米|(?:\(|（)m(?:\)|）)|米/i)?.[0]?.replace(/[()（）]/g,'')||'mm';
  out.push({id:e.range,text:body,fields,unit,range:e.range,source:context.source.filename+' / '+context.source.sheet});
 }
 for(const e of row.bom?.fieldSources||[])if(/品牌|厂家|制造商|生产商/.test(e.label||''))out.push({id:e.range,text:text(e.raw??e.value),fields:['brand'],range:e.range,source:row.source});
 return [...new Map(out.map(c=>[c.id,c])).values()];
}
function request(q){
 const fragments=D.fragments(q),requests=[];
 for(const row of q.rows||[]){
  if(!editable(row))continue;
  const tank=row.bom?.role==='tank',parsed=F.tankParameters(row.spec);if(parsed.issues.length)continue;
  const known={...row.geometry,...parsed.params};
  const candidates=cells(q,row);if(!candidates.length)continue;
  let missing=tank?keys.filter(k=>k==='material'?!F.MATERIALS[known[k]]:!(known[k]>0)):[];
  if(!text(row.brand)&&candidates.some(c=>c.fields.includes('brand')))missing.push('brand');
  // Linked geometry needs an explicit structural relation, not a guessed product.
  if(/(?:[二两三四五六七八九十\d]+)[联连]/.test(row.name||''))missing=missing.filter(k=>!['length','width','height'].includes(k));
  missing=missing.filter(k=>candidates.some(c=>c.fields.includes(k)&&(k==='thickness'?c.fields.length===1||/厚|壁|T(?![A-Za-z])/i.test(c.text):k==='material'?/[A-Za-z\u4e00-\u9fff]/.test(c.text):k==='brand'?Boolean(c.text):/[\d一二三四五六七八九十百千]/.test(c.text))));
  if(!missing.length)continue;
  const context=S.context(q,row),si=q.sources.indexOf(context.source),ids=new Set(candidates.map(c=>c.range?.match(/![A-Z]+(\d+)/)?.[1]).filter(Boolean).map(n=>'s'+si+':r'+n));
  const sourceRows=fragments.filter(f=>ids.has(f.id));if(!sourceRows.length)continue;
  const item={id:row.id,stamp:stamp(row),fields:missing,known:Object.fromEntries(keys.map(k=>[k,missing.includes(k)?null:known[k]??null])),cells:candidates,text:sourceRows.map(f=>f.text).join('\n'),sourceIds:sourceRows.map(f=>f.id)};if(JSON.stringify(item).length<=32000)requests.push(item);
 }
 const ids=new Set(requests.flatMap(r=>r.sourceIds));return {version:VERSION,mode:'parameters',quoteId:q.id,fragments:fragments.filter(f=>ids.has(f.id)),parameterRequests:requests};
}
function apply(q,result){
 const prepared=request(q),byId=new Map(prepared.parameterRequests.map(r=>[r.id,r]));
 const draft={...q,rows:[...q.rows]},states=[];let count=0;
 for(const item of result.parameterUpdates||[]){
  const index=q.rows.findIndex(r=>r.id===item.id),original=q.rows[index],current=byId.get(item.id);
  if(original?.parameterRecognition?.appliedStamp===item.stamp)continue;
  if(!current||current.stamp!==item.stamp||!editable(original)){states.push({id:item.id,status:'changed',message:'此项已修改，未覆盖当前输入'});continue;}
  const values={};for(const field of current.fields){const value=item.values?.[field],e=item.evidence?.[field],cell=current.cells.find(c=>c.id===e?.cellId);if(value==null||!cell||!cell.fields.includes(field)||!e.quote||!cell.text.includes(e.quote)||!e.token||!e.quote.includes(e.token))continue;if(field==='material'&&!F.MATERIALS[value]||dims.includes(field)&&(!(value>0)||!Number.isFinite(value)))continue;values[field]=value;}
  if(!Object.keys(values).length){states.push({id:item.id,status:item.failed?'failed':'unresolved',fields:current.fields});continue;}
  const {knowledgeEvidence,linkedPriceMatch,...business}=original,row=structuredClone(business),geometry={...row.geometry,...F.tankParameters(row.spec).params,...values};
  if(geometry.thickness>=Math.min(geometry.length||Infinity,geometry.width||Infinity,geometry.height||Infinity)/2){states.push({id:item.id,status:'unresolved',message:'板厚与尺寸关系需核对'});continue;}
  const additions=Object.entries(values).filter(([f])=>f!=='brand').map(([f,v])=>f==='material'?'材质 '+v:(f==='thickness'?'板厚':F.LABELS[f].split('（')[0])+v+'mm');
  if(additions.length){F.edit(row,'spec',[row.spec,'主体参数：'+additions.join(' ')].filter(Boolean).join('\n'));row.geometry={...row.geometry,...Object.fromEntries(Object.entries(values).filter(([f])=>f!=='brand'))};}
  if(values.brand)F.edit(row,'brand',values.brand);
  if(F.tankParameters(row.spec).issues.length){states.push({id:item.id,status:'unresolved',message:'规整值与原规格冲突，未应用'});continue;}
  row.sourceFacts=[...(row.sourceFacts||[]),...Object.entries(values).map(([field,value])=>({field,value,version:VERSION,provider:'DeepSeek',evidence:[{...item.evidence[field],quote:item.evidence[field].quote}]}))];
  row.parameterRecognition={version:VERSION,appliedStamp:item.stamp,fields:Object.keys(values),unresolved:current.fields.filter(f=>!(f in values))};draft.rows[index]=row;count+=Object.keys(values).length;states.push({id:item.id,status:'applied',fields:Object.keys(values)});
 }
 draft.parameterRecognition={version:VERSION,states};if(count){draft.rows=draft.rows.map((r,i)=>{if(r!==q.rows[i])return r;const {knowledgeEvidence,linkedPriceMatch,...business}=r;return structuredClone(business);});M.autoPrice(draft);}return {quote:draft,count};
}
root.QuoteParameterParser={VERSION,request,apply,stamp};if(node)module.exports=root.QuoteParameterParser;
})(typeof window!=='undefined'?window:globalThis);
