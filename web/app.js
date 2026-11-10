'use strict';
const M=QuoteModel,F=QuoteFormulas,$=s=>document.querySelector(s),E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>n===null?'—':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const A=QuoteAssemblyPricing,B=QuoteBusinessStructure;
let q=M.draft(),parts=[],templates=[],quotes=[],page='quote',templateEdit=null,filter='all',search='',saveTimer,toastTimer,savePending=0,saveFailed=false,saveQueue=Promise.resolve(),previewUrl=null;
let quoteSearch='',quoteViewId=null,appReady=false;
let cachedQuoteView=null;
const quoteViews=new Map();
try{const view=JSON.parse(sessionStorage.getItem('quote-workbench-view'));if(view?.id)quoteViews.set(view.id,view);}catch{}
function rememberQuoteView(){
 const area=$('#table-area');if(!area?.dataset.quoteId)return null;
 const id=area.dataset.quoteId,old=quoteViews.get(id)||{},active=document.activeElement,tr=active?.closest('[data-row], [data-candidates-for]');
 const view={id,focus:old.focus,filter:document.querySelector('[data-filter].active')?.dataset.filter||filter,search:$('#quote-search')?.value||'',top:area.scrollTop,left:area.scrollLeft,docY:window.scrollY};
 if(tr&&area.contains(tr)){
  const selector=active.dataset.key?`[data-key="${active.dataset.key}"]`:active.hasAttribute('data-inline-adopt')?`[data-inline-adopt="${active.dataset.inlineAdopt}"]`:active.hasAttribute('data-candidate-source')?`[data-candidate-source="${active.dataset.candidateSource}"]`:'.'+[...active.classList].filter(c=>c!=='quiet').join('.');
  const visible=[...area.querySelectorAll('[data-row]')],index=visible.indexOf(tr);
  if(selector!=='.')view.focus={rowId:tr.dataset.row||tr.dataset.candidatesFor,candidates:!!tr.dataset.candidatesFor,selector,nextRow:visible[index+1]?.dataset.row,previousRow:visible[index-1]?.dataset.row,y:tr.getBoundingClientRect().top-area.getBoundingClientRect().top};
 }
 quoteViews.set(id,view);try{sessionStorage.setItem('quote-workbench-view',JSON.stringify(view));}catch{}
 return view;
}
function restoreQuoteView(view){
 const area=$('#table-area');if(!view||!area)return;
 area.scrollTop=view.top||0;area.scrollLeft=view.left||0;
 if(view.anchor){const row=[...area.querySelectorAll('[data-row]')].find(tr=>tr.dataset.row===view.anchor.id);if(row)area.scrollTop+=row.getBoundingClientRect().top-area.getBoundingClientRect().top-view.anchor.y;}
 window.scrollTo(window.scrollX,view.docY||0);
 const visible=[...area.querySelectorAll('[data-row]')];
 let row=view.focus&&visible.find(tr=>tr.dataset.row===view.focus.rowId);
 if(!row&&view.focus){row=visible.find(tr=>tr.dataset.row===view.focus.nextRow)||visible.find(tr=>tr.dataset.row===view.focus.previousRow);if(row&&view.focus.y!==undefined)area.scrollTop+=row.getBoundingClientRect().top-area.getBoundingClientRect().top-view.focus.y;}
 const focusRow=view.focus?.candidates?area.querySelector(`[data-candidates-for="${CSS.escape(view.focus.rowId)}"]`):row;
 const target=(focusRow&&(focusRow.querySelector(view.focus.selector)||focusRow.querySelector('button:not([disabled])')))||(row&&row.querySelector('[data-key="basePrice"]'));
 if(target)target.focus({preventScroll:true});
 else if(view.completed||view.focus)document.querySelector('[data-filter].active')?.focus({preventScroll:true});
}
function displaySpec(row){return row.spec||(M.isRequirement(row)?row.rawSpec||(row.engineeringRequirements||[]).map(item=>typeof item==='string'?item:item.text||'').join('\n'):'');}
function rowMatchesSearch(row){const terms=quoteSearch.normalize('NFKC').trim().toLowerCase().split(/\s+/).filter(Boolean),text=[row.name,displaySpec(row),row.brand,row.unit,row.group,row.subgroup,row.source].join(' ').normalize('NFKC').toLowerCase();return terms.every(term=>text.includes(term));}
function commitQuoteField(){const active=document.activeElement;if(active?.matches('[data-key]')&&$('#table-area')?.contains(active))active.blur();}
async function api(path,body,method){const quoteRoute=/^(?:quotes|templates|prepare-export|prepare-business-export|reference-excel|excel-template-choice|export-config-preview|quotation-document|quote-audit|pdf|business-pdf)$/.test(path);const r=await fetch('/api/'+path,{method:method||(body?'POST':'GET'),headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body,quoteRoute?M.quoteReplacer:undefined):undefined});if(!r.ok){const j=await r.json();throw Error(j.error||'本机服务未连接');}const type=r.headers.get('content-type')||'';return type.includes('pdf')||type.includes('spreadsheetml')?r.blob():r.json();}
const quoteReads=new Map();
async function loadQuote(id){
 const saved=quotes.find(item=>item.id===id);
 if(saved&&!saved._summary)return saved;
 if(!quoteReads.has(id))quoteReads.set(id,api('quotes/'+encodeURIComponent(id)).then(full=>{
  const index=quotes.findIndex(item=>item.id===id);
  if(index<0)quotes.unshift(full);else quotes[index]=full;
  return full;
 }).finally(()=>quoteReads.delete(id)));
 return quoteReads.get(id);
}
function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4000);}
async function busy(fn){$('#busy').hidden=false;try{return await fn();}catch(e){toast(e.message);return null;}finally{$('#busy').hidden=true;}}
function changed(){cachedQuoteView=null;q.updatedAt=new Date().toISOString();delete q.deliveryConfirmation;q.exportMode='draft';$('#save-status').textContent='正在保存…';clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveNow().catch(e=>toast(e.message)),400);}
function saveNow(){
 cachedQuoteView=null;
 if(!q.rows.length&&!q.sources?.length&&!quotes.some(item=>item.id===q.id)&&q.title==='未命名报价')return Promise.resolve();
 clearTimeout(saveTimer);saveTimer=null;savePending++;
 const body=JSON.parse(JSON.stringify(q,(key,value)=>['knowledgeEvidence','linkedPriceMatch','engineering'].includes(key)?undefined:value)),kind=templateEdit?'templates':'quotes';
 saveQueue=saveQueue.catch(()=>{}).then(()=>api(kind,body)).then(()=>{
  const list=kind==='templates'?templates:quotes,index=list.findIndex(x=>x.id===body.id);
  if(index>=0)list[index]=body;else list.unshift(body);
  saveFailed=false;$('#save-status').textContent=savePending>1?'正在保存…':'已保存到本机';
  if(kind==='quotes')localStorage.setItem('quote-workbench-last',body.id);
 }).catch(e=>{saveFailed=true;$('#save-status').textContent='保存失败 · 请重试';throw e;}).finally(()=>{savePending--;});
 return saveQueue;
}
function heading(title,desc,actions=''){return `<div class="page-heading"><div><h1>${E(title)}</h1><p>${E(desc)}</p></div><div class="actions">${actions}</div></div>`;}
function render(){
 const view=rememberQuoteView(),content=$('#content');
 // Keep the live quote DOM while visiting another page. Edits invalidate it in changed().
 if(page!=='quote'&&content.querySelector('#table-area')){
  const nodes=document.createDocumentFragment();nodes.append(...content.childNodes);
  cachedQuoteView={quote:q,updatedAt:q.updatedAt,nodes,view};
 }
 content.classList.toggle('quote-workspace',page==='quote');
 document.querySelectorAll('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 $('#breadcrumb').textContent='工作台 / '+({quote:'报价工作台',templates:'模板库',parts:'部件管理',settings:'设置'}[page]);
 if(page==='quote'){
  if(cachedQuoteView?.quote===q&&cachedQuoteView.updatedAt===q.updatedAt){const saved=cachedQuoteView;cachedQuoteView=null;content.replaceChildren(saved.nodes);restoreQuoteView(saved.view);}
  else{cachedQuoteView=null;renderQuote();}
 }
 if(page==='templates')renderTemplates();if(page==='parts')renderParts();
 if(page==='settings'&&!$('#settings-form'))renderSettings().catch(e=>toast(e.message));
}
function inputField(label,key,type='text'){return `<div class="field"><label for="meta-${key}">${label}</label><input id="meta-${key}" data-meta="${key}" type="${type}" value="${E(q[key])}"></div>`;}
function renderQuote(){
 if(page!=='quote'){cachedQuoteView=null;return;}
 cachedQuoteView=null;$('#content').classList.add('quote-workspace');
 commitQuoteField();
 EngineeringProject.attach(q);B.attach(q);M.autoPrice(q);
 KnowledgeUI.prepare(q);
 rememberQuoteView();
 if(quoteViewId!==q.id){const saved=quoteViews.get(q.id);filter=saved?.filter||'all';quoteSearch=saved?.search||'';quoteViewId=q.id;}
 const view=quoteViews.get(q.id);
 const r=M.calculate(q);
 const hasQuote=Boolean(q.rows.length||q.sources?.length),showTitle=hasQuote&&!templateEdit;
 $('#content').innerHTML=`<div class="quote-page-heading">${heading(templateEdit?'编辑报价模板':showTitle?E(q.title||'未命名报价'):'新建报价',hasQuote?'':'导入资料、描述需求或勾选已有方案。',`<select class="draft-select" id="draft-select" aria-label="打开报价草稿"><option value="">打开已存报价…</option>${quotes.map(x=>`<option value="${E(x.id)}" ${!templateEdit&&q.id===x.id?'selected':''}>${E(x.title)}</option>`).join('')}</select><button id="new-quote">＋ 新建报价</button>`)}</div>`+
 (templateEdit?`<div class="editor-banner">正在编辑模板 · ${E(q.title)} <button id="template-to-quote" class="primary">回传到报价页</button></div>`:'')+
 `<div class="quote-context-bar"><div class="dropzone${hasQuote?' dropzone-compact':''}" id="dropzone" role="button" tabindex="0" aria-label="选择或拖入 Excel、PDF 或工艺图片"><span class="drop-icon" aria-hidden="true">↥</span><div><strong>${hasQuote?'导入新资料':'拖入工艺资料'}</strong><p>Excel / PDF / 图片</p></div><span class="file-button">选择文件 →</span></div>
 <div class="quote-tools" role="group" aria-label="报价操作">
  <span id="quote-workflow-status" role="status" ${hasQuote?'':'hidden'}></span>
  <button id="quote-next" class="primary" ${hasQuote?'':'hidden'}></button>
  <div class="quote-output-actions" role="group" aria-label="报价交付">
   <details id="quote-more" class="quote-more"><summary>更多操作</summary><div class="quote-more-panel">
   <details class="quote-meta-menu"><summary>项目资料</summary><div class="quote-meta">${inputField('项目名称','title')}${inputField('客户名称','customer')}${inputField('报价日期','date','date')}</div></details>
   <div id="decomposition-panel" class="quote-tool-group"></div>
   <button id="recalculate" ${hasQuote?'':'hidden'}>重新计算</button>
   <button id="quote-history">修改历史</button><button id="reference-menu">参考报价</button><button id="quote-advanced" ${q.sources?.length?'':'hidden'}>高级功能</button>
   </div></details>
  </div>
 </div></div>
 <div class="quote-layout"><div class="quote-main panel">
 <div class="table-toolbar"><strong>报价明细 <span class="badge">${q.rows.length} 项</span></strong><div class="quote-find"><input type="search" id="quote-search" aria-label="查找报价部件" placeholder="查找名称、规格、分组或来源" value="${E(quoteSearch)}"><button id="quote-search-clear" class="quiet" ${quoteSearch?'':'hidden'}>清空</button><span id="quote-visible-count" role="status"></span></div><div class="segmented"><button data-filter="all" class="${filter==='all'?'active':''}">全部</button><button data-filter="pending" class="${filter==='pending'?'active':''}">待补齐 ${r.missing}</button></div></div>
 <div class="table-scroll" id="table-area" data-quote-id="${E(q.id)}"></div><div class="below-table"><div class="actions"><button id="add-part">＋ 从部件库添加</button><button id="add-row" class="quiet">手动加行</button></div>
 <details class="notes"><summary>备注与条款${q.notes?' · 已填':''}</summary><div class="quote-note-fields"><textarea id="quote-notes" aria-label="备注与商务条款" placeholder="交货期、付款方式、供货范围等，会随报价一同导出">${E(q.notes)}</textarea><div class="field"><label for="quote-no">报价编号</label><input id="quote-no" value="${E(q.quoteNo)}"></div></div></details><div class="table-end-actions"><button id="source-view" class="quiet">查看原表信息</button><button id="clear-quote" class="quiet danger">清空本单</button></div></div></div>
 <div class="quote-bottom"><aside class="quote-summary" id="summary" aria-label="本单价格与调价"></aside><div class="quote-delivery actions"><button id="save-template" ${q.rows.length?'':'disabled'}>存为模板</button><button id="quote-export" class="primary" ${q.rows.length?'':'disabled'}>导出报价</button></div></div></div>`;
 renderRows(undefined,true);renderSummary();
 $('#quote-search').oninput=e=>{quoteSearch=e.target.value;$('#quote-search-clear').hidden=!quoteSearch;renderRows();$('#table-area').scrollTop=0;rememberQuoteView();};
 $('#quote-search-clear').onclick=()=>{quoteSearch='';$('#quote-search').value='';$('#quote-search-clear').hidden=true;renderRows();$('#quote-search').focus({preventScroll:true});rememberQuoteView();};
 $('#table-area').onscroll=()=>rememberQuoteView();
 $('#table-area').addEventListener('focusin',()=>rememberQuoteView());
 $('#dropzone').onclick=()=>$('#file-input').click();$('#dropzone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#file-input').click();}};
 $('#dropzone').ondragover=e=>{e.preventDefault();e.currentTarget.classList.add('drag');};$('#dropzone').ondragleave=e=>e.currentTarget.classList.remove('drag');$('#dropzone').ondrop=e=>{e.preventDefault();e.currentTarget.classList.remove('drag');if(e.dataTransfer.files.length)QuoteWorkflow.importFiles(e.dataTransfer.files);};
 document.querySelectorAll('[data-meta]').forEach(el=>el.oninput=()=>{q[el.dataset.meta]=el.value;if(showTitle&&el.dataset.meta==='title')$('.quote-page-heading h1').textContent=q.title||'未命名报价';changed();});
 $('#quote-notes').oninput=e=>{q.notes=e.target.value;changed();};$('#quote-no').oninput=e=>{q.quoteNo=e.target.value;changed();};
 document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{if(b.dataset.filter==='pending')return QuotePendingUI.open();filter=b.dataset.filter;renderQuote();});
 $('#new-quote').onclick=()=>busy(async()=>{const saved=saveNow();q=M.draft();templateEdit=null;filter='all';render();await saved;});
 $('#draft-select').onchange=e=>busy(async()=>{const id=e.target.value;if(!id)return;try{await saveNow();const full=await loadQuote(id);q=structuredClone(full);M.autoPrice(q);templateEdit=null;filter='all';render();}catch(error){e.target.value=q.id;throw error;}});
 $('#add-row').onclick=()=>{const row={id:M.uid(),name:'新部件',spec:'',brand:'',unit:'',quantity:null,basePrice:null,override:null,selected:true,group:'手动添加',priceSource:''};q.rows.push(row);changed();revealQuoteRow(row.id);};
 $('#clear-quote').disabled=!hasQuote||!!templateEdit;$('#clear-quote').onclick=clearCurrentQuote;
 $('#add-part').onclick=openPartPicker;$('#source-view').onclick=showSource;
 const more=$('#quote-more');
 more.onfocusout=e=>{if(e.relatedTarget&&!more.contains(e.relatedTarget))more.open=false;};
 more.onclick=e=>{if(e.target.closest('button'))more.open=false;};
 $('#quote-export').onclick=openExportOptions;
 $('#save-template').onclick=saveTemplate;$('#quote-history').onclick=QuoteWorkflow.history;
 $('#recalculate').onclick=()=>recalculateQuote();
 if(templateEdit)$('#template-to-quote').onclick=()=>useTemplate(q);
 KnowledgeUI.mount();
 QuoteEntryUI.mount();
 QuoteBusinessUI.mount();
 QuoteDecompositionUI.mount();QuoteWorkflow.update();QuoteQuotationLayoutUI.mount();
 restoreQuoteView(view);
}
function clearCurrentQuote(){
 commitQuoteField();const count=q.rows.length;modal('清空本单',`<p>将清空当前报价的 ${count} 条明细、导入资料、章节及费用设置。其他报价、模板库和部件库保留。</p><p>清空后可以撤销恢复。</p>`,'<button id="clear-cancel">返回</button><button id="clear-confirm" class="danger">清空本单</button>');
 $('#clear-cancel').onclick=closeModal;$('#clear-confirm').onclick=()=>{QuoteWorkflow.checkpoint('清空本单');const id=q.id;q={...M.draft(),id};quoteViews.delete(id);quoteSearch='';filter='all';closeModal();changed();renderQuote();toast('本单已清空，可点“撤销修改”恢复');};
}
function revealQuoteRow(id){filter='all';quoteSearch='';renderQuote();const row=[...$('#table-area').querySelectorAll('[data-row]')].find(tr=>tr.dataset.row===id);row?.scrollIntoView({block:'nearest',inline:'nearest'});row?.querySelector('[data-key="name"]')?.focus({preventScroll:true});}
function renderRows(nextView,prepared=false){
 commitQuoteField();
 if(!prepared){EngineeringProject.attach(q);B.attach(q);M.autoPrice(q);}
 const remembered=$('#table-area table')?rememberQuoteView():null;
 const view=nextView||(remembered?{...remembered,focus:$('#table-area').contains(document.activeElement)?remembered.focus:null}:null);
 const r=M.calculate(q),byId=new Map(r.rows.map(row=>[row.id,row])),presentation=B.presentation(q),ordered=presentation.orderedRows.map(row=>({...byId.get(row.id),quotation:row.quotation})),scope=ordered.filter(x=>filter==='requirements'?M.isRequirement(x):!M.isRequirement(x)&&(filter==='all'||x.selected!==false&&x.amount===null)),rows=scope.filter(rowMatchesSearch);
 $('#quote-visible-count').textContent='显示 '+rows.length+' / '+scope.length+' 项';
 let previousGroup='';
 const rowMarkup=rows.map(row=>{const group=row.quotation?.chapterTitle||row.business?.chapterTitle||row.group||'',heading=group&&group!==previousGroup?`<tr class="bom-group"><td colspan="9">${E(group)}</td></tr>`:'';previousGroup=group;const requirement=M.isRequirement(row),included=M.isIncluded(row);
 return (presentation.entries?'':heading)+`<tr data-row="${E(row.id)}" class="${requirement?'requirement':row.selected===false?'excluded':row.amount===null?'pending':''}"><td class="check"><input type="checkbox" data-key="selected" aria-label="计入${E(row.name)}" ${requirement||included?'disabled':row.selected!==false?'checked':''}></td><td class="row-name"><input data-key="name" aria-label="部件名称" value="${E(row.name)}">${requirement?'<span class="requirement-label">供货范围待确认</span><button class="confirm-supply">确认作为独立部件</button>':included?'<span class="requirement-label">包内子项 · 不另计</span>':''}<span class="row-source" title="${E(row.source||'手动添加')}">${E(row.source||'手动添加')}</span>${row.warning?`<span class="row-source row-warning" title="${E(row.warning)}">${E(row.warning)}</span>`:''}</td><td class="spec-cell">${row.geometry?'<button class="edit-geometry">修改尺寸 / 材质</button>':''}<textarea data-key="spec" aria-label="规格">${E(displaySpec(row))}</textarea><input data-key="brand" aria-label="品牌" placeholder="品牌（可选）" value="${E(row.brand)}"></td><td class="small-col"><input class="numeric" data-key="quantity" aria-label="数量" type="number" min="0" step="any" placeholder="待填" value="${row.quantity??''}">${row.bom?`<button class="quantity-basis quiet" title="查看数量依据">${E(row.quantityEdited?'人工调整 · 查看原依据':'查看数量依据')}</button>`:''}</td><td class="small-col"><input data-key="unit" aria-label="单位" placeholder="单位" value="${E(row.unit)}"></td><td class="price-cell"><input class="numeric" data-key="basePrice" aria-label="基础单价" type="number" min="0" step="0.01" placeholder="待补价" value="${row.basePrice??''}"><span class="row-source">${E(row.priceSource||'手动补价')}</span></td><td class="price-cell"><input class="numeric" data-key="override" aria-label="本次单价" type="number" min="0" step="0.01" placeholder="自动" value="${row.unitPrice??''}"><button class="quiet reset-price" title="恢复按基础价调价">${row.override!==null&&row.override!==undefined?'撤销细调':'自动调价'}</button></td><td class="money amount">${money(row.amount)}</td><td><button class="quiet delete-row" aria-label="删除${E(row.name)}">×</button></td></tr>`;});
 const rowHTML=new Map(rows.map((row,i)=>[row.id,rowMarkup[i]])),markup=presentation.entries&&filter==='all'&&!quoteSearch?presentation.entries.map(entry=>entry.type==='row'?rowHTML.get(entry.row.id)||'':`<tr class="${entry.type==='note'?'quotation-note':'bom-group quotation-'+entry.type}"><td colspan="9">${E(entry.title)}</td></tr>`).join(''):rowMarkup.join('');
 $('#table-area').innerHTML=!rows.length?`<div class="empty"><strong>${quoteSearch?'没有匹配的部件':filter==='requirements'?'没有待确认工艺要求':q.rows.length?'所有选中项目已补齐':'从需求或清单开始'}</strong>${quoteSearch?'可清空查找，或切换“全部”查看。':q.rows.length?'可继续调价或导出报价。':'在上方导入资料、描述需求或勾选方案。'}</div>`:
 `<table><thead><tr><th></th><th>部件名称</th><th>规格 / 品牌</th><th>数量</th><th>单位</th><th>基础单价</th><th>本次单价</th><th>金额（元）</th><th></th></tr></thead><tbody>${markup}</tbody></table>`;
 $('#table-area').querySelectorAll('[data-row]').forEach(tr=>{
  const row=q.rows.find(x=>x.id===tr.dataset.row);
  tr.querySelectorAll('[data-key]').forEach(el=>el.onchange=()=>{
   if(el.dataset.committing)return;
   el.dataset.committing='true';
   try{
   const k=el.dataset.key;
   const previousValue=structuredClone(row[k]??null);
   if(k==='spec'&&el.value===displaySpec(row))return;
   if(['quantity','basePrice','override'].includes(k)){const n=M.number(el.value);if(el.value!==''&&n===null){el.value=row[k]??'';toast('请输入非负数字');return;}if(['basePrice','override'].includes(k)){delete row.historyReuseBasis;delete row.automaticSuggestions?.price;QuoteCalculation.clear(row);row.priceKind='confirmed_sale';}if(k==='basePrice')F.edit(row,k,n);else row[k]=n;if(k==='quantity')row.quantityEdited=true;}
   else if(k==='selected')row.selected=el.checked;else if(k==='name'&&!el.value.trim()){el.value=row.name;toast('部件名称不能为空');return;}else F.edit(row,k,el.value);
   if(k==='spec'&&row.geometry)row.geometry=M.geometryFromSpec(row);
   if(['name','spec','unit','brand'].includes(k))KnowledgeUI.refreshRow(row);const priorQuantities=new Map(q.rows.map(r=>[r.id,r.quantity]));M.autoPrice(q);
   if(JSON.stringify(previousValue)!==JSON.stringify(row[k]??null))row.changeLog=[...(row.changeLog||[]),{field:k,before:previousValue,after:row[k]??null,at:new Date().toISOString()}].slice(-100);
   changed();const current=M.calculate(q),rr=current.rows.find(x=>x.id===row.id);tr.querySelector('.amount').textContent=money(rr.amount);tr.className=M.isRequirement(row)?'requirement':row.selected===false?'excluded':rr.amount===null?'pending':'';if(k!=='override')tr.querySelector('[data-key="override"]').value=rr.unitPrice??'';tr.querySelector('[data-key="basePrice"]').value=row.basePrice??'';tr.querySelector('.reset-price').textContent=row.override!==null&&row.override!==undefined?'撤销细调':'自动调价';const source=tr.querySelector('.price-cell .row-source');if(source)source.textContent=row.priceSource||'待确认单价';updateFormulaButton(tr,row);refreshSummary();
   refreshLinkedQuantities(current,priorQuantities);
   if(filter==='pending'&&(rr.amount!==null||row.selected===false)){
    const view=rememberQuoteView(),visible=[...$('#table-area').querySelectorAll('[data-row]')],index=visible.indexOf(tr),next=el.dataset.backward==='true'?(visible[index-1]||visible[index+1]):(visible[index+1]||visible[index-1]);
    view.focus=next?{rowId:next.dataset.row,selector:`[data-key="${k==='selected'?'basePrice':k}"]`}:null;
    view.anchor=next?{id:next.dataset.row,y:tr.getBoundingClientRect().top-$('#table-area').getBoundingClientRect().top}:null;
    view.completed=!next;renderRows(view);
   }
   }finally{delete el.dataset.committing;}
  });
  tr.querySelectorAll('input[data-key]').forEach(el=>el.onkeydown=e=>{
   if(e.key==='Enter'){e.preventDefault();el.dispatchEvent(new Event('change'));}
   else if(e.key==='Tab'&&filter==='pending'){
    const key=el.dataset.key,value=['quantity','basePrice','override'].includes(key)?M.number(el.value):key==='selected'?el.checked:el.value;
    if(value!==row[key]){el.dataset.backward=String(e.shiftKey);el.dispatchEvent(new Event('change'));if(!el.isConnected)e.preventDefault();delete el.dataset.backward;}
   }
  });
  tr.querySelector('.reset-price').onclick=()=>{row.override=null;changed();renderRows();renderSummary();};
  tr.querySelector('.delete-row').onclick=()=>{const index=q.rows.indexOf(row);q.rows.splice(index,1);changed();renderQuote();toast('已移除条目');};
  const button=document.createElement('button');button.type='button';button.className='formula-button';tr.querySelector('.price-cell').append(button);updateFormulaButton(tr,row);
  if(tr.querySelector('.quantity-basis'))tr.querySelector('.quantity-basis').onclick=()=>showQuantityBasis(row);
  if(tr.querySelector('.edit-geometry'))tr.querySelector('.edit-geometry').onclick=()=>editGeometry(row);
  if(tr.querySelector('.confirm-supply'))tr.querySelector('.confirm-supply').onclick=()=>QuotePendingUI.open({rowId:row.id});
 });
 KnowledgeUI.mount();
 QuoteBusinessUI.mount();
 QuoteDecompositionUI.mount();QuoteWorkflow.update();QuoteQuotationLayoutUI.mount();
 restoreQuoteView(view);
}
function showQuantityBasis(row){const bom=row.bom||{},basis=row.quantityBasis||bom.quantityBasis||'原表未给出明确数量，需确认实际供货范围',ranges=bom.sourceRanges||bom.sources||[];modal('数量依据',`<p><strong>${E(row.name)}</strong></p><p>${E(typeof basis==='string'?basis:JSON.stringify(basis))}</p>${row.scope?`<p>供货范围：${E(row.scope)}</p>`:''}<p>当前数量：${E(row.quantity??'待确认')} ${E(row.unit)}</p>${row.quantityEdited?'<p>当前数量已经人工调整，原始依据保留。</p>':''}<p class="summary-note">${E(row.source||'')}</p>${ranges.length?`<pre class="source-view">${E(JSON.stringify(ranges,null,2))}</pre>`:''}`,'<button id="basis-source">查看完整原表</button>');$('#basis-source').onclick=()=>showSource(row);}
function editGeometry(row){const g=structuredClone(row.geometry);modal('修改尺寸与材质',`<p>${E(row.name)}${Number(g.chambers)>1?' · 以下是单工位内尺寸，'+g.chambers+'联槽':''}</p><div class="form-grid">${[['length','长（mm）'],['width','宽（mm）'],['height','高（mm）'],['thickness','板厚（mm）'],['material','材质']].map(([k,label])=>`<div class="form-field"><label for="geometry-${k}">${label}</label><input id="geometry-${k}" ${k==='material'?'':'type="number" min="0.001" step="any"'} value="${E(g[k]??'')}"></div>`).join('')}<div class="form-field full"><label for="geometry-notes">结构与补充要求</label><textarea id="geometry-notes" rows="3">${E(g.specSuffix||'')}</textarea></div></div><p class="summary-note">修改规格后重新核价；原确认价保留为历史参考。</p>`,'<button id="geometry-save" class="primary">保存并重新核算</button>');$('#geometry-save').onclick=()=>{for(const k of ['length','width','height','thickness']){const el=$('#geometry-'+k),n=M.number(el.value);if(n===null||n<=0){el.focus();return toast('请填写有效的尺寸和板厚');}g[k]=n;}g.material=$('#geometry-material').value.trim();if(!g.material)return toast('请填写材质');g.specSuffix=$('#geometry-notes').value.trim();M.editGeometry(row,g);closeModal();changed();const area=$('#table-area'),pos={top:area.scrollTop,left:area.scrollLeft};renderRows();area.scrollTop=pos.top;area.scrollLeft=pos.left;refreshSummary();toast(row.basePrice===null?'规格已更新，此结构需确认单价':'已按新规格重新计算');};}
function renderSummary(){
 const r=M.calculate(q),settingsOpen=$('#quote-price-settings')?.open;
 $('#summary').innerHTML=`<div class="eyebrow">${!r.completeness?.canFinalize?'已计价部分':q.taxMode==='excluded'?'未税合计':'报价合计'}</div>
  <div class="total"><small>¥</small>${money(r.total)}</div>
  <div class="summary-line"><span>已计价项目</span><span id="summary-count">${r.selected-r.missing} / ${r.selected}</span></div>
  ${q.taxMode==='excluded'?`<div class="summary-line"><span>税额</span><span id="summary-tax">¥${money(r.tax)}</span></div><div class="summary-line"><strong>含税总价</strong><strong id="summary-grand">¥${money(r.grandTotal)}</strong></div>`:''}
  <details id="quote-price-settings" class="quote-price-settings" ${settingsOpen?'open':''}>
   <summary>报价设置 · ${{included:'已含税',excluded:'另计税',none:'不另计税'}[q.taxMode]||'不另计税'}</summary>
   <div class="quote-price-fields"><label class="eyebrow" for="markup">批量上浮</label><div class="markup"><input id="markup" type="number" min="0" max="1000" step="0.1" value="${q.markup||0}"><span>%</span><button id="apply-markup">调价</button></div>
   <div class="field"><label for="tax-mode">税价口径</label><select id="tax-mode"><option value="included" ${q.taxMode==='included'?'selected':''}>单价已含税</option><option value="excluded" ${q.taxMode==='excluded'?'selected':''}>单价未税，另加税额</option><option value="none" ${q.taxMode==='none'?'selected':''}>不另计税</option></select></div>
   ${q.taxMode==='excluded'?`<div class="markup"><input id="tax-rate" aria-label="税率" type="number" min="0" max="100" step="any" value="${q.taxRate||0}"><span>% 税率</span></div>`:''}
  </div></details>`;
 $('#apply-markup').onclick=()=>{const value=M.number($('#markup').value);if(value===null||value>1000)return toast('请输入0–1000%的上浮比例');q.markup=value;changed();renderRows();renderSummary();toast('已按基础单价调整');};
 $('#tax-mode').onchange=e=>{q.taxMode=e.target.value;KnowledgeUI.enrich(q);changed();renderRows();renderSummary();};
 if($('#tax-rate'))$('#tax-rate').onchange=e=>{const n=M.number(e.target.value);if(n===null||n>100)return toast('税率应在0–100%之间');q.taxRate=n;changed();refreshSummary();};
 renderQuoteProgress(r);
 QuoteBusinessUI.mount();
 QuoteDecompositionUI.mount();QuoteWorkflow.update();QuoteQuotationLayoutUI.mount();
}
function recalculateQuote(showPending=false){
 M.matchParts(q,parts);M.autoPrice(q);
 KnowledgeUI.prepare(q);const matched=QuoteAutomation.run(q).changes.filter(x=>x.type==='price').length;
 delete q.priceReviewPending;
 if(showPending)filter=M.calculate(q).missing?'pending':'all';
 changed();renderQuote();
 const count=q.rows.filter(row=>['formula','assembly'].includes(row.pricing?.mode)&&row.basePrice!==null).length;
 toast('公式已算 '+count+' 项，同规格历史价补齐 '+matched+' 项');
}
function renderQuoteProgress(r){
 const pendingFilter=$('[data-filter="pending"]');
 pendingFilter.textContent='待补齐';pendingFilter.onclick=QuotePendingUI.open;
 const segmented=$('.segmented');
 let tab=segmented.querySelector('[data-filter="requirements"]');
 if(r.requirements&&!tab){
  tab=document.createElement('button');tab.dataset.filter='requirements';segmented.append(tab);
  tab.onclick=()=>{filter='requirements';renderQuote();};
 }
 if(tab){tab.hidden=true;tab.textContent='工艺要求 '+r.requirements;tab.classList.toggle('active',filter==='requirements');}
 $('.table-toolbar .badge').textContent=q.rows.filter(row=>!M.isRequirement(row)).length+' 项部件';

 const status=$('#quote-workflow-status'),next=$('#quote-next'),exportButton=$('#quote-export');
 if(status.hidden)return;
 status.textContent=(r.selected-r.missing)+' 项已计价';
 next.hidden=true;
 exportButton.classList.toggle('primary',Boolean(r.selected&&!r.missing));
}
async function openExportOptions(){
 try{await QuoteWorkbenchUI.audit();}catch(e){toast('原表核对尚未完成：'+e.message);return;}
 const r=QuoteWorkflow.collect();
 const partial=r.issues.length>0;
 const excelTemplates=await api('excel-templates');const choice=await api('excel-template-choice',q);
 modal('导出报价',`${partial?'<p class="warning">还有 '+r.issues.length+' 项待核对，本次导出已计价部分。详细问题请在“待补齐”处理，不写入报价文件。</p>':''}<div class="field"><label for="export-status">本次出单</label><select id="export-status">${partial?'':'<option value="final">确认正式报价</option>'}<option value="draft">过程报价 · 已计价部分</option></select></div>
  <div class="export-options">
   <section><h3>业务报价</h3><label>Excel原稿<select id="export-template">${excelTemplates.map(t=>'<option value="'+E(t.id)+'" '+(choice.id===t.id?'selected':'')+'>'+E(t.name)+'</option>').join('')}<option value="custom" ${choice.id==='custom'?'selected':''}>自定义版式</option></select></label><div class="actions"><button id="export-business-excel" class="primary">Excel</button><button id="preview-business-pdf">PDF</button></div></section>
   <section><h3>合同报价</h3><div class="actions"><button id="export-excel">Excel</button><button id="preview-pdf">PDF</button></div></section>
  </div>`);
 if(q.exportMode==='draft')$('#export-status').value='draft';
 const confirm=()=>{q.exportTemplateId=$('#export-template').value;q.exportMode=$('#export-status').value;if(q.exportMode==='final')q.deliveryConfirmation={at:new Date().toISOString(),confirmed:true};else delete q.deliveryConfirmation;closeModal();};
 $('#export-business-excel').onclick=()=>{confirm();QuoteBusinessUI.exportBusiness(false);};
 $('#preview-business-pdf').onclick=()=>{confirm();QuoteBusinessUI.exportBusiness(true);};
 $('#export-excel').onclick=()=>{confirm();exportExcel();};
 $('#preview-pdf').onclick=()=>{confirm();previewPDF();};
}
function chooseSheets(names){return new Promise(resolve=>{modal('选择要导入的工作表',`<p>只导入本次需要报价的明细页。</p><div class="sheet-choices">${names.map((name,i)=>`<label><input type="checkbox" data-sheet-index="${i}" ${/^(?:合计|汇总|封面|目录)$/.test(name)?'':'checked'}> ${E(name)}</label>`).join('')}</div>`,'<button id="sheet-cancel">取消</button><button id="sheet-import" class="primary">导入选中页</button>');const dialog=$('#modal');let settled=false;function finish(value){if(settled)return;settled=true;dialog.removeEventListener('close',cancel);dialog.removeEventListener('cancel',cancel);closeModal();resolve(value);}const cancel=()=>finish(null);dialog.addEventListener('close',cancel,{once:true});dialog.addEventListener('cancel',cancel,{once:true});$('#sheet-cancel').onclick=cancel;$('#close-modal').onclick=cancel;$('#sheet-import').onclick=()=>{const selected=[...document.querySelectorAll('[data-sheet-index]:checked')].map(el=>names[Number(el.dataset.sheetIndex)]);if(!selected.length)return toast('请至少选择一个工作表');finish(selected);};});}
async function importFile(file){return QuoteWorkflow.importFiles([file]);}
function refreshLinkedQuantities(current,prior){
 const changedRows=new Map(current.rows.filter(r=>prior.get(r.id)!==r.quantity).map(r=>[r.id,r]));if(!changedRows.size)return;
 for(const tr of $('#table-area').querySelectorAll('[data-row]')){const row=changedRows.get(tr.dataset.row);if(!row)continue;
  const quantity=tr.querySelector('[data-key="quantity"]');if(quantity&&quantity!==document.activeElement)quantity.value=row.quantity??'';
  tr.querySelector('.amount').textContent=money(row.amount);tr.className=M.isRequirement(row)?'requirement':row.selected===false?'excluded':row.amount===null?'pending':'';updateFormulaButton(tr,q.rows.find(r=>r.id===row.id));
 }
}
function refreshSummary(){
 const r=M.calculate(q),s=$('#summary');
 s.querySelector('.eyebrow').textContent=!r.completeness?.canFinalize?'已计价部分':q.taxMode==='excluded'?'未税合计':'报价合计';
 s.querySelector('.total').innerHTML='<small>¥</small>'+money(r.total);
 $('#summary-count').textContent=(r.selected-r.missing)+' / '+r.selected;
 if($('#summary-tax'))$('#summary-tax').textContent='¥'+money(r.tax);
 if($('#summary-grand'))$('#summary-grand').textContent='¥'+money(r.grandTotal);
 renderQuoteProgress(r);
 QuoteBusinessUI.mount();
 QuoteDecompositionUI.mount();QuoteWorkflow.update();QuoteQuotationLayoutUI.mount();
}
function modal(title,body,foot='',wide=false){rememberQuoteView();const d=$('#modal');d.classList.remove('review-dialog');d.classList.toggle('wide',wide);$('#modal-content').innerHTML=`<div class="modal-head"><h2>${E(title)}</h2><button class="quiet" id="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-foot">${foot}</div>`:''}`;$('#close-modal').onclick=closeModal;if(!d.open)d.showModal();}
function closeModal(){$('#modal').close();if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}}
document.addEventListener('pointerdown',e=>{
 const more=$('#quote-more[open]');
 if(more&&!more.contains(e.target))more.open=false;
});
function updateFormulaButton(tr,row){
 const b=tr.querySelector('.formula-button');if(!b)return;const d=F.explain(row),requirement=M.isRequirement(row);
 b.disabled=requirement;b.textContent=requirement?'先确认供货范围':d.status==='blocked'?'查看缺项依据':d.status==='missing'?'补计算条件':d.status==='ready'?'计算基础单价':d.status==='priced'&&row.pricing?.mode==='formula'?'公式已算 · 查看条件':'查看价格依据';
 b.title=d.action||'查看当前计价依据';b.classList.toggle('needs-input',['blocked','missing','unpriced'].includes(d.status));tr.dataset.pricingStatus=d.status;
 b.onclick=()=>['blocked','unpriced'].includes(d.status)||d.status==='priced'&&row.pricing?.mode!=='formula'?KnowledgeUI.open(row):editFormula(row,()=>{changed();renderQuote();});
 let note=tr.querySelector('.calculation-status');if(!note){note=document.createElement('small');note.className='calculation-status';b.after(note);}
 note.textContent=[d.status==='priced'?'':d.title,M.number(row.quantity)===null?'待补数量':''].filter(Boolean).join('；');note.title=[d.action,row.scope].filter(Boolean).join('；');
}
function pricingGuidanceMarkup(row,id='row-pricing-guidance'){
 const d=F.explain(row),p=F.resolve(row)?.params||F.parameters(row.spec).params;
 const isTank=row.bom?.role==='tank'||F.candidate(row)==='tank';
 const known=isTank?['length','width','height','thickness','material'].filter(k=>p[k]!==undefined).map(k=>`${F.LABELS[k]}：${k==='material'?(F.MATERIALS[p[k]]?.label||p[k]):p[k]}`):[];
 if(M.number(row.quantity)!==null)known.push('数量：'+row.quantity+' '+(row.unit||''));
 return `<section id="${id}" class="pricing-guidance ${d.status}" data-status="${d.status}"><strong>${E(d.title)}</strong>${known.length?`<p class="known-parameters">已读取 · ${E(known.join(' · '))}</p>`:''}${d.action?`<p>${E(d.action)}</p>`:''}${d.scopeIssues.length>1?`<ul>${d.scopeIssues.slice(1).map(s=>`<li>${E(s.title)}</li>`).join('')}</ul>`:''}${d.fields.length?`<p class="guidance-next">${d.status==='missing'?'需要补充':'需要核对'}：${E(d.fields.join('、'))}</p>`:''}</section>`;
}
function formulaControls(row,prefix){
 const rule=(row.formulaDraft?.basis===F.basis(row)?row.formulaDraft.rule:null)||row.pricing?.rule||F.candidate(row)||'';
 return `<div class="form-field"><label for="${prefix}-rule">计价公式</label><select id="${prefix}-rule"><option value="">选择适用公式…</option>${Object.entries(F.RULES).map(([id,r])=>`<option value="${id}" ${rule===id?'selected':''}>${E(r.label)}</option>`).join('')}</select></div><div id="${prefix}-fields" class="form-grid formula-fields"></div><div id="${prefix}-result" class="formula-result" role="status"></div>`;
}
function bindFormulaControls(row,prefix){
 const select=$('#'+prefix+'-rule');let working=structuredClone(row),resolved;
 if(row.formulaDraft?.basis===F.basis(row))working.pricing=structuredClone(row.formulaDraft);
 function read(){
  const supplied={};document.querySelectorAll(`[data-formula-prefix="${prefix}"]`).forEach(el=>{if(el.value!=='')supplied[el.dataset.param]=el.dataset.param==='material'?el.value:M.number(el.value);});
  working.pricing={mode:'formula',rule:select.value,version:F.VERSION,supplied};resolved=select.value?F.resolve(working,select.value):null;
  $('#'+prefix+'-result').innerHTML=!resolved?'选择公式后，填写缺少的计算条件。':resolved.price===null?pricingGuidanceMarkup({...working,pricing:resolved,basePrice:null,override:null},prefix+'-guidance'):`<strong>基础单价 ¥ ${money(resolved.price)}</strong><div>${resolved.steps.map(([label,n])=>`<span>${E(label)}：${money(n)}</span>`).join('')}</div><small>${E(resolved.ruleId)} · ${E(resolved.version)}</small>`;
  if(prefix==='quote-formula'&&$('#formula-apply'))$('#formula-apply').textContent=resolved?.blocked?'保留待核条件':resolved?.price===null?'保存待补条件':'使用公式';
  return resolved;
 }
 function draw(){const rule=select.value,p=rule?F.resolve(working,rule)?.params||{}:{};$('#'+prefix+'-fields').innerHTML=(F.RULES[rule]?.keys||[]).map(k=>`<div class="form-field"><label for="${prefix}-${k}">${E(F.LABELS[k])}</label>${k==='material'?`<select id="${prefix}-${k}" data-formula-prefix="${prefix}" data-param="${k}"><option value="">请选择</option>${Object.entries(F.MATERIALS).map(([id,v])=>`<option value="${id}" ${p[k]===id?'selected':''}>${E(v.label)}</option>`).join('')}</select>`:`<input id="${prefix}-${k}" type="number" min="0" step="any" data-formula-prefix="${prefix}" data-param="${k}" value="${p[k]??''}" placeholder="待补齐">`}</div>`).join('');document.querySelectorAll(`[data-formula-prefix="${prefix}"]`).forEach(el=>el.oninput=read);read();}
 select.onchange=()=>{working.pricing={mode:'formula',rule:select.value,version:F.VERSION,supplied:{}};draw();};draw();return {read,getRow:()=>working};
}
function editFormula(row,onSave){return QuoteCalculationUI.open(row,onSave,()=>editLegacyFormula(row,onSave));}
function editLegacyFormula(row,onSave){
 modal('公式与计算条件',`<p>${E(row.name)} · ${E(row.scope||'每件部件的基础单价')}</p>${formulaControls(row,'quote-formula')}<p class="summary-note">保存未完成条件时保留现有确认价。点击“使用公式”后替换单价，原价与依据留在历史记录。</p>`,'<button id="formula-manual">改为人工确认价</button><button id="formula-apply" class="primary">使用公式</button>',true);
 const control=bindFormulaControls(row,'quote-formula');
 $('#formula-apply').onclick=()=>{
  const result=control.read();if(!result)return toast('请选择适用公式');
  if(result.price===null&&M.number(row.override??row.basePrice)!==null){row.formulaDraft=structuredClone(result);closeModal();onSave();return toast('待核条件已保存，现有确认价保持');}
  if(M.number(row.override??row.basePrice)!==null){row.formulaHistory=row.formulaHistory||[];row.formulaHistory.push({at:new Date().toISOString(),basis:F.basis(row),scope:row.supplyScope??row.scope??'',basePrice:row.basePrice,override:row.override,pricing:structuredClone(row.pricing||{}),priceSource:row.priceSource,priceEvidence:structuredClone(row.priceEvidence||null)});}
  QuoteCalculation.clear(row);delete row.formulaDraft;delete row.priceEvidence;row.pricing=result;row.basePrice=result.price;row.priceSource=result.price===null?(result.blocked?'需确认单价':'公式待补条件'):'公式 · '+F.RULES[result.rule].label;row.override=null;closeModal();onSave();toast(result.price===null?(result.blocked?'已保留条件，仍需对应结构的计价依据':'已记住公式，缺少的条件保留待补'):'已按公式重新计算');
 };
 $('#formula-manual').onclick=()=>{QuoteCalculation.clear(row);row.pricing={mode:'manual'};row.priceSource='人工确认';closeModal();onSave();toast('可直接填写基础单价');};
}
$('#modal').addEventListener('cancel',()=>{if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}});
function sourceForQuoteRow(row){
 return (q.sources||[]).find(source=>Array.isArray(source.rows)&&row?.source?.startsWith(`${source.filename} / ${source.sheet} / `));
}
function sourceSheetTable(source,start,end,targetRow){
 const {rows,merges=[],formulas={}}=source;
 const width=rows.reduce((max,row)=>Math.max(max,row.length),0);
 const pageMerges=Array.from({length:end-start},()=>[]);
 for(const merge of merges){
  const top=Math.max(start,merge.s.r),bottom=Math.min(end-1,merge.e.r);
  for(let r=top;r<=bottom;r++)pageMerges[r-start].push(merge);
 }
 const columns=Array.from({length:width},(_,c)=>`<th scope="col">${XLSX.utils.encode_col(c)}</th>`).join('');
 const body=rows.slice(start,end).map((row,index)=>{
  const r=start+index,cells=[];
  for(let c=0;c<width;){
   const merge=pageMerges[index].find(item=>item.s.c<=c&&item.e.c>=c);
   if(merge&&(r!==Math.max(start,merge.s.r)||c!==merge.s.c)){c=merge.e.c+1;continue;}
   const anchor=merge?merge.s:{r,c},address=XLSX.utils.encode_cell(anchor);
   const value=merge?rows[anchor.r]?.[anchor.c]:row[c];
   const spans=merge?` rowspan="${Math.min(end,merge.e.r+1)-r}" colspan="${Math.min(width,merge.e.c+1)-c}"`:'';
   const label=formulas[address]?`${address} · =${formulas[address]}`:address;
   cells.push(`<td${spans} title="${E(label)}">${E(value)}</td>`);
   c=merge?merge.e.c+1:c+1;
  }
  return `<tr data-source-row="${r+1}"${targetRow===r+1?' class="source-target-row"':''}><th scope="row">${r+1}</th>${cells.join('')}</tr>`;
 }).join('');
 return `<table class="source-sheet-grid" aria-label="${E(source.sheet)}"><thead><tr><th scope="col">行</th>${columns}</tr></thead><tbody>${body}</tbody></table>`;
}
function showSource(row){
 const documents=(q.sources||[]).filter(source=>source.pages?.length);
 if(!documents.length)return showSourceSheets(row);
 modal('查看原始资料',`<div class="source-sheet-controls"><label for="source-document-select">资料 <select id="source-document-select"><option value="">选择资料…</option>${documents.map((source,i)=>`<option value="${i}">${E(source.filename||'原件')}</option>`).join('')}${q.sources.some(source=>Array.isArray(source.rows))?'<option value="sheets">Excel / 结构化表格</option>':''}</select></label></div><div id="source-pages"></div>`,'',true);
 const draw=()=>{const value=$('#source-document-select').value;if(value==='sheets'){closeModal();return showSourceSheets(row);}const source=documents[Number(value)];if(!source)return;$('#source-pages').innerHTML=`${source.documentId?`<p><a href="/api/source-document/${E(source.documentId)}" target="_blank" rel="noopener">打开原件</a></p>`:''}${source.pages.map(page=>`<details open><summary>${E(page.source||page.id)}${page.recognitionStatus==='pending'?' · 识别未完成':''}</summary>${page.image?`<img class="source-page-image" src="${E(page.image.startsWith('data:')?page.image:(page.image.startsWith('iVBOR')?'data:image/png;base64,':'data:image/jpeg;base64,')+page.image)}" alt="${E(page.source||'原件页面')}">`:''}<pre class="source-view">${E(page.text||'页面已保存，文字待识别')}</pre></details>`).join('')}`;};$('#source-document-select').onchange=draw;$('#source-document-select').value='0';draw();
}
function showSourceSheets(row){
 const sources=q.sources||[],sheets=sources.filter(source=>Array.isArray(source.rows));
 if(!sheets.length){
  const pages=sources.flatMap(source=>source.pages||[]);
  modal(pages.length?'原工艺资料':'查看原表',pages.map(page=>`<details><summary>${E(page.source)}</summary><pre class="source-view">${E(page.text)}</pre></details>`).join('')||'<p>当前报价由手动或部件库添加。</p>','',true);
  return;
 }
 const preferred=sourceForQuoteRow(row),pageSize=60;
 let sheetIndex=Math.max(0,sheets.indexOf(preferred)),targetRow=preferred?Number(row.sourceRow)||0:0;
 modal('查看原表',`<div class="source-sheet-controls">
  <label>工作表 <select id="source-sheet-select">${sheets.map((source,i)=>`<option value="${i}" ${i===sheetIndex?'selected':''}>${E(source.sheet)}</option>`).join('')}</select></label>
  <label>行范围 <select id="source-sheet-range"></select></label>
  <span id="source-sheet-info" class="source-sheet-info"></span><span id="source-original-download"></span>
  </div><div id="source-sheet-scroll" class="source-sheet-scroll" role="region" aria-label="原表只读预览" tabindex="0"></div>`,'',true);
 const range=$('#source-sheet-range'),scroller=$('#source-sheet-scroll');
 function drawPage(){
  const source=sheets[sheetIndex],start=Number(range.value)*pageSize,end=Math.min(start+pageSize,source.rows.length);
  scroller.innerHTML=end>start?sourceSheetTable(source,start,end,targetRow):'<p class="source-sheet-empty">该工作表没有可显示的单元格。</p>';
  scroller.scrollLeft=0;scroller.scrollTop=0;
  const target=scroller.querySelector('.source-target-row');
  if(target)scroller.scrollTop=Math.max(0,target.offsetTop-scroller.clientHeight/3);
 }
 function drawSheet(){
  const source=sheets[sheetIndex],count=source.rows.length;
  $('#source-original-download').innerHTML=source.documentId?`<a href="/api/source-document/${E(source.documentId)}" target="_blank" rel="noopener">打开原件</a>`:'';
  const pages=Array.from({length:Math.max(1,Math.ceil(count/pageSize))},(_,i)=>`<option value="${i}">${count?`${i*pageSize+1}–${Math.min((i+1)*pageSize,count)} 行`:'无数据'}</option>`);
  range.innerHTML=pages.join('');
  range.value=String(targetRow>0&&targetRow<=count?Math.floor((targetRow-1)/pageSize):0);
  $('#source-sheet-info').textContent=`${source.filename||''} · ${count} 行${targetRow>0?' · 已定位第 '+targetRow+' 行':''}`;
  drawPage();
 }
 $('#source-sheet-select').onchange=e=>{sheetIndex=Number(e.target.value);targetRow=0;drawSheet();};
 range.onchange=drawPage;
 drawSheet();
}
async function saveTemplate(){modal('入库 · 保存报价模板',`<div class="form-field"><label for="template-name">模板名称</label><input id="template-name" value="${E(q.title)}"></div><p>保存当前配件、数量、价格和调价。部件库的后续改动不会影响此快照。</p>`,'<button id="confirm-template" class="primary">保存模板</button>');$('#confirm-template').onclick=()=>busy(async()=>{const name=$('#template-name').value.trim();if(!name)throw Error('请填写模板名称');const snapshot=M.copy(q);snapshot.title=name;await api('templates',snapshot);templates.unshift(snapshot);closeModal();toast('已存入模板库');});}
async function exportExcel(){await busy(async()=>{await saveNow();const blob=await api('reference-excel',{...q,referenceExportKind:'contract'});QuoteExporter.download(blob,safeFilename(q.title)+'.xlsx');toast('Excel 已导出');});}
function safeFilename(value){return String(value||'报价单').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100);}
async function previewPDF(){await busy(async()=>{await saveNow();const blob=await api('pdf',q);previewUrl=URL.createObjectURL(blob);modal('PDF 固定版式预览',`<iframe title="报价PDF预览" src="${previewUrl}"></iframe>`,'<button id="download-pdf" class="primary">下载 PDF</button>',true);$('#download-pdf').onclick=()=>{QuoteExporter.download(blob,safeFilename(q.title)+'.pdf');toast('PDF 已导出');};});}
function renderTemplates(){
 $('#content').innerHTML=heading('模板库','保存常用物料组合，修改后回传报价页快速复用。')+(!templates.length?'<div class="panel empty"><strong>还没有报价模板</strong>在报价页点击“入库 · 存为模板”，保存第一份快照。</div>':`<div class="cards">${templates.map(t=>{const r=M.calculate(t);return `<article class="template-card panel"><span class="badge">独立快照 · ${t.rows.length} 项</span><h2 style="margin-top:15px">${E(t.title)}</h2><p>${E(t.customer||'未填写客户')} · ${E(t.updatedAt?.slice(0,10)||t.date)}</p><div class="template-price">¥ ${money(r.grandTotal)}</div><p>${r.missing?r.missing+' 项待补齐':'价格已齐，可直接复用'}</p><div class="actions"><button class="primary" data-use-template="${E(t.id)}">复用报价</button><button data-edit-template="${E(t.id)}">修改模板</button><button class="quiet danger" data-delete-template="${E(t.id)}">删除</button></div></article>`;}).join('')}</div>`);
 document.querySelectorAll('[data-use-template]').forEach(b=>b.onclick=()=>useTemplate(templates.find(t=>t.id===b.dataset.useTemplate)));
 document.querySelectorAll('[data-edit-template]').forEach(b=>b.onclick=()=>busy(async()=>{await saveNow();q=structuredClone(templates.find(t=>t.id===b.dataset.editTemplate));templateEdit=q.id;page='quote';filter='all';render();}));
 document.querySelectorAll('[data-delete-template]').forEach(b=>b.onclick=()=>confirmDelete('删除此模板？','已生成的报价会继续保留。',async()=>{await api('templates/'+b.dataset.deleteTemplate,null,'DELETE');templates=templates.filter(t=>t.id!==b.dataset.deleteTemplate);renderTemplates();}));
}
async function useTemplate(t){await busy(async()=>{await saveNow();q=M.copy(t);M.autoPrice(q);templateEdit=null;page='quote';filter='all';await saveNow();render();toast('已生成独立新报价');});}
function confirmDelete(title,body,fn){modal(title,`<p>${E(body)}</p>`,'<button id="delete-confirm" class="danger">确认删除</button>');$('#delete-confirm').onclick=()=>busy(async()=>{await fn();closeModal();toast('已删除');});}
function renderParts(){const visible=parts.filter(p=>[p.name,p.spec,p.brand,p.unit].join(' ').toLowerCase().includes(search.toLowerCase()));$('#content').innerHTML=heading('部件管理','维护基础物料和常用单价，为新报价提供数据。','<button id="new-part" class="primary">＋ 新建部件</button>')+`<div class="panel"><div class="list-toolbar"><input id="parts-search" class="search" placeholder="搜索部件名称、规格或品牌" aria-label="搜索部件" value="${E(search)}"><span>${parts.length} 个部件</span></div><div class="table-scroll"><table class="parts-table"><thead><tr><th>部件名称</th><th>规格</th><th>品牌</th><th>单位</th><th>基础单价（元）</th><th>操作</th></tr></thead><tbody>${visible.map(p=>`<tr><td>${E(p.name)}</td><td style="white-space:pre-wrap">${E(p.spec)}</td><td>${E(p.brand)}</td><td>${E(p.unit)}</td><td class="money">${p.referenceOnly?'<span>\u5386\u53f2\u53c2\u8003 '+(p.historicalPrice!=null?'¥'+money(p.historicalPrice):(p.historicalOffers?.some(o=>o.price!=null)?'存在多个价格':'原单未给价'))+'</span><br><small>'+E(p.origin?.date||'')+' \u00b7 \u539f\u5355\u5386\u53f2\u552e\u4ef7</small>':p.price===null?'\u5f85\u8865\u4ef7':money(p.price)}</td><td><div class="actions"><button data-edit-part="${E(p.id)}">修改</button><button class="quiet danger" data-delete-part="${E(p.id)}">删除</button></div></td></tr>`).join('')}</tbody></table>${!visible.length?'<div class="empty"><strong>'+(!parts.length?'建立你的部件库':'没有匹配部件')+'</strong>'+(!parts.length?'新建常用配件，导入清单时可自动补齐完全匹配的价格。':'试试其他名称或规格。')+'</div>':''}</div></div>`;
 $('#new-part').onclick=()=>editPart();$('#parts-search').oninput=e=>{search=e.target.value;const pos=e.target.selectionStart;renderParts();$('#parts-search').focus();$('#parts-search').setSelectionRange(pos,pos);};
 document.querySelectorAll('[data-edit-part]').forEach(b=>b.onclick=()=>editPart(parts.find(p=>p.id===b.dataset.editPart)));
 document.querySelectorAll('[data-delete-part]').forEach(b=>b.onclick=()=>confirmDelete('删除此部件？','已有报价及模板保留原来的物料和价格。',async()=>{await api('parts/'+b.dataset.deletePart,null,'DELETE');parts=parts.filter(p=>p.id!==b.dataset.deletePart);renderParts();}));
}
function editPart(part){
 const p=structuredClone(part||{id:M.uid(),name:'',spec:'',brand:'',unit:'',price:null});
 modal(part?'修改部件':'新建部件',`<form id="part-form" class="form-grid">${[['name','部件名称'],['brand','品牌（可选）'],['unit','计价单位'],['price','基础单价（可留空）']].map(([k,l])=>`<div class="form-field"><label for="part-${k}">${l}</label><input id="part-${k}" ${k==='name'?'required':''} ${k==='price'?'type="number" min="0" step="0.01"':''} value="${E(p[k]??'')}"></div>`).join('')}<div class="form-field full"><label for="part-spec">规格</label><textarea id="part-spec" rows="4">${E(p.spec)}</textarea></div><div class="form-field full"><label for="part-mode">计价方式</label><select id="part-mode"><option value="auto">缺价时自动匹配公式</option><option value="formula" ${p.pricing?.mode==='formula'?'selected':''}>使用公式（保存计算条件）</option><option value="manual" ${p.pricing?.mode==='manual'?'selected':''}>人工确认单价</option></select></div><section class="full" id="part-formula-section" style="grid-column:1/-1">${formulaControls(p,'part-formula')}</section></form>`,'<button type="submit" form="part-form" class="primary">保存部件</button>');
 let control=bindFormulaControls(p,'part-formula');const mode=$('#part-mode');
 function visibility(){$('#part-formula-section').hidden=mode.value!=='formula';$('#part-price').readOnly=mode.value==='formula';}
 mode.onchange=()=>{if(mode.value==='formula'){$('#part-formula-section').innerHTML=formulaControls(p,'part-formula');control=bindFormulaControls(p,'part-formula');}visibility();};visibility();
 for(const k of ['name','spec','unit','brand'])$('#part-'+k).onchange=()=>{F.edit(p,k,$('#part-'+k).value);if(mode.value==='formula'){control=bindFormulaControls(p,'part-formula');}};
 $('#part-form').onsubmit=e=>{e.preventDefault();busy(async()=>{const updated={...p};for(const k of ['name','spec','brand','unit'])updated[k]=$('#part-'+k).value.trim();updated.basePrice=M.number($('#part-price').value);delete updated.pricing;if(mode.value==='formula'){const resolved=control.read();if(!resolved)throw Error('请选择计价公式');updated.pricing=resolved;F.apply(updated,{force:true});}else if(mode.value==='manual')updated.pricing={mode:'manual'};else F.apply(updated);updated.price=updated.basePrice;if(updated.referenceOnly&&(updated.price!==null||updated.pricing?.mode==='formula'))updated.referenceOnly=false;delete updated.basePrice;const saved=await api('parts',updated);parts=parts.filter(x=>x.id!==saved.id);parts.unshift(saved);closeModal();renderParts();toast('部件与计价方式已保存');});};
}
function openPartPicker(){const selected=new Set();function draw(term=''){const found=parts.filter(p=>[p.name,p.spec,p.brand].join(' ').includes(term));$('#picker-list').innerHTML=found.length?found.map(p=>`<label style="display:flex;gap:12px;padding:13px;border-bottom:1px solid var(--line)"><input type="checkbox" data-pick="${E(p.id)}" ${selected.has(p.id)?'checked':''}><span><strong>${E(p.name)}</strong><br><small>${E(p.spec)} · ${E(p.unit)} · ${p.referenceOnly?(p.historicalPrice!=null?'历史参考 ¥'+money(p.historicalPrice):'历史价格待核'):p.price===null?'待补价':'¥'+money(p.price)}</small></span></label>`).join(''):'<div class="empty">部件库没有匹配项，可先手动加行。</div>';document.querySelectorAll('[data-pick]').forEach(el=>el.onchange=()=>{el.checked?selected.add(el.dataset.pick):selected.delete(el.dataset.pick);});}
 modal('从部件库添加','<input id="picker-search" class="search" placeholder="搜索名称或规格" aria-label="搜索添加部件"><div id="picker-list"></div>','<button id="picker-add" class="primary">添加选中部件</button>');draw();$('#picker-search').oninput=e=>draw(e.target.value);$('#picker-add').onclick=()=>{if(!selected.size)return toast('请先勾选部件');for(const id of selected){const p=parts.find(x=>x.id===id),row={id:M.uid(),name:p.name,spec:p.spec,brand:p.brand,unit:p.unit,quantity:1,basePrice:p.price,override:null,selected:true,priceSource:'部件库',group:'部件库添加',...(p.pricing?{pricing:structuredClone(p.pricing)}:{})};F.apply(row);q.rows.push(row);}closeModal();changed();revealQuoteRow(q.rows.at(-1).id);toast('已添加 '+selected.size+' 个部件，默认数量1，可在表中修改');};
}
async function renderSettings(){const s=await api('settings');if(page!=='settings')return;$('#content').innerHTML=heading('设置','配置 DeepSeek 接口与企业报价规则。')+`<section id="api-settings" class="panel settings"><h2>DeepSeek API</h2><p>用于复杂资料识别、补查漏项和 AI 核对，当前模型 ${E(s.model)}。</p><div class="rule"></div><span class="badge">${s.keySaved?'已保存 API Key':'尚未配置'}</span><form id="settings-form"><div class="form-field"><label for="api-key">API Key</label><input type="password" id="api-key" autocomplete="new-password" placeholder="${s.keySaved?'输入新 Key 可替换已保存配置':'输入 DeepSeek API Key'}"></div><div class="form-field"><label for="api-endpoint">接口地址</label><input id="api-endpoint" value="https://api.deepseek.com" readonly></div><div class="actions"><button class="primary" type="submit">保存配置</button>${s.keySaved?'<button type="button" id="clear-key" class="danger">清除已存 Key</button>':''}</div></form><p class="summary-note">Key 使用 Windows 当前用户加密保存。不会进入报价文件或模板。</p><div class="rule"></div><div class="actions"><strong>API 账户余额</strong><button type="button" id="balance-refresh" class="quiet">刷新余额</button></div><div id="api-balance" class="summary-note" aria-live="polite">正在查询…</div></section><section id="rules-dictionary" class="panel settings"></section>`;
 window.scrollTo(0,0);
 $('#settings-form').onsubmit=e=>{e.preventDefault();busy(async()=>{const key=$('#api-key').value;await api('settings',{apiKey:key});$('#api-key').value='';await renderSettings();toast('API 配置已保存');if(q.aiTask?.status==='key_required')await QuoteWorkflow.resumeAI();});};
 if($('#clear-key'))$('#clear-key').onclick=()=>confirmDelete('清除 API Key？','本机保存的接口密钥将被删除。',async()=>{await api('settings',null,'DELETE');await renderSettings();});
 async function refreshBalance(){
  const host=$('#api-balance'),button=$('#balance-refresh');
  if(!host||!button)return;
  button.disabled=true;host.textContent='正在查询 DeepSeek 账户余额…';
  try{
   const balance=await api('settings/balance');
   if($('#api-balance')!==host)return;
   if(balance.status!=='ok'){host.textContent=balance.message||'暂时无法查询余额';return;}
   host.innerHTML=`<strong>${balance.isAvailable?'账户可调用':'账户余额不足'}</strong>`+(balance.balances||[]).map(item=>
    `<div>${E(item.currency)}：可用 ${E(item.total)}（充值 ${E(item.recharged)}，赠送 ${E(item.granted)}）</div>`).join('');
  }catch(error){if($('#api-balance')===host)host.textContent='余额查询失败，请稍后刷新。';}
  finally{if($('#balance-refresh')===button)button.disabled=false;}
 }
 $('#balance-refresh').onclick=refreshBalance;
 refreshBalance();
 await QuoteRulesMemoryUI.mount();
}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{
 if(!appReady)return;
 if(page===b.dataset.page)return;
 commitQuoteField();page=b.dataset.page;search='';render();
 // Debounced edits keep saving independently of navigation; never POST an unchanged quote here.
 if(saveFailed&&!saveTimer&&!savePending)saveTimer=setTimeout(()=>saveNow().catch(e=>toast(e.message)),0);
});
$('#file-input').onchange=e=>{const files=Array.from(e.target.files||[]);e.target.value='';QuoteWorkflow.importFiles(files);};
window.addEventListener('beforeunload',e=>{rememberQuoteView();if(saveTimer||savePending||saveFailed){e.preventDefault();e.returnValue='';}});
QuoteWorkflow.init();
(async()=>{try{
 const support=Promise.all([KnowledgeUI.init(),QuoteDecompositionUI.init(),QuoteRulesMemory.load().catch(()=>{})]);
 const initial=await (window.QuoteStartup||Promise.resolve({legacy:true}));
 if(initial.error)throw initial.error;
 if(initial.payload){
  ({parts,templates,quotes}=initial.payload);
  q=structuredClone(initial.payload.quote||M.draft());
  if(initial.payload.quote){const index=quotes.findIndex(item=>item.id===q.id);if(index>=0)quotes[index]=initial.payload.quote;}
 }else{
  [parts,templates,quotes]=await Promise.all(['parts','templates','quotes'].map(x=>api(x)));
  let last;try{last=localStorage.getItem('quote-workbench-last');}catch{}
  q=structuredClone(quotes.find(x=>x.id===last)||quotes[0]||M.draft());
 }
 await support;M.autoPrice(q);appReady=true;$('#save-status').textContent='已连接 · 本机自动保存';render();
 performance.mark('quote-ready');
}catch(e){$('#save-status').textContent='本机服务连接失败';$('#content').textContent='报价读取失败，请重新加载。';toast(e.message);}})();



