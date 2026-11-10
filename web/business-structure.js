(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const VERSION='2026-11-06.business.2';
const CHAPTERS=[{chapterNo:1,chapterTitle:'一、自动龙门行车部分'},{chapterNo:2,chapterTitle:'二、机架部分'},{chapterNo:3,chapterTitle:'三、电气控制部分'},{chapterNo:4,chapterTitle:'四、槽体部分'},{chapterNo:5,chapterTitle:'五、周边配置部分'}];
const text=v=>String(v??'').trim(),copy=v=>structuredClone(v),requirement=r=>r.kind==='requirement'||r.bom?.role==='requirement';
const parentOf=r=>r.parentId||r.bom?.parentId||null;
function safeName(value){return text(value).replace(/[（(]\s*第\s*\d+\s*行(?:起)?\s*[）)]/g,'').replace(/第\s*\d+\s*行(?:起)?/g,'').replace(/[^\s/\\]*\.(?:xlsx?|csv|pdf)\b/gi,'').replace(/\s*[/／]\s*(?:Sheet\s*\d+|工作表\s*\d+)\b/gi,'').trim();}
function addRequirement(row,value,kind='source_note',ranges){
 const content=text(value);if(!content)return;
 row.engineeringRequirements=row.engineeringRequirements||[];
 if(!row.engineeringRequirements.some(item=>text(typeof item==='string'?item:item.text)===content))row.engineeringRequirements.push({kind,text:content,source:row.source||'',sourceRanges:copy(ranges||row.bom?.sourceRanges||[])});
}
function customerSpec(row,value,record=true){
 const out=[],remember=(line,kind)=>{if(record)addRequirement(row,line,kind);};
 for(const original of text(value).split(/\r?\n/)){
  let line=original.trim();if(!line)continue;
  if(/^本次确认：\d+节；单节 .+；采购数量按组；/.test(line))continue;
  if(requirement(row)){remember(original,'engineering_requirement');continue;}
  if(/^原表功能要求[:：]/.test(line)){remember(original,'functional_requirement');continue;}
  const member=line.match(/^第\s*(\d+)\s*行[:：]\s*(.+)$/),memberIndex=member?(row.bom?.memberGeometry||[]).findIndex(g=>Number(g.row)===Number(member[1])):-1;
  if(member&&memberIndex>=0){remember(original,'source_structure');line='工位'+(memberIndex+1)+'：'+member[2];}
  if(/原表(?:材质|尺寸)与结构[（(]/.test(line)){remember(original,'source_structure');line=line.replace(/^.*?[）)]\s*[:：]/,'');}
  else if(/原表|第\s*\d+\s*行|\bSheet\s*\d+\s*!|[A-Z]+\d+:[A-Z]+\d+|无独立.*数量|工位数.*不一致/.test(line)){remember(original,'source_note');if(/^\d+联槽/.test(line))out.push(line.match(/^\d+联槽/)[0]+'；尺寸为单工位内尺寸');continue;}
  if(/(?:待确认|需确认|待补|需核对)/.test(line)){remember(original,'unresolved_condition');line=line.split(/[；;]/).filter(part=>!/(?:待确认|需确认|待补|需核对)/.test(part)).join('；');}
  if(/主槽\//.test(line)||/[：:]\s*[√✓✔×✕]\s*(?:$|[；;])/.test(line)){
   remember(original,'engineering_requirement');
   const details=[];
   for(const part of line.split(/[；;]/)){
    const structural=part.match(/(?:^|\/)(保温|外槽|内衬|隔板|槽盖)\s*[:：]\s*(.+)$/);
    if(structural&&!/^[√✓✔×✕]$/.test(structural[2].trim()))details.push(structural[1]+'：'+structural[2].trim());
    else if(/(?:保温|槽盖|内衬|隔板)\s*[:：]\s*[√✓✔]/.test(part))details.push((part.match(/保温|槽盖|内衬|隔板/)||[''])[0]+'结构');
    else if(/(?:热水加|蒸汽|电加热)\s*[:：]\s*[√✓✔]/.test(part))details.push(/热水加/.test(part)?'热水加热':/蒸汽/.test(part)?'蒸汽加热':'电加热');
    else if(!/[√✓✔×✕]|主槽\//.test(part)&&part.trim())details.push(part.trim());
   }
   line=details.join('；');
  }
  line=safeName(line);if(line&&!out.includes(line))out.push(line);
 }
 if(!record&&row.assemblyResolution&&row.pricing?.mode==='assembly'&&row.pricing?.price!=null){const a=row.assemblyResolution,g=row.bom?.memberGeometry?.[0];if(g)out.push('本次确认：'+a.chambers+'节；单节 '+[g.length,g.width,g.height].join('×')+'mm；采购数量按组；'+(row.pricing.method==='stations'?'按各节槽体主体价相加':'采用已确认联槽计价口径'));}
 return out.join('\n');
}
function defaultChapter(row){
 const combined=[row.group,row.name].map(text).join(' ');
 if(row.bom?.role==='tank')return row.bom.shared||/管理槽/.test(row.name)?5:4;
 if(/行车|龙门/.test(combined)&&!/轨道|机架|电气|控制/.test(combined))return 1;
 if(/机架|骨架|轨道|框架/.test(combined))return 2;
 if(/电气|电控|控制柜|主控/.test(combined))return 3;
 if(/槽体|槽体及配置/.test(row.group||''))return 4;
 return 5;
}
function attach(q){
 const rows=q.rows||[],byId=new Map(rows.map(row=>[row.id,row]));
 const chapters=q.decomposition?.chapters?.length?q.decomposition.chapters:CHAPTERS;
 for(const row of rows){
  const prior=F?.resolve?.(row);
  if(prior?.blocked&&!row.formulaBlocked){row.formulaBlocked=true;row.geometryIssue=prior.issues.join('；');}
  row.rawName??=row.name;row.rawSpec??=row.spec;row.rawGroup??=row.group;row.rawSubgroup??=row.subgroup||'';
  const scoped=F?.tankParameters?.(row.rawSpec||'');
  row.structureLayers=copy((scoped?.layers||[]).filter(layer=>layer.role!=='body'));
  const diagnostics=[...(scoped?.issues||[]),row.geometry?.dimensionIssue,...(row.bom?.memberGeometry||[]).map(g=>g.dimensionIssue)].filter(Boolean);
  row.parameterConflicts=[...new Set(diagnostics.flatMap(value=>text(value).split('；')).filter(message=>/不一致|多个值|冲突/.test(message)))];
  for(const issue of row.fieldIssues||[])addRequirement(row,issue.label+'：'+issue.value,'invalid_field',[issue.range]);
  row.name=safeName(row.name);const customer=customerSpec(row,row.spec);row.spec=row.bom?.supplyStatus==='pending'?row.rawSpec:customer;
  if(row.geometry){row.geometry.sourceSpecSuffix??=row.geometry.specSuffix||'';row.geometry.specSuffix=customerSpec(row,row.geometry.specSuffix);}
 }
 const chapterFor=(row,visited=new Set())=>{const own=()=>q.decomposition?chapters.find(c=>c.key===(row.decompositionSystem||row.rawGroup||row.group))?.chapterNo||chapters[0].chapterNo:defaultChapter(row);if(visited.has(row.id))return own();visited.add(row.id);const parent=byId.get(parentOf(row));return parent?chapterFor(parent,visited):own();};
 for(const row of rows){const chapterNo=chapterFor(row),chapterTitle=chapters.find(c=>c.chapterNo===chapterNo).chapterTitle;row.business={chapterNo,chapterTitle,code:'',customerCode:'',depth:0,parentId:parentOf(row),primary:!requirement(row)&&!byId.has(parentOf(row)),relatedParentIds:[...new Set([...(row.relatedParentIds||[]),...(row.bom?.relatedParentIds||[]),parentOf(row)].filter(Boolean))]};row.group=chapterTitle;row.subgroup=safeName(byId.get(parentOf(row))?.name||row.name);}
 const children=new Map();for(const row of rows){const id=parentOf(row);if(byId.has(id)){if(!children.has(id))children.set(id,[]);children.get(id).push(row);}}
 const ordered=[],visited=new Set(),counts=new Map(),requirementCounts=new Map(),independent=[];
 function visit(row,parent){
  if(visited.has(row.id))return;visited.add(row.id);const b=row.business;
  if(parent){const siblings=children.get(parent.id)||[],supplies=siblings.filter(v=>!requirement(v)),requests=siblings.filter(requirement);b.depth=parent.business.depth+1;b.code=parent.business.code+(requirement(row)?'.R'+String(requests.indexOf(row)+1).padStart(2,'0'):'.'+(supplies.indexOf(row)+1));if(!requirement(row)){if(requirement(parent)){independent.push(row);b.depth=0;b.primary=true;}else b.customerCode=b.code;}}
  else if(requirement(row)){const n=(requirementCounts.get(b.chapterNo)||0)+1;requirementCounts.set(b.chapterNo,n);b.code=b.chapterNo+'-R'+String(n).padStart(2,'0');}
  else {const n=(counts.get(b.chapterNo)||0)+1;counts.set(b.chapterNo,n);b.code=b.chapterNo+'-'+String(n).padStart(2,'0');b.customerCode=b.code;}
  ordered.push(row);for(const child of children.get(row.id)||[])visit(child,row);
 }
 for(const chapter of chapters)for(const row of rows.filter(v=>v.business.chapterNo===chapter.chapterNo&&!byId.has(parentOf(v))))visit(row);
 for(const row of rows)visit(row);
 // A supplied accessory cannot borrow a customer number from an unpriced
 // process requirement. Append its own chapter number without renumbering
 // the established tank mains; retain the parent solely as named provenance.
 for(const row of independent){const b=row.business,old=b.code,n=(counts.get(b.chapterNo)||0)+1;counts.set(b.chapterNo,n);b.code=b.customerCode=b.chapterNo+'-'+String(n).padStart(2,'0');for(const child of ordered)if(child!==row&&child.business.code.startsWith(old+'.')){child.business.code=b.code+child.business.code.slice(old.length);if(!requirement(child))child.business.customerCode=child.business.code;}ordered.splice(ordered.indexOf(row),1);const next=ordered.findIndex(r=>r.business.chapterNo>b.chapterNo);ordered.splice(next<0?ordered.length:next,0,row);}
 q.businessStructure={version:VERSION,chapters:chapters.map(c=>({...c,rowIds:ordered.filter(r=>r.business.chapterNo===c.chapterNo).map(r=>r.id)})),order:ordered.map(r=>r.id)};
 return q;
}
function view(q,{includeRequirements=false}={}){
 const model=q.businessStructure&&q.rows?.every(row=>row.business)?q:attach(copy(q)),byId=new Map((model.rows||[]).map(row=>[row.id,row]));
 const orderedRows=(model.businessStructure?.order||model.rows.map(row=>row.id)).map(id=>byId.get(id)).filter(row=>row&&(includeRequirements||!requirement(row)));
 const sections=(model.businessStructure?.chapters||CHAPTERS).map(chapter=>({...chapter,title:chapter.chapterTitle,rows:orderedRows.filter(row=>row.business.chapterNo===chapter.chapterNo)}));
 return {sections,orderedRows};
}
function exportFor(row){const b=row.business||{},chapterNo=b.chapterNo||defaultChapter(row),chapterTitle=b.chapterTitle||CHAPTERS.find(c=>c.chapterNo===chapterNo).chapterTitle;return {name:safeName(row.name),spec:customerSpec(row,row.spec,false),group:chapterTitle,code:b.customerCode||'',chapterNo,chapterTitle,depth:b.depth||0,parentId:b.parentId||parentOf(row)};}
function presentation(q){
 if(q.exportDocument){const D=typeof module!=='undefined'&&module.exports?require('./quotation-document.js'):root.QuoteQuotationDocument;if(D?.presentation)return D.presentation(q);}
 const v=view(q,{includeRequirements:true}),rows=v.orderedRows,byId=new Map(rows.map(r=>[r.id,r])),config=q.exportConfig;
 const cn=n=>n<10?'一二三四五六七八九'[n-1]:n===10?'十':(n<20?'':cn(Math.floor(n/10)))+'十'+(n%10?cn(n%10):'');
 const defs=copy(config?.chapters.definitions||v.sections.map(c=>({id:'source-'+c.chapterNo,number:c.chapterNo,title:c.chapterTitle,sourceChapterNumbers:[c.chapterNo]}))),assigned=new Map(),parents=new Map();
 const shared=r=>r.bom?.shared||r.bom?.role==='shared'||(r.business?.relatedParentIds||[]).length>1;
 for(const r of rows){const parent=byId.get(parentOf(r));parents.set(r.id,parent&&!shared(r)&&!(requirement(parent)&&!requirement(r))?parent.id:null);}
 function assign(r,seen=new Set()){
  if(assigned.has(r.id))return assigned.get(r.id);
  if(seen.has(r.id))return null;seen.add(r.id);
  const p=byId.get(parents.get(r.id));let d=p?assign(p,seen):null;
  d||=defs.find(d=>d.id===r.exportChapterId)||defs.find(d=>d.nameContains?.some(t=>r.name.toLowerCase().includes(t.toLowerCase())))||defs.find(d=>d.sourceChapterNumbers?.includes(r.business.chapterNo));
  if(!d){const key=config?'unassigned':'source-'+r.business.chapterNo;d=defs.find(d=>d.id===key);if(!d){d={id:key,number:Math.max(0,...defs.map(d=>d.number))+1,title:config?'其他设备':r.business.chapterTitle};defs.push(d);}}
  assigned.set(r.id,d);return d;
 }
 rows.forEach(r=>assign(r));
 const active=new Set(rows.filter(r=>!requirement(r)&&r.selected!==false).map(r=>assigned.get(r.id)?.id)),continuous=config?.chapters.numberingMode!=='configured';let n=0;
 const sections=defs.filter(d=>active.has(d.id)||config?.chapters.hideEmpty===false).map(d=>{n++;return {id:d.id,chapterNo:continuous?n:d.number,chapterTitle:continuous?cn(n)+'、'+d.title.replace(/^[一二三四五六七八九十百\d]+[、.．]\s*/,''):d.title,rows:[]};}),sectionMap=new Map(sections.map(s=>[s.id,s])),counts=new Map(),presented=new Map();
 function describe(r,seen=new Set()){
  if(presented.has(r.id))return presented.get(r.id);if(seen.has(r.id))return r;seen.add(r.id);
  const ch=sectionMap.get(assigned.get(r.id)?.id);if(!ch)return r;
  const p=byId.get(parents.get(r.id)),parent=p?describe(p,seen):null;let code='';
  if(parent?.quotation?.code){const siblings=rows.filter(x=>parents.get(x.id)===p.id&&requirement(x)===requirement(r));code=parent.quotation.code+(requirement(r)?'.R':'.')+(siblings.indexOf(r)+1);}
  else if(!requirement(r)){const count=(counts.get(ch.id)||0)+1;counts.set(ch.id,count);code=ch.chapterNo+'-'+String(count).padStart(2,'0');}
  const result={...r,quotation:{chapterNo:ch.chapterNo,chapterTitle:ch.chapterTitle,code,chapterId:ch.id}};presented.set(r.id,result);return result;
 }
 rows.forEach(r=>describe(r));
 for(const row of rows){const ch=sectionMap.get(assigned.get(row.id)?.id);if(ch)ch.rows.push(presented.get(row.id)||row);}
 return {sections,orderedRows:sections.flatMap(s=>s.rows)};
}
const api={VERSION,CHAPTERS,attach,view,exportFor,presentation};root.QuoteBusinessStructure=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
