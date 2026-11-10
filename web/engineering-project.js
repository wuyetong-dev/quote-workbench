(function(root){
'use strict';
const M=typeof module!=='undefined'&&module.exports?require('./model.js'):root.QuoteModel;
const text=v=>String(v??'').normalize('NFKC').trim();
const norm=v=>text(v).replace(/\s+/g,'').toLowerCase();
const copy=value=>structuredClone(value);
const VERSION='2026-11-07.engineering-project.1';
function id(value){let a=2166136261;for(const c of String(value)){a^=c.charCodeAt(0);a=Math.imul(a,16777619);}return 'eng-'+(a>>>0).toString(16);}
function station(row){return text(row.bom?.stationNumber||row.stationNumber||row.bom?.serviceStations?.join(',')||row.subgroup||'');}
function family(row){return text(row.bom?.deviceFamily||row.bom?.device||row.decomposition?.deviceFamily||row.name);}
function evidence(row){
 const ranges=row.bom?.sourceRanges||row.bom?.sources||[];
 return {sourceIds:row.sourceIds||[],source:row.source||'',row:row.sourceRow||null,ranges:copy(ranges),quantity:copy(row.bom?.quantityEvidence||row.quantityBasis||row.bom?.quantityBasis||null)};
}
function attach(quote){
 const objects=[],relations=[];
 for(const row of quote.rows||[]){
  // Existing row IDs remain the editing/persistence authority. Engineering IDs
  // are derived provenance identities; matching alone never invents quantity.
  row.engineeringId??=id(JSON.stringify([row.sourceDocumentId||'',row.source||row.id,row.sourceRow||'',row.bom?.configurationId||'',family(row),row.scope||'',row.bom?.parentId||'']));
  objects.push({id:row.id,engineeringId:row.engineeringId,deviceFamily:family(row),station:station(row),role:M.isRequirement(row)?'requirement':M.isIncluded(row)?'included':'component',evidence:evidence(row)});
  const parent=row.parentId||row.bom?.parentId;
  if(parent)relations.push({type:M.isIncluded(row)?'included':'accessory',from:parent,to:row.id});
  const served=row.bom?.serviceStations||[];
  for(const s of served)relations.push({type:'serves',from:row.id,to:String(s)});
 }
 quote.engineering={version:VERSION,objects,relations};
 return quote;
}
function sourceIdentity(source){return source.documentId?source.documentId+'|'+(source.sheet||'pages'):JSON.stringify([source.filename,source.sheet,source.rows,source.pages?.map(p=>[p.text,p.source])]);}
function merge(target,incoming){
 const out=copy(target),added=[],duplicates=[];
 if(!text(out.customer)&&text(incoming.customer))out.customer=incoming.customer;
 out.rows??=[];out.sources??=[];out.documents??=[];
 const knownDocs=new Set(out.documents.map(d=>d.id));
 const docs=incoming.documents||[];
 if(docs.length&&docs.every(d=>knownDocs.has(d.id)))return {quote:out,added:[],duplicates:[],alreadyImported:true};
 const sourceKeys=new Set(out.sources.map(sourceIdentity));
 for(const source of incoming.sources||[]){const key=sourceIdentity(source);if(!sourceKeys.has(key)){out.sources.push(copy(source));sourceKeys.add(key);}}
 for(const doc of docs)if(!knownDocs.has(doc.id)){out.documents.push(copy(doc));knownDocs.add(doc.id);}
 const occupied=new Set(out.rows.map(r=>r.id)),aliases=new Map();
 for(const row of incoming.rows||[]){const next=copy(row),oldId=next.id;if(occupied.has(next.id))next.id=M.uid();aliases.set(oldId,next.id);occupied.add(next.id);added.push(next);}
 for(const row of added){
  if(aliases.has(row.parentId))row.parentId=aliases.get(row.parentId);
  if(aliases.has(row.bom?.parentId))row.bom.parentId=aliases.get(row.bom.parentId);
  // Only an explicit station + same device at that station can be a duplicate
  // candidate across documents. Equal specifications alone never mean shared.
  const at=station(row),prior=at&&!M.isRequirement(row)?out.rows.find(r=>!M.isRequirement(r)&&station(r)===at&&norm(family(r))===norm(family(row))&&norm(r.name)===norm(row.name)):null;
  if(prior&&row.sourceDocumentId&&prior.sourceDocumentId&&row.sourceDocumentId!==prior.sourceDocumentId){
   row.duplicateReview={of:prior.id,status:'pending',reason:'两份资料描述同工位同类设备，需确认是否同一供货对象',specConflict:norm(row.spec)!==norm(prior.spec),originalSelected:row.selected!==false};
   row.selected=false;duplicates.push(row.id);
  }
  out.rows.push(row);
 }
 out.warnings=[...new Set([...(out.warnings||[]),...(incoming.warnings||[])])];
 out.updatedAt=new Date().toISOString();out.priceReviewPending=true;delete out.deliveryConfirmation;
 attach(out);return {quote:out,added:added.map(r=>r.id),duplicates,alreadyImported:false};
}
function mergeDuplicate(quote,rowId){
 const row=quote.rows.find(r=>r.id===rowId),prior=quote.rows.find(r=>r.id===row?.duplicateReview?.of);
 if(!row||!prior)throw Error('待合并设备已经变化，请重新核对');
 if(row.duplicateReview.specConflict)throw Error('两份资料规格不同，请先确认报价值，或确认为不同设备');
 prior.additionalEvidence=[...(prior.additionalEvidence||[]),evidence(row),...(row.additionalEvidence||[])];
 row.duplicateReview.status='merged';row.selected=false;
 row.parentId=prior.id;row.bom={...row.bom,role:'included',supplyStatus:'included',parentId:prior.id,confirmed:true};
 attach(quote);return quote;
}
function distinct(quote,rowId){const row=quote.rows.find(r=>r.id===rowId);if(!row?.duplicateReview)return quote;row.duplicateReview.status='distinct';row.selected=row.duplicateReview.originalSelected;attach(quote);return quote;}
function issues(quote){
 const out=[],rows=quote.rows||[],byId=new Map(rows.map(r=>[r.id,r]));
 for(const source of quote.sources||[]){
  if(source.type==='unmapped')out.push({id:'mapping:'+sourceIdentity(source),type:'mapping',message:'工序或字段尚未识别',source:source.filename});
  for(const page of source.pages||[])if((page.recognitionStatus==='pending'||(!text(page.text)&&page.image))&&!(page.manualReview?.confirmedAt&&text(page.manualReview.reason)))out.push({id:'page:'+sourceIdentity(source)+page.id,type:'recognition',sourceIndex:quote.sources.indexOf(source),pageId:page.id,message:page.recognitionError||'该页图片文字尚未识别',source:page.source});
 }
 for(const row of rows){
  if(row.decomposition?.reviewState==='pending')out.push({id:'ai-scope:'+row.id,type:'scope',rowId:row.id,message:'候选设备的供货及计价关系待确认：'+(row.decomposition.missing||[]).join('；')});
  if(row.duplicateReview?.status==='pending')out.push({id:'duplicate:'+row.id,type:row.duplicateReview.specConflict?'spec_conflict':'duplicate',rowId:row.id,message:row.duplicateReview.reason});
  const parent=row.parentId||row.bom?.parentId;
  if(parent&&!byId.has(parent))out.push({id:'parent:'+row.id,type:'relationship',rowId:row.id,message:'所属主项已不存在，请重新确定包含范围'});
  const seen=new Set([row.id]);let at=parent;
  while(at&&byId.has(at)){if(seen.has(at)){out.push({id:'cycle:'+row.id,type:'relationship',rowId:row.id,message:'部件包含关系形成循环，请重新确定主项'});break;}seen.add(at);const p=byId.get(at);at=p.parentId||p.bom?.parentId;}
 }
 const state=quote.aiTask?.status;
 if(['queued','running','partial','failed','interrupted','key_required'].includes(state)&&(!quote.aiTask.manualReview?.confirmedAt||!text(quote.aiTask.manualReview.reason)||['queued','running'].includes(state)))out.push({id:'ai:'+quote.aiTask.jobId,type:'ai',message:['queued','running'].includes(state)?'复杂资料仍在补查':state==='key_required'?'图片或复杂资料补查需要配置DeepSeek':state==='partial'?'部分资料补查未完成，可继续未完成部分':'资料补查尚未完成',jobId:quote.aiTask.jobId});
 return out;
}
root.EngineeringProject={VERSION,attach,merge,mergeDuplicate,distinct,issues,evidence};
if(typeof module!=='undefined'&&module.exports)module.exports=root.EngineeringProject;
})(typeof window!=='undefined'?window:globalThis);
