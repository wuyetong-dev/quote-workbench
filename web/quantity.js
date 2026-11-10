(function(root){
'use strict';
// L1 contract: recover quantities from owned source evidence for arbitrary
// imported tables. Never transfer an old project's counts or guess one unit.
// Consumers: autoPrice, automation and grounded AI enrichment; no new UI/store.
const node=typeof module!=='undefined'&&module.exports,S=node?require('./source-facts.js'):root.QuoteSourceFacts;
const text=v=>String(v??'').normalize('NFKC').trim(),compact=v=>text(v).replace(/\s/g,''),escape=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e12;
const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
const NUM='(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千]+)';
const uncertain=/待定|待确认|可选|建议|暂按|例如|或者|二选一|另配|自备|甲供|不含|无需|不需要|不配置/;
function number(value){
 const s=compact(value);if(/^\d+(?:\.\d+)?$/.test(s)){const n=Number(s);return valid(n)?n:null;}
 if(!/^[零〇一二两三四五六七八九十百千]+$/.test(s))return null;
 if([...s].every(c=>c in digits))return s.length===1?digits[s]:null;
 if(/[一二两三四五六七八九]{2}|[百千][一二两三四五六七八九]$/.test(s))return null;
 let total=0,last=0,scale=Infinity;for(const c of s){if(c in digits){last=digits[c];continue;}const unit={十:10,百:100,千:1000}[c];if(unit>=scale)return null;total+=(last||1)*unit;last=0;scale=unit;}return total+last;
}
function names(row){return [...new Set([text(row.name)].filter(Boolean))];}
function literal(value,unit,{bare=false}={}){
 const s=compact(value);if(uncertain.test(s)||!unit)return null;
 const m=s.match(new RegExp('^(?:数量[:：=]?)?('+NUM+')'+(bare?'(?:'+escape(compact(unit))+')?':escape(compact(unit)))+'$'));
 return m?number(m[1]):null;
}
function named(value,row){
 const s=text(value),unit=compact(row.unit);if(!unit||uncertain.test(s))return null;
 const counts=[];
 for(const name of names(row)){
  // Do not let a physical count under 每槽/每台 masquerade as a total count.
  const re=new RegExp(escape(name)+parameterGap()+'('+NUM+')\\s*'+escape(unit)+'(?![\\dA-Za-z./]|型|号)','gi');
  const before=new RegExp('(?<![\\dA-Za-z.])('+NUM+')\\s*'+escape(unit)+'(?![\\dA-Za-z./]|型|号)'+parameterGap()+escape(name),'gi');
  for(const m of [...s.matchAll(re),...s.matchAll(before)]){
   if(/每[^；;。\n]{0,40}$/.test(s.slice(0,m.index)))continue;
   const n=number(m[1]);if(n!=null)counts.push(n);
  }
 }
 return counts.length&&new Set(counts).size===1?counts[0]:null;
}
// Only complete engineering parameter tokens may separate the name and count.
// Arbitrary text would allow borrowing the next device's quantity.
function parameterGap(){return '(?:[\\s:：=（()）、，,共计数量总需为×*]|[/／|｜]\\s*数量|(?:功率|流量|型号)\\s*[:：=]?|[A-Za-z][A-Za-z0-9_-]*(?:[#型号]|\\s+)|\\d+(?:\\.\\d+)?\\s*(?:kW|W|T/H|m[³3]/h|L/min|A|V|Hz|mm|#|型|号)){0,24}?';}
function totals(q){
 const facts=[];
 for(const [sourceIndex,source] of (q.sources||[]).entries()){
  const rows=(q.rows||[]).filter(r=>!r.decomposition&&S.context(q,r)?.source===source);
  const identities=[...new Map(rows.filter(r=>r.unit&&r.bom?.role!=='tank').map(r=>[compact(r.rawName||r.name)+'|'+compact(r.unit),{...r,name:r.rawName||r.name}])).values()];
  for(const e of S.notes(source))for(const identity of identities){
   const value=named(e.quote,identity);if(value==null)continue;
   const targets=rows.filter(r=>compact(r.rawName||r.name)===compact(identity.name)&&compact(r.unit)===compact(identity.unit));
   const id=JSON.stringify([source.documentId||source.filename,source.sheet,e.range,identity.name,identity.unit]);
   if(facts.some(f=>f.id===id&&f.value===value))continue;
   const quantities=targets.map(r=>r.quantity),allocated=quantities.every(valid)?quantities.reduce((a,b)=>a+b,0):null;
   facts.push({id,sourceIndex,name:identity.name,unit:identity.unit,value,evidence:[e],rowIds:targets.map(r=>r.id),allocated,status:allocated===value?'allocated':allocated==null?'allocation_pending':'conflict'});
  }
 }
 q.quantityFacts=facts;return facts;
}
function tableCount(quotes,row,sourceMap){
 const found=[];
 for(const e of quotes){let header;
  for(const line of text(sourceMap.get(e.sourceId)?.text).split('\n')){
   if(!line.includes('|'))continue;
   const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(compact),qc=cells.findIndex(c=>/^(?:数量|供货数量|用量|台数)$/.test(c)),uc=cells.findIndex(c=>/^(?:单位|计量单位)$/.test(c)),nc=cells.findIndex(c=>/^(?:名称|设备名称|产品名称|品名|项目名称)$/.test(c));
   if(qc>=0&&uc>=0&&nc>=0){header={qc,uc,nc,size:cells.length};continue;}
   if(!header||header.size!==cells.length||!compact(line).includes(compact(e.quote)))continue;
   const {qc:q,uc:u,nc:n}=header;if(cells[n]!==compact(row.name)||cells[u]!==compact(row.unit))continue;
   const count=number(cells[q]);if(count!=null)found.push(count);
  }
 }
 return found.length&&new Set(found).size===1?found[0]:null;
}
function eligible(row){return row.kind!=='requirement'&&row.bom?.role!=='requirement'&&row.bom?.supplyStatus!=='included'&&row.decomposition?.relationship!=='included'&&row.selected!==false&&!row.quantityEdited;}
function evidence(q,row){
 const ctx=S.context(q,row);if(!ctx)return [];
 const fields=row.bom?.fieldSources||[],ranges=new Set(row.bom?.sourceRanges||[]),out=[];
 // Flat quotation tables already retain each original column in row.fields.
 // Read only an explicit count column with the matching original unit.
 const unitField=(row.fields||[]).find(f=>/^(?:单位|计量单位)$/.test(compact(f.label)));
 if(!unitField||compact(S.cell(ctx.source,unitField.range))===compact(row.unit))for(const f of row.fields||[]){
  const quantity=/^(?:数量|供货数量|用量|台数)$/.test(compact(f.label));
  if(!quantity&&!/^(?:规格|规格型号|配置|技术参数|说明|备注)$/.test(compact(f.label)))continue;
  const raw=S.cell(ctx.source,f.range);if(raw!==undefined&&compact(raw)===compact(f.value))out.push({quote:text(raw),range:f.range,field:quantity?'quantity':'spec',source:row.source,owned:quantity});
 }
 for(const f of fields){
  if(f.blocked||!ranges.has(f.range))continue;
  const raw=S.cell(ctx.source,f.range);if(raw===undefined||compact(raw)!==compact(f.raw??f.value))continue;
  out.push({quote:text(raw),range:f.range,field:f.field,label:f.label||'',source:row.source,owned:true});
 }
 for(const f of row.bom?.quantityEvidence||[]){if(!ranges.has(f.range)||out.some(e=>e.range===f.range))continue;const raw=S.cell(ctx.source,f.range);if(raw!==undefined&&compact(raw)===compact(f.value))out.push({quote:text(raw),range:f.range,field:'quantity',source:row.source,owned:true});}
 // Explicit equipment + count text in the row's own source cells. Never read
 // the whole neighbouring station row or a price-history row as its count.
 for(const range of ranges){if(out.some(e=>e.range===range))continue;const raw=S.cell(ctx.source,range);if(raw!==undefined)out.push({quote:text(raw),range,source:row.source});}
 return out;
}
function relation(value,row,parent){
 const s=text(value),unit=compact(row.unit);if(!unit||!parent||uncertain.test(s))return null;
 const parentNames=[text(parent.name),...((parent.bom?.role==='tank'||parent.pricing?.rule==='tank')&&compact(parent.unit)==='个'?['槽']:[])].filter(Boolean);
 for(const p of parentNames)for(const name of names(row)){
  const count='('+NUM+')\\s*'+escape(unit),device=escape(name),owner='每(?:个|台|套)?'+escape(p)+'\\s*(?:配置|配备|配|安装|设有|设置|设|装|需)?\\s*';
  const match=s.match(new RegExp(owner+'(?:'+device+'\\s*'+count+'|'+count+'\\s*'+device+')'));
  if(match){const n=number(match[1]||match[2]);if(n!=null)return n;}
 }
 return null;
}
function collect(q,row){
 const found=[],parent=q.rows.find(r=>r.id===(row.parentId||row.bom?.parentId||row.business?.parentId)),ctx=S.context(q,row);
 const canRelate=parent&&valid(parent.quantity)&&row.bom?.role!=='shared'&&row.decomposition?.relationship!=='shared'&&!(row.bom?.relatedParentIds?.length>1);
 for(const e of evidence(q,row)){
  const n=e.owned?literal(e.quote,row.unit,{bare:e.field==='quantity'}):null,explicit=n??named(e.quote,row);
  if(explicit!=null)found.push({value:explicit,kind:'source',evidence:[e]});
  const ratio=canRelate?relation(e.quote,row,parent):null;if(ratio!=null)found.push({value:ratio*parent.quantity,kind:'per_parent',parentId:parent.id,multiplier:ratio,evidence:[e]});
 }
 if(ctx&&canRelate)for(const e of S.notes(ctx.source)){
  const ratio=relation(e.quote,row,parent);if(ratio!=null)found.push({value:ratio*parent.quantity,kind:'per_parent',parentId:parent.id,multiplier:ratio,evidence:[e]});
 }
 return found.filter(f=>valid(f.value));
}
function stamp(row){return JSON.stringify([row.name,row.unit,row.source,row.sourceDocumentId,row.sourceRow,row.parentId||row.bom?.parentId,row.bom?.sourceRanges,row.bom?.fieldSources]);}
function apply(q){
 const changes=[],conflicts=[];
 const facts=totals(q);
 for(const row of q.rows||[]){
  if(!eligible(row))continue;
  const prior=row.quantityResolution,linked=prior?.kind==='per_parent'&&row.quantity===prior.value;
  if(row.quantity!=null&&!linked)continue;
  const found=collect(q,row);
  for(const fact of facts.filter(f=>f.rowIds.length===1&&f.rowIds[0]===row.id))found.push({value:fact.value,kind:'source',evidence:fact.evidence});
  const values=[...new Set(found.map(f=>f.value))];
  if(values.length!==1){
   if(linked){row.quantity=null;delete row.quantityResolution;changes.push({rowId:row.id,type:'quantity',value:null});}
   if(values.length>1)conflicts.push({rowId:row.id,evidence:found,message:'同一设备存在不同数量依据'});
   if(values.length>1){row.quantityConflicts=found;row.bom??={};row.bom.quantityBasis='原表有不同数量依据：'+found.flatMap(f=>f.evidence.map(e=>e.quote)).join('；');}
   continue;
  }
  const proof=found.find(f=>f.kind==='source')||found[0],changed=row.quantity!==proof.value;
  row.quantity=proof.value;row.quantityResolution={...proof,stamp:stamp(row),provider:'local',version:1};
  delete row.quantityConflicts;
  row.bom??={};row.bom.quantityBasis=proof.kind==='per_parent'?'原文明确每主项配置'+proof.multiplier+row.unit+' × 主项数量；'+proof.evidence.map(e=>e.quote).join('；'):'原表明确数量：'+proof.evidence.map(e=>e.quote).join('；');
  // bom may have been created for an imported flat row.
  row.quantityResolution.stamp=stamp(row);
  if(changed)changes.push({rowId:row.id,type:'quantity',value:row.quantity});
 }
 totals(q);return {changes,conflicts};
}
function applyAI(q,row,item,match,sourceMap,provider){
 if(!eligible(row)||row.quantity!=null||item.intent!=='enrich_existing'||item.targetExistingId!==row.id||match.quantityComparable===false||!['existing_device','verified_enrichment'].includes(match.kind)||compact(item.unit)!==compact(row.unit)||!valid(item.quantity))return false;
 const quotes=(item.evidence||[]).filter(e=>match.sourceIds.includes(e.sourceId)&&text(e.quote)&&text(sourceMap.get(e.sourceId)?.text).includes(text(e.quote)));
 // Server validation alone is insufficient: re-check ownership in the current
 // draft, including in-flight manual edits and candidates for another device.
 const counts=[...new Set(quotes.map(e=>named(e.quote,row)).filter(n=>n!=null))],table=tableCount(quotes,row,sourceMap);
 if(compact(item.name)!==compact(row.name)||counts.some(n=>n!==item.quantity)||table!=null&&table!==item.quantity||!counts.length&&table!==item.quantity)return false;
 const owned=collect(q,row);if(owned.some(f=>f.value!==item.quantity))return false;
 row.quantity=item.quantity;row.quantityResolution={kind:'source',value:item.quantity,provider,evidence:quotes,version:1,stamp:stamp(row)};
 row.bom??={};row.bom.quantityBasis='AI补查原文数量：'+quotes.map(e=>e.quote).join('；');return true;
}
root.QuoteQuantity={apply,applyAI,number,literal,named,relation,evidence,collect,stamp,tableCount,totals};if(node)module.exports=root.QuoteQuantity;
})(typeof window!=='undefined'?window:globalThis);
