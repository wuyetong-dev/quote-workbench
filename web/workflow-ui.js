(function(root){
'use strict';
const P=()=>root.EngineeringProject;
const histories=new Map(),polls=new Map();
let lastImportMode='append';
function checkpoint(label='修改报价'){
 if(!q?.rows?.length&&!q?.sources?.length)return;
 const snapshot=JSON.parse(JSON.stringify(q,(key,value)=>['knowledgeEvidence','linkedPriceMatch','engineering'].includes(key)?undefined:value));
 const stack=histories.get(q.id)||[];stack.push({label,quote:snapshot});if(stack.length>15)stack.shift();histories.set(q.id,stack);
}
async function undo(){
 commitQuoteField();const stack=histories.get(q.id),entry=stack?.pop();if(!entry)return;
 q=entry.quote;M.autoPrice(q);P().attach(q);await saveNow();renderQuote();toast('已撤销：'+entry.label);
}
function collect(){
 const result=M.calculate(q),issues=[...P().issues(q),...root.QuoteRulesMemory.unresolvedConflicts(q).map(c=>({...c,type:'rules_conflict'})),...(root.QuoteWorkbenchUI?.issues()||[])];
 for(const conflict of q.sourceResolution?.conflicts||[])issues.push({rowId:conflict.rowId,type:'spec_conflict',message:conflict.message});
 for(const group of q.decomposition?.reviewGroups||[])if(group.status==='pending')issues.push({type:'ai_review',reviewGroup:group.id,message:group.title+' · '+group.rowIds.length+'处既有配置，补查建议待核对'});
 for(const item of result.completeness?.issues||[]){
  const row=q.rows.find(r=>r.id===item.rowId);
  if(row?.scopeReview?.status==='requirement_only'&&M.isRequirement(row))continue;
  issues.push({...item,type:item.code||'calculation'});
 }
 if(!result.completeness)for(const row of result.rows){
  if(M.isRequirement(row)){if(row.scopeReview?.status!=='requirement_only')issues.push({rowId:row.id,type:'scope',message:'请确认是独立供货、包内项，还是仅为工艺要求'});}
  else if(!M.isIncluded(row)&&row.selected!==false&&row.amount===null)issues.push({rowId:row.id,type:row.quantity==null?'quantity':'price',message:row.quantity==null?'原资料没有可确认的供货数量':'缺少有效单价或计算条件'});
 }
 for(const f of root.QuoteQuantity.totals(q).filter(f=>f.status!=='allocated'))issues.push({rowId:f.rowIds[0],type:'quantity',message:f.name+'原表共'+f.value+f.unit+'；'+(f.status==='conflict'?'已填合计与总量冲突':'仅分配关系未确定，去待补齐填写对应配置数量')});
 for(const d of root.QuoteDecomposition.duplicates(q))issues.push({rowId:d.rowId,type:'duplicate',message:'相同AI结果重复候选，可在待补齐整理并撤销'});
 const seen=new Set();return {...result,issues:issues.filter(item=>{const key=[item.rowId,item.type,item.message].join('|');if(seen.has(key))return false;seen.add(key);return true;})};
}
function update(){
 const data=collect(),status=$('#quote-workflow-status');
 const summary=$('#summary .eyebrow');if(summary)summary.textContent=data.issues.length?'已计价部分':q.taxMode==='excluded'?'未税合计':'报价合计';
 if(status&&!status.hidden){
  const base=`${data.selected-data.missing} 项已计价`;
  status.textContent=base+' · '+root.QuotePendingWorkspace.build(q,root.QuotePendingAssist.prepare(q).blocks,data.issues).groups.length+' 组待补齐 / 核对';
  const next=$('#quote-next');next.hidden=!data.issues.length;
  if(data.issues.length){next.textContent='核对待补内容';next.onclick=review;}
 }
 let button=$('#undo-quote');
 if(!button&&$('#save-template')){button=document.createElement('button');button.id='undo-quote';button.className='quiet';button.textContent='撤销修改';button.onclick=()=>busy(undo);$('#save-template').after(button);}
 if(button)button.hidden=!(histories.get(q.id)?.length);
 root.QuoteWorkbenchUI?.mount();root.QuoteLifecycleUI?.mount();
 const task=q.aiTask;
 let ai=$('#ai-progress');
 if(!ai&&task&&$('#quote-tools-placeholder')==null){ai=document.createElement('div');ai.id='ai-progress';ai.className='ai-progress';$('#quote-workflow-status')?.parentElement.after(ai);}
 if(ai){
  ai.hidden=!task;
  if(task){const working=['queued','running'].includes(task.status),partial=['partial','failed','interrupted'].includes(task.status),retryable=partial&&task.canRetry!==false,markup=`<span>${working?'正在整理':task.status==='completed'||partial&&!retryable?'整理已完成'+(task.needsReview?' · 剩余疑点在待补齐中核对':''):task.status==='key_required'?'资料已保存，待配置识别':'整理暂未完成'}${working&&task.totalBatches?' · '+(task.completedBatches||0)+' / '+task.totalBatches+' 段':''}</span>${retryable?'<button id="ai-resume" class="quiet">重试未完成部分</button>':''}${task.status==='key_required'?'<button id="ai-configure" class="quiet">前往设置</button>':''}`;if(ai.innerHTML!==markup)ai.innerHTML=markup;
   if($('#ai-resume'))$('#ai-resume').onclick=()=>resumeAI();
   if($('#ai-configure'))$('#ai-configure').onclick=()=>{page='settings';render();};
   if((working||['completed','partial'].includes(task.status)&&(task.appliedAt!==task.updatedAt||task.canRetry===undefined))&&!polls.has(task.jobId))pollAI(task.jobId);
  }
 }
}
function locate(id){closeModal();filter='all';quoteSearch='';renderQuote();revealQuoteRow(id);}

function review(options){return root.QuotePendingUI.open(options&&typeof options==='object'&&!options.target?options:{});}

function scope(row){
 if(row.financialSource){
  const financial=row.financialSource;
  modal('确认税价口径',`<h3>${E(row.name)}</h3><p>原件列示税额：¥${money(financial.amount)}${financial.rate!=null?'，税率 '+E(financial.rate)+'%':''}。原件金额保留为来源参考。</p><p>本单已计价基数：¥${money(M.calculate(q).total)}。重新计税会使用本单全部已计价项目。</p><div class="field"><label for="review-tax-reason">本次确认记录</label><input id="review-tax-reason" placeholder="说明本单采用的税价口径"></div>`,'<button id="review-tax-reference">仅保留原税额参考</button>'+(financial.rate!=null?'<button id="review-tax-recompute" class="primary">按本单基数重新计税</button>':''));
  const confirm=recompute=>{const reason=$('#review-tax-reason').value.trim();if(!reason)return toast('请填写本次税价确认记录');checkpoint('确认税价口径');row.scopeReview={status:'requirement_only',reason,confirmedAt:new Date().toISOString()};if(recompute){q.taxMode='excluded';q.taxRate=financial.rate;}changed();renderQuote();review();};$('#review-tax-reference').onclick=()=>confirm(false);if($('#review-tax-recompute'))$('#review-tax-recompute').onclick=()=>confirm(true);return;
 }
 modal('确认供货范围',`<h3>${E(row.name)}</h3><p>${E(row.rawSpec||row.spec)}</p><small>${E(row.source)}</small><div class="field"><label for="review-scope-reason">确认依据</label><input id="review-scope-reason" placeholder="例如：工艺条件，不是单独供货部件"></div><div class="field"><label for="review-scope-parent">如包含在成套设备中，选择所属主项</label><select id="review-scope-parent"><option value="">请选择主项</option>${q.rows.filter(r=>r.id!==row.id&&!M.isRequirement(r)&&!M.isIncluded(r)).map(r=>`<option value="${E(r.id)}">${E(r.subgroup||r.group||'')} · ${E(r.name)}</option>`).join('')}</select></div>`,'<button id="review-requirement">仅为工艺要求</button><button id="review-included">确认为包内项</button><button id="review-supply" class="primary">确认独立供货</button>');
 const apply=independent=>{const reason=$('#review-scope-reason').value.trim();if(!reason){$('#review-scope-reason').focus();return toast('请写明本次确认依据');}checkpoint('确认供货范围');row.scopeReview={status:independent?'confirmed':'requirement_only',reason,confirmedAt:new Date().toISOString()};if(row.decomposition)row.decomposition.reviewState='confirmed';if(!independent){row.kind='requirement';row.bom={...row.bom,role:'requirement'};row.selected=false;}if(independent){row.kind='component';row.bom={...row.bom,role:'component',supplyStatus:'confirmed',confirmed:true};row.selected=true;}changed();renderQuote();review();};
 $('#review-requirement').onclick=()=>apply(false);$('#review-supply').onclick=()=>apply(true);
 $('#review-included').onclick=()=>{const parent=$('#review-scope-parent').value,reason=$('#review-scope-reason').value.trim();if(!parent||!reason)return toast('请选择主项并填写确认依据');checkpoint('确认包内项');row.kind='component';row.parentId=parent;row.scopeReview={status:'included',reason,confirmedAt:new Date().toISOString()};row.bom={...row.bom,role:'included',supplyStatus:'included',parentId:parent,confirmed:true,resolved:true};row.selected=false;if(row.decomposition){row.decomposition.reviewState='confirmed';row.decomposition.relationship='included';row.decomposition.parentId=parent;}changed();renderQuote();review();};
}
function reviewAIGroup(id){
 const group=q.decomposition?.reviewGroups?.find(g=>g.id===id);if(!group)return;
 const rows=group.rowIds.map(id=>q.rows.find(r=>r.id===id)).filter(Boolean);
 modal(group.title,`<p>补查说明已关联到原配置。以下建议没有更改原来的数量、单价或供货关系。</p>${rows.map(row=>`<details><summary>${E(row.subgroup||row.group||'')} · ${E(row.name)}</summary><p>${E(row.source||'')}</p>${(row.aiObservations||[]).filter(o=>o.family===group.family).map(o=>`<p>${E(o.name)}${o.mappingKind==='design_suggestion'?' · 选型建议':''}</p><blockquote>${E((o.evidence||[]).map(e=>e.quote).join('；'))}</blockquote>${(o.missing||[]).length?`<p>待定条件：${E(o.missing.join('；'))}</p>`:''}`).join('')}<button data-ai-row="${E(row.id)}">修改此项</button></details>`).join('')}<div class="field"><label for="ai-review-note">核对记录</label><input id="ai-review-note" placeholder="例如：保留原配置，选型随工程确认"></div>`,'<button id="ai-review-back">返回待补内容</button><button id="ai-review-keep" class="primary">已核对，保留原配置</button>',true);
 document.querySelectorAll('[data-ai-row]').forEach(b=>b.onclick=()=>locate(b.dataset.aiRow));$('#ai-review-back').onclick=review;
 $('#ai-review-keep').onclick=()=>{const reason=$('#ai-review-note').value.trim();if(!reason)return toast('请填写核对记录');checkpoint('核对资料补查建议');group.status='confirmed';group.confirmedAt=new Date().toISOString();group.reason=reason;changed();update();review();};
}
function reviewUnfinished(issue){
 const source=issue.sourceIndex!==undefined?q.sources[issue.sourceIndex]:null,sourcePage=source?.pages?.find(p=>p.id===issue.pageId),task=q.aiTask;
 const image=sourcePage?.image,src=image?(image.startsWith('data:')?image:(image.startsWith('iVBOR')?'data:image/png;base64,':'data:image/jpeg;base64,')+image):'';
 const rejected=q.decomposition?.rejectedComponents||[],fragments=new Map(QuoteDecomposition.fragments(q).map(f=>[f.id,f]));
 modal(sourcePage?'核查原始页面':'核查未完成的补查',sourcePage?`<p>${E(sourcePage.source)}</p>${src?`<img class="source-page-image" src="${E(src)}" alt="原始页面">`:''}<pre class="source-view">${E(sourcePage.text||'')}</pre>`:`<p>此次补查${rejected.length?'有 '+rejected.length+' 条候选未通过原文校验':'有部分资料未完成'}。原件、已有工程和价格已保留。</p>${rejected.map(item=>`<details><summary>${E(item.name||item.reason||'未采用的候选')}</summary><p>${E(item.reason||'来源、数量或部件结构需要人工核查')}</p></details>`).join('')}${[...new Set([...(q.decomposition?.unresolvedSourceIds||[]),...(q.decomposition?.batchStates||[]).filter(batch=>batch.rejectedComponents?.length).flatMap(batch=>batch.sourceIds||[])])].map(id=>`<details><summary>${E(fragments.get(id)?.source||id)}</summary><pre class="source-view">${E(fragments.get(id)?.text||'')}</pre></details>`).join('')}`+'<div class="field"><label for="manual-source-review">人工核查记录</label><textarea id="manual-source-review" placeholder="说明已核查的范围、采用的原件信息和处理结果"></textarea></div>','<button id="manual-review-back">返回待补内容</button><button id="manual-review-confirm" class="primary">记录人工核查</button>',true);
 // Add the same review record field for the image branch.
 if(!$('#manual-source-review'))$('#modal .modal-body').insertAdjacentHTML('beforeend','<div class="field"><label for="manual-source-review">人工核查记录</label><textarea id="manual-source-review" placeholder="说明原页内容已怎样反映在报价明细中"></textarea></div>');
 $('#manual-review-back').onclick=review;$('#manual-review-confirm').onclick=()=>{const reason=$('#manual-source-review').value.trim();if(!reason)return toast('请记录核查范围和处理结果');checkpoint('记录原始资料人工核查');(sourcePage||task).manualReview={reason,confirmedAt:new Date().toISOString()};changed();update();review();};
}
function importMode(){
 if(!q.rows.length&&!q.sources?.length)return Promise.resolve('new');
 return new Promise(resolve=>{
  modal('导入资料',`<p>这些资料用于补充当前工程，还是另一个报价项目？</p><p><strong>${E(q.title)}</strong> · ${q.rows.length} 项现有明细</p>`,'<button id="import-new">另建报价</button><button id="import-append" class="primary">补充当前工程</button>');
  let settled=false;const finish=value=>{if(settled)return;settled=true;$('#modal').removeEventListener('close',cancel);$('#modal').removeEventListener('cancel',cancel);closeModal();resolve(value);},cancel=()=>finish(null);
  $('#modal').addEventListener('close',cancel,{once:true});$('#modal').addEventListener('cancel',cancel,{once:true});$('#import-new').onclick=()=>finish('new');$('#import-append').onclick=()=>finish('append');
 });
}
async function fileHash(buffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');}
async function readFile(file,mode){
 if(!/\.(xlsx?|pdf|png|jpe?g|webp)$/i.test(file.name))throw Error('请选择 Excel、PDF 或图片');
 if(file.size>20*1024*1024)throw Error('单份资料请控制在20MB以内');
 const buffer=await file.arrayBuffer(),digest=await fileHash(buffer);
 if(mode==='append'&&q.documents?.some(d=>d.id===digest))return {duplicate:true,name:file.name};
 let imported;
 if(/\.xlsx?$/i.test(file.name)){
  imported=await QuoteDecompositionUI.readExcel(file,{process:true});
  if(imported){const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});await api('store-source',{filename:file.name,data});}
 }
 else{
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
  const source=await api('extract-local',{filename:file.name,data});imported=M.draft();imported.title=file.name.replace(/\.[^.]+$/,'');imported.sources=[source];if(source.metadata?.customer)imported.customer=source.metadata.customer;
  // PDF tables use the same structured reader as Excel, without a second set
  // of BOM extraction rules. Original page/rectangle evidence remains attached.
  for(const page of source.pages||[])for(const table of page.tables||[]){
   const wb=XLSX.utils.book_new(),sheet=page.id+'-'+table.id.split(':').at(-1);
   XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(table.rows),sheet);
   const parsed=QuoteImporter.parse(XLSX.write(wb,{type:'array',bookType:'xlsx'}),file.name,XLSX,{allowUnmapped:true});
   parsed.sources.forEach(s=>{s.documentId=digest;s.originalPage=page.id;s.originalTable=table.id;s.originalBBox=table.bbox;});
   imported.rows.push(...parsed.rows);imported.sources.push(...parsed.sources);
  }
 }
 if(!imported)return null;
 imported.documents=[{id:digest,filename:file.name,bytes:file.size,importedAt:new Date().toISOString()}];
 for(const source of imported.sources||[])source.documentId=digest;
 for(const row of imported.rows||[]){row.sourceDocumentId=digest;row.sourceIds=[digest];}
 P().attach(imported);return imported;
}
async function importFiles(files){
 const selected=Array.from(files||[]);if(!selected.length)return;
 const mode=await importMode();if(!mode)return;
 const existing=q.id;checkpoint('导入资料');await saveNow();
 const outputs=[],failures=[];const priorIds=new Set(mode==='append'?q.rows.map(r=>r.id):[]);let memoryError=null;try{await root.QuoteRulesMemory.load();}catch(e){memoryError=e.message;}
 await busy(async()=>{
  for(const file of selected){try{const value=await readFile(file,mode);if(value)outputs.push(value);}catch(error){failures.push(file.name+'：'+error.message);}}
  const valid=outputs.filter(value=>!value.duplicate);
  if(valid.length){
   let combined=mode==='append'?q:valid.shift();
   for(const value of valid)combined=P().merge(combined,value).quote;
   q=combined;templateEdit=null;filter='all';page='quote';M.matchParts(q,parts);root.QuoteRulesMemory.apply(q,undefined,q.rows.filter(r=>!priorIds.has(r.id)).map(r=>r.id));q.priceReviewPending=true;P().attach(q);KnowledgeUI.prepare(q);root.QuoteAutomation.run(q);await saveNow();render();
  }
  $('#file-input').value='';
  const duplicates=outputs.filter(value=>value.duplicate).length;
  toast(failures.length?'已保留成功资料，'+failures.length+' 份未读入':duplicates===outputs.length?'这些原件已导入，没有新增重复明细':'资料已保存，可直接修改或核对');
  if(memoryError)toast('报价字典未连接，本次未套用企业规则；可继续核对原表');
  if(failures.length)modal('部分资料未读入',`<p>成功读入的资料和原有编辑已保存。</p>${failures.map(x=>`<p>${E(x)}</p>`).join('')}`,'<button id="import-errors-close" class="primary">继续编辑</button>'),$('#import-errors-close').onclick=closeModal;
 });
 if(outputs.some(value=>!value.duplicate)){
  const settings=await api('settings').catch(()=>null);
  if(settings?.keySaved){const parameters=!!root.QuoteParameterParser.request(q).parameterRequests.length;startAI({parameters,followUpRecognition:parameters}).catch(error=>toast(error.message));}
 }
}
async function startAI(options={}){
 commitQuoteField();const targetId=q.id;await saveNow();
 const target=quotes.find(item=>item.id===targetId)||q,body=options.parameters?root.QuoteParameterParser.request(target):QuoteDecomposition.request(target,null);body.quoteId=targetId;
 if(options.parameters&&!body.parameterRequests.length)return;
 if(options.parameters&&!(await api('health')).parameterParserVersion)throw Error('语义识别调度已更新，请重新启动报价工作台后继续；原件和已有结果已保留');
 if(!body.fragments?.length&&!body.sourcePages?.length)return toast('请先导入可回查的工艺资料');
 let task=await api(options.parameters?'parameter-jobs':'decomposition-jobs',body);if(task.status==='key_required'&&(await api('settings')).keySaved)task=await api('decomposition-jobs/'+task.jobId+'/retry',{});
 if(q.id!==targetId){target.aiTask={...taskSummary(task),followUpRecognition:!!options.followUpRecognition};await api('quotes',target);return;}
 q.aiTask={...taskSummary(task),followUpRecognition:!!options.followUpRecognition};await saveNow();update();pollAI(task.jobId);
}
function taskSummary(task){const {result,...state}=task;return state;}
async function resumeAI(options={}){
 const targetId=q.id,jobId=q.aiTask.jobId;await saveNow();
 const followUpRecognition=q.aiTask.followUpRecognition,autoRetryUsed=options.automatic||q.aiTask.autoRetryUsed;
 const task=await api('decomposition-jobs/'+jobId+'/retry',{});
 if(q.id!==targetId){const target=quotes.find(item=>item.id===targetId);if(target){target.aiTask=taskSummary(task);await api('quotes',target);}return;}
 q.aiTask={...taskSummary(task),followUpRecognition,autoRetryUsed};changed();update();pollAI(task.jobId);
}
async function pollAI(jobId){
 if(polls.has(jobId))return;polls.set(jobId,true);
 try{
  const task=await api('decomposition-jobs/'+jobId);
  if(q.aiTask?.jobId!==jobId)return;
  const followUpRecognition=q.aiTask.followUpRecognition,autoRetryUsed=q.aiTask.autoRetryUsed;
  const modified=task.updatedAt!==q.aiTask.updatedAt||task.status!==q.aiTask.status||!!task.result&&q.aiTask.appliedAt!==task.updatedAt;
  if(task.result&&modified){
   const oldIds=new Set(q.rows.map(r=>r.id));
   if(task.result.parameterUpdates?.length){const next=root.QuoteParameterParser.apply(q,task.result);if(next.count)checkpoint('语义补齐原表参数');adoptAIQuote(next.quote);}
   for(const page of task.result.recognizedPages||[]){const source=q.sources?.[page.sourceIndex],target=source?.pages?.find(p=>p.id===page.id);if(target)Object.assign(target,page);}
   if(task.result.components?.length||task.result.relationDecisions?.length)adoptAIQuote(QuoteDecomposition.apply(q,task.result,null));
   root.QuoteRulesMemory.apply(q,undefined,[...new Set([...(task.result.parameterUpdates||[]).map(r=>r.id),...q.rows.filter(r=>!oldIds.has(r.id)).map(r=>r.id)])]);
   if(task.result.components?.length||task.result.parameterUpdates?.length||task.result.relationDecisions?.length){KnowledgeUI.prepare(q);root.QuoteAutomation.run(q);}
  }
  q.aiTask={...taskSummary(task),followUpRecognition,autoRetryUsed,appliedAt:task.result?task.updatedAt:q.aiTask.appliedAt};if(modified)await saveNow();
  if(['partial','failed','interrupted'].includes(task.status)&&task.canRetry===true&&!autoRetryUsed){q.aiTask.autoRetryUsed=true;await saveNow();setTimeout(()=>resumeAI({automatic:true}).catch(error=>toast(error.message)),0);return;}
  if(followUpRecognition&&['completed','partial'].includes(task.status)){q.aiTask.followUpRecognition=false;await saveNow();await startAI();return;}
  const active=document.activeElement,editing=active?.matches('input,textarea,select')&&active.getClientRects().length>0;
  if(modified&&!['queued','running'].includes(task.status)&&!$('#modal').open&&page==='quote'&&!editing)renderQuote();else update();
  if(['queued','running'].includes(task.status)){polls.delete(jobId);setTimeout(()=>pollAI(jobId),1500);}
 }catch(error){toast('资料补查暂未连接，可稍后继续');}
 finally{polls.delete(jobId);}
}
function adoptAIQuote(next){
 if(next.id!==q.id)throw Error('资料任务所属工程发生变化');
 // Active row controls may outlive an AI merge. Keep their row references current.
 const existing=new Map(q.rows.map(row=>[row.id,row]));
 next.rows=next.rows.map(row=>{const current=existing.get(row.id);if(!current)return row;for(const key of Object.keys(current))if(!(key in row))delete current[key];Object.assign(current,row);return current;});
 q=next;
}
async function history(){
 await saveNow();const items=await api('revisions/'+q.id);
 modal('修改历史',`<p>最近保存前的状态，可恢复到新的编辑状态。</p>${items.map((item,i)=>`<article class="review-item"><span>${E(new Date(item.at).toLocaleString())} · ${item.quote.rows?.length||0} 项</span><button data-restore-revision="${i}">恢复此状态</button></article>`).join('')||'<p>尚无更早的保存状态。</p>'}`,'',true);
 document.querySelectorAll('[data-restore-revision]').forEach(button=>button.onclick=()=>busy(async()=>{checkpoint('恢复历史');q=items[Number(button.dataset.restoreRevision)].quote;await saveNow();closeModal();renderQuote();toast('已恢复，可撤销本次恢复');}));
}
function init(){
 document.addEventListener('focusin',event=>{if(event.target.matches('[data-meta],#quote-notes,#quote-no'))checkpoint('修改项目资料');},true);
 document.addEventListener('change',event=>{if(event.target.matches('[data-key],#tax-mode,#tax-rate,[data-meta],#quote-notes,#quote-no'))checkpoint('修改'+({'quantity':'数量','spec':'规格','basePrice':'基础单价','override':'本次单价'}[event.target.dataset.key]||'报价'));},true);
 document.addEventListener('click',event=>{if(event.target.closest('.delete-row,.reset-price,#apply-markup,#geometry-save,#formula-apply,#formula-manual,.confirm-supply,#picker-add,#add-row'))checkpoint(event.target.textContent.trim()||'修改报价');},true);
 document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!event.target.matches('input,textarea,[contenteditable]')){event.preventDefault();undo();}});
}
root.QuoteWorkflow={init,update,collect,review,importFiles,startAI,resumeAI,checkpoint,history};
})(window);
