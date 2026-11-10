(function(root){
'use strict';
let catalog=null,books=[],priceBooks=[],reference=null;
const fieldLabel=k=>({scope:'供货包含范围',name:'部件名称',spec:'完整规格',unit:'计量单位',material:'材料牌号',length:'长度',width:'宽度',height:'高度',thickness:'板厚',flow:'流量',flowUnit:'流量单位',voltage:'输出电压',current:'输出电流',power:'功率',diameter:'管径',currency:'币种',taxMode:'税价口径',taxRate:'税率',enterpriseId:'企业价格口径',conflictingParameters:'冲突参数'})[k]||k;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const el=s=>document.querySelector(s);
const currency=n=>n==null?'待核价':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
async function init(){
 const results=await Promise.allSettled([api('knowledge'),api('history-cases'),api('history-prices')]);
 if(results[0].status==='fulfilled'){catalog=results[0].value;Knowledge.load(catalog);}
 books=results[1].status==='fulfilled'&&Array.isArray(results[1].value)?results[1].value:await api('pricebooks');
 priceBooks=results[2].status==='fulfilled'&&Array.isArray(results[2].value)?results[2].value:books.filter(b=>b.index);
 return {catalog,books};
}
function enrich(quote,options){return catalog?KnowledgeWorkflow.annotate(quote,priceBooks,options):{quote,matched:0};}
function prepare(quote){const result=enrich(quote,{applyExact:false});if(catalog&&root.QuoteAutomation)root.QuoteAutomation.run(quote);return result;}
function refreshRow(row){if(!catalog)return;prepare(q);const button=[...document.querySelectorAll('[data-row]')].find(tr=>tr.dataset.row===row.id)?.querySelector('.knowledge-row');if(button)button.textContent=(row.basePrice==null&&row.override==null&&KnowledgeWorkflow.priceDecision(row))||'来源与价格依据';}
function currentReference(){return books.find(b=>b.id===q.referenceBookId)?.reference;}
function comparisonSource(){
 let source=q;const visited=new Set();
 while(source.knowledgeRun?.mode==='project_reference'){
  visited.add(source.id);const id=source.knowledgeRun.processId;
  const saved=[...(typeof quotes==='undefined'?[]:quotes),...(typeof templates==='undefined'?[]:templates)];
  const original=id&&!visited.has(id)?saved.find(item=>item.id===id):null;
  if(!original)return {quote:q,missing:true,label:'当前参考校准稿',mode:'source-missing'};
  if(original._summary)return {sourceId:original.id};
  source=original;
 }
 return {quote:source,missing:false,label:source===q?'当前报价':'源稿',mode:source===q?'current':'source'};
}
function quoteIdentity(quote){
 const locations=[...new Set((quote.sources||[]).map(s=>[s.filename,s.sheet].filter(Boolean).join(' / ')).filter(Boolean))];
 return `<p>${esc(quote.title||'未命名报价')}</p>${locations.length?`<small>${esc(locations.join('；'))}</small>`:''}`;
}
function references(){
 const count=priceBooks.reduce((n,b)=>n+(b.index?.records?.length||0),0);
 const availability=KnowledgeWorkflow.priceAvailability(q);
 modal('参考报价',`<p>${count} 条历史价格${catalog?' · '+catalog.entries.length+' 条行业知识':''}${q.knowledgeRun?.mode==='project_reference'?' · 本项目参考校准稿':''}</p>
  <div class="actions"><button id="knowledge-import" class="primary">导入参考报价</button>
   <button id="knowledge-compare" ${books.some(b=>b.reference)?'':'disabled'}>对照差异</button><button id="knowledge-search">行业知识与价格依据</button></div>
  <input id="knowledge-file" type="file" accept=".xlsx,.xls" multiple hidden>
  <div id="history-drop" class="history-drop" tabindex="0">将历史报价 Excel 拖到这里，可多选</div><p id="history-status" role="status"></p>
  ${books.some(b=>b.audit?.issues?.length)?`<details><summary>原表待核对 ${books.reduce((n,b)=>n+(b.audit?.issues?.length||0),0)} 处</summary>${books.filter(b=>b.audit?.issues?.length).map(b=>`<details><summary>${esc(b.name)}</summary>${b.audit.issues.map(i=>`<p>${esc(i.source)} · ${esc(i.message)}${i.original!=null?' · 原合计 '+currency(i.original)+' / 明细 '+currency(i.detailTotal):''}</p>`).join('')}</details>`).join('')}</details>`:''}
  ${availability.equipmentRows?`<details class="reference-availability"><summary>设备价格候选概况</summary><p>成品设备 ${availability.equipmentRows} 项 · 可采用 ${availability.adoptableRows} 项 · 参数不同 ${availability.differentRows} 项 · 技术参数待补 ${availability.pendingTechnicalRows} 项 · 仅相关部件 ${availability.relatedOnlyRows} 项 · 无数据 ${availability.zeroCandidateRows} 项 · 已确认采用 ${q.rows.filter(r=>r.priceEvidence?.adoption?.confirmed).length} 项</p></details>`:''}`);
 el('#knowledge-search').onclick=()=>open();
 el('#knowledge-import').onclick=()=>el('#knowledge-file').click();
 el('#knowledge-file').onchange=e=>importReference(e.target.files);
 const drop=el('#history-drop');drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging');};drop.ondragleave=()=>drop.classList.remove('dragging');drop.ondrop=e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('dragging');importReference(e.dataTransfer.files);};drop.onclick=()=>el('#knowledge-file').click();drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el('#knowledge-file').click();}};
 el('#knowledge-compare').onclick=compare;
}
function mount(){
 const trigger=el('#reference-menu');if(!trigger)return;
 trigger.onclick=references;
 document.querySelectorAll('[data-row]').forEach(tr=>{if(tr.querySelector('.knowledge-row'))return;const row=q.rows.find(r=>r.id===tr.dataset.row);if(!row)return;const cell=tr.querySelector('.row-name'),button=document.createElement('button');button.className='quiet knowledge-row';const candidates=(row.knowledgeEvidence?.priceMatches||[]).flatMap(m=>m.candidates||[]);const decision=KnowledgeWorkflow.priceDecision(row);button.textContent=(row.basePrice==null&&row.override==null&&decision?decision:'来源与价格依据')+(row.basePrice==null&&row.override==null&&!decision?(candidates.some(c=>c.canAdopt)?' · 有可用参考价':candidates.length?' · 有相关历史价':''):'');button.onclick=()=>open(row);cell?.append(button);});
}
function sourceLinks(entry){return (entry.sourceRefs||[]).map(ref=>{const source=catalog?.sources.find(s=>s.id===(ref.sourceId||ref));if(!source)return '';return /^https:\/\//.test(source.url)?`<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title)}</a> ${esc(ref.location||'')}`:`${esc(source.title)} ${esc(ref.location||'')}`;}).join('<br>');}
function open(row){
 if(!catalog)return toast('知识资料未加载，请刷新后重试。');
 const tasks=KnowledgeWorkflow.issues(q),matches=row?priceBooks.map(book=>({bookId:book.id,bookName:book.name,...Knowledge.matchPrice(row,book.index,{quote:q})})).filter(m=>m.priceStatus!=='no_match'||m.candidates.length):[];
 const choices=[],seen=new Set();for(const match of matches)for(const candidate of match.candidates||[]){const key=JSON.stringify([candidate.name,candidate.spec,candidate.unit,candidate.price,candidate.canAdopt,candidate.blockingDifferences,candidate.technicalMissing]);if(!seen.has(key)){seen.add(key);choices.push({match,candidate});}}
 modal(row?'查看原表信息 / 来源与价格依据':'知识与待核对项',`<div class="knowledge-search"><input id="knowledge-query" aria-label="检索行业知识" value="${esc(row?.name||'')}" placeholder="输入工艺、设备或参数"><button id="knowledge-go">检索</button></div>${row?`<p><strong>${esc(row.name)}</strong> ${esc(row.spec)}</p><p class="summary-note">${esc(row.source||'手动添加')} · ${esc(row.quantityBasis||row.bom?.quantityBasis||'')}</p>`:''}<details id="knowledge-articles"><summary>行业知识</summary><div id="knowledge-hits"></div></details>${row?`<section><details><summary>原表与数量依据</summary><pre class="source-view">${esc(row.rawSpec||row.spec)}</pre><p>${esc(row.quantityBasis||row.bom?.quantityBasis||'原资料未给出可确认数量')}</p><p>${esc((row.bom?.sourceRanges||[]).join('、'))}</p>${sourceForQuoteRow(row)?'<a href="#" id="knowledge-source-sheet">查看对应原表</a>':''}</details><h3>企业历史价格对照</h3>${choices.length?`<label for="knowledge-price-choice">历史候选（${choices.length} 项）</label><select id="knowledge-price-choice">${choices.map(({candidate:c},i)=>`<option value="${i}" ${i===Math.max(0,choices.findIndex(x=>x.candidate.canAdopt))?'selected':''}>${esc(c.name)} · ¥${currency(c.price)} · ${c.canAdopt?'可确认采用':c.pendingTechnical?'技术条件待核':'条件不同'}</option>`).join('')}</select><article id="knowledge-price-detail" class="knowledge-card"></article>${!M.isRequirement(row)?'<button id="knowledge-adopt-price" class="primary">确认采用参考价</button>':''}`:'<p>当前价格库没有可比记录，可继续人工补价。</p>'}</section>`:`<section><h3>待核对清单 ${tasks.length} 项</h3><div class="knowledge-tasks">${tasks.map(t=>`<article><strong>${esc(t.name)}：${esc(t.issue)}</strong><p>${esc(t.action)}</p><small>${esc(t.source||'')}</small></article>`).join('')||'<p>当前选中供货项的数量和单价已齐。</p>'}</div></section>`}<div id="ai-review-result" role="status"></div>`,'<button id="knowledge-ai">AI 核对当前'+(row?'项目':'待核对项')+'</button>',true);
 const draw=()=>{const hits=Knowledge.search(el('#knowledge-query').value,{limit:8});el('#knowledge-hits').innerHTML=hits.map(h=>`<article class="knowledge-card"><strong>${esc(h.title)}</strong><p>${esc(h.summary)}</p>${h.conditions?`<p class="summary-note">${esc(Array.isArray(h.conditions)?h.conditions.join('；'):h.conditions)}</p>`:''}<small>${sourceLinks(h)}</small></article>`).join('')||'<p>暂无对应知识条目。保留原始要求，按具体设备补技术依据。</p>';};
 if(row){
  el('#knowledge-articles').insertAdjacentHTML('beforebegin',pricingGuidanceMarkup(row));
  if(row.formulaDraft?.basis===F.basis(row))el('#row-pricing-guidance').insertAdjacentHTML('beforeend','<p>另有已保存的待核计算条件，当前继续使用确认单价。</p>');
  if(row.geometry){const edit=document.createElement('button');edit.id='guidance-geometry';edit.textContent='修改尺寸 / 材质';el('#modal .modal-foot').prepend(edit);edit.onclick=()=>{closeModal();editGeometry(row);};}
  if(!M.isRequirement(row)){const formula=document.createElement('button');formula.id='guidance-formula';formula.textContent=F.candidate(row)?'查看计算条件':'设置计价方式';el('#modal .modal-foot').prepend(formula);formula.onclick=()=>{closeModal();editFormula(row,()=>{changed();renderQuote();});};}
  const previous=row.formulaHistory?.at(-1);
  if(previous&&row.pricing?.mode==='formula'&&previous.basis===F.basis(row)&&previous.scope===(row.supplyScope??row.scope??'')){
   const undo=document.createElement('button');undo.id='guidance-undo-formula';undo.textContent='恢复上次确认价';el('#modal .modal-foot').prepend(undo);
   undo.onclick=()=>{const old=row.formulaHistory.pop();for(const key of ['basePrice','override','pricing','priceSource','priceEvidence'])row[key]=structuredClone(old[key]);delete row.formulaDraft;closeModal();changed();renderQuote();toast('已恢复公式换价之前的确认价与依据');};
  }
 }
 draw();el('#knowledge-go').onclick=draw;el('#knowledge-query').onkeydown=e=>{if(e.key==='Enter')draw();};
 if(row&&choices.length){
  const select=el('#knowledge-price-choice'),button=el('#knowledge-adopt-price');
  const drawChoice=()=>{const {match,candidate:c}=choices[Number(select.value)],notes=[...(c.adoptionBasis?.sameComponent===false?['仅为相关部件参考']:[]),...(c.blockingDifferences||[]),...(c.technicalMissing||[]),...(c.warnings||[])];el('#knowledge-price-detail').innerHTML=`<p><strong>${esc(KnowledgeWorkflow.priceDecision({...row,knowledgeEvidence:{priceMatches:[{candidates:[c]}]}}))}</strong></p><details><summary>规格与依据</summary><strong>${esc(c.name)} · ¥${currency(c.price)}</strong><p>${esc(c.spec)}</p><p>${esc(notes.join('；')||(c.canAdopt?'已知关键参数一致，请核对价格口径后采用':'适用条件待核'))}</p><small>${esc(match.bookName)} · ${esc((c.sourceRefs||[]).map(ref=>typeof ref==='string'?ref:ref.location||'').join('；'))}</small></details>`;if(button)button.disabled=!c.canAdopt;};
  select.onchange=drawChoice;drawChoice();
  if(button)button.onclick=()=>{try{const {match,candidate}=choices[Number(select.value)];QuoteWorkflow.checkpoint('采用历史参考价');KnowledgeWorkflow.adoptPrice(row,match,{candidateId:candidate.id,quote:q,confirmed:true});closeModal();changed();renderQuote();toast('已采用参考价，原价和依据可撤销');}catch(error){toast(error.message);}};
 }

 if(el('#knowledge-source-sheet'))el('#knowledge-source-sheet').onclick=event=>{event.preventDefault();showSource(row);};
 el('#knowledge-ai').onclick=()=>reviewAI(row,tasks,row&&choices[Number(el('#knowledge-price-choice')?.value||0)]);
 if(row?.priceHistory?.length){const undo=document.createElement('button');undo.id='knowledge-undo';undo.textContent='撤销上次参考价';el('#modal .modal-foot').prepend(undo);undo.onclick=()=>{try{KnowledgeWorkflow.undoPrice(row);closeModal();changed();renderQuote();toast('已恢复采用参考价之前的价格与依据。');}catch(error){toast(error.message);}};}
}
async function reviewAI(row,tasks,choice){
 const selected=row?[row]:[...new Set(tasks.map(t=>t.rowId))].map(id=>q.rows.find(r=>r.id===id)).filter(Boolean).slice(0,60);
 if(!selected.length)return toast('请选择需要核对的部件。');
 const request=KnowledgeWorkflow.reviewRequest(selected,choice);
 const output=el('#ai-review-result'),button=el('#knowledge-ai');button.disabled=true;output.textContent='正在连接 DeepSeek 核对所选项目…';
 try{const result=await api('ai-review',request);q.aiReview=result;changed();output.innerHTML=result.suggestions.map(s=>`<article class="knowledge-card"><strong>${esc(q.rows.find(r=>r.id===s.rowId)?.name)}：${esc(s.issue)}</strong><p>${esc(s.action)}</p></article>`).join('')||'已完成核对，本次未返回新增问题。';}
 catch(error){output.textContent=error.message;const go=document.createElement('button');go.textContent='前往设置';go.onclick=()=>{closeModal();page='settings';render();};output.append(document.createElement('br'),go);}
 finally{button.disabled=false;}
}
async function importReference(files){
 const selected=Array.from(files||[]);if(!selected.length)return;
 const button=el('#knowledge-import'),status=el('#history-status');if(button?.disabled)return;
 if(button)button.disabled=true;
 const jobs=[],failures=[];let reused=0,learned=0;
 try{
  for(let i=0;i<selected.length;i++){const file=selected[i];if(status)status.textContent=`正在整理 ${i+1}/${selected.length} · ${file.name}`;
   try{if(!/\.xlsx?$/i.test(file.name)||file.size>20*1024*1024)throw Error('请选择20MB以内的Excel');
    const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let j=0;j<bytes.length;j+=32768)raw+=String.fromCharCode(...bytes.subarray(j,j+32768));
    const result=await api('history-import',{filename:file.name,data:btoa(raw)});if(result.duplicate)reused++;else learned+=result.books.length;jobs.push(result.job);
   }catch(e){failures.push(file.name+'：'+e.message);}
  }
  await init();prepare(q);changed();renderQuote();
  if(status?.isConnected)status.textContent=`已整理 ${learned} 份 · 重复复用 ${reused} 份${failures.length?' · '+failures.join('；'):''} · 正在理解设备关系…`;
  let pending=jobs.filter(j=>['running','queued'].includes(j.status));
  while(pending.length){await new Promise(resolve=>setTimeout(resolve,1200));pending=await Promise.all(pending.map(j=>api('decomposition-jobs/'+j.jobId)));pending=pending.filter(j=>['running','queued'].includes(j.status));}
  await init();prepare(q);changed();renderQuote();
  const results=await Promise.all(jobs.map(j=>api('decomposition-jobs/'+j.jobId))),incomplete=results.filter(j=>j.status!=='completed');
  if(status?.isConnected){references();el('#history-status').textContent=`已整理 ${learned} 份 · 重复复用 ${reused} 份${incomplete.length?' · '+incomplete.length+' 份关系理解待补，已有资料可用':' · 已可用于后续报价'}${failures.length?' · '+failures.join('；'):''}`;}
  else toast(incomplete.length?'历史资料已保存，部分关系仍待补充理解':'历史报价已学习，可用于后续报价');
 }catch(error){if(status?.isConnected)status.textContent=error.message+'；已保存的资料保留，可再次导入继续。';else toast(error.message);}
 finally{if(button?.isConnected)button.disabled=false;}
}
async function compare(){
 const pending=books.find(b=>b.id===q.referenceBookId)?.reference;
 if(pending?._historyId){try{const value=await api('history-case/'+encodeURIComponent(pending._historyId));books.find(b=>b.id===q.referenceBookId).reference=value;}catch(e){return toast(e.message);}}
 const ref=currentReference();if(!ref){
  const choices=books.filter(b=>b.reference);if(!choices.length)return toast('请先导入参考报价。');
  modal('选择项目对照资料',`<p>选择本项目的最终报价作对照。参考资料不会改写配置拆解。</p><div class="knowledge-reference-choices">${choices.map((b,i)=>`<button data-reference-choice="${i}">${esc(b.name)}</button>`).join('')}</div>`);
  document.querySelectorAll('[data-reference-choice]').forEach(button=>button.onclick=()=>{const book=choices[Number(button.dataset.referenceChoice)];reference=book.reference;q.referenceBookId=book.id;changed();compare();});return;
 }
 const context=comparisonSource();
 if(context.sourceId)return busy(async()=>{await loadQuote(context.sourceId);compare();});
 const source=context.quote,referenceBookId=q.referenceBookId;
 const result=QuoteCompare.compareRows(source.rows,ref.rows),s=result.summary;
 result.metadata={...result.metadata,comparison:{sourceId:source.id,sourceTitle:source.title,sourceMode:context.mode,currentId:q.id,referenceId:ref.id,referenceTitle:ref.title,referenceBookId}};
 modal(context.mode==='source'?'源稿与参考报价对照':'当前报价与参考报价对照',`<div id="comparison-context" class="knowledge-pair" data-source-mode="${context.mode}"><article id="comparison-source"><strong>${esc(context.label)}</strong>${quoteIdentity(source)}</article><article id="comparison-reference"><strong>项目参考</strong>${quoteIdentity(ref)}</article></div>${context.missing?`<p id="comparison-source-missing" role="status">找不到这份校准稿对应的源稿。当前显示校准稿与参考的差异；恢复源稿后可重新生成校准稿。</p>`:context.mode==='source'?`<p class="summary-note">当前编辑的参考校准稿：${esc(q.title)}。本次对照使用上方源稿。</p>`:''}<p>供货 ${s.processSupplyRows} 项 · 参考 ${s.referenceRows} 项 · 建立对应 ${s.pairedRows} 项</p><p>规格差异 ${s.specificationDifferences} · 数量差异 ${s.quantityDifferences} · 单位差异 ${s.unitDifferences} · 条件待核对 ${s.pendingConditions}</p><div class="knowledge-comparison">${result.pairs.map(p=>`<details><summary>${esc(p.process.name)} → ${esc(p.reference.name)} · ${esc(p.status)}</summary><div class="knowledge-pair"><article><strong>${esc(context.label)}</strong><p>${esc(p.process.spec)}</p><p>${esc(p.process.quantity??'待核对')} ${esc(p.process.unit)} · ¥${currency(p.process.basePrice)}</p><small>${esc(p.process.source)}</small></article><article><strong>项目参考</strong><p>${esc(p.reference.spec)}</p><p>${esc(p.reference.quantity)} ${esc(p.reference.unit)} · ¥${currency(p.reference.basePrice)}</p><small>${esc(p.reference.source)}</small></article></div>${p.issues.map(i=>`<p>${esc(i.message)}：${esc(i.nextAction)}</p>`).join('')}</details>`).join('')}<h3>${esc(context.label)}尚未对应 ${result.processOnly.length} 项</h3>${result.processOnly.map(i=>`<p>${esc(i.row.name)}：${esc(i.nextAction)}</p>`).join('')}<h3>参考报价尚未对应 ${result.referenceOnly.length} 项</h3>${result.referenceOnly.map(i=>`<details><summary>${esc(i.row.name)} · ${esc(i.category)}</summary><p>${esc(i.row.spec)}</p><p>${esc(i.nextAction)}</p><small>${esc(i.row.source)}</small></details>`).join('')}</div>`,`<button id="comparison-download">下载逐项对照</button><button id="comparison-draft" class="primary" ${context.missing?'disabled':''}>生成本项目参考校准稿</button>`,true);
 el('#comparison-download').onclick=()=>{const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json;charset=utf-8'});QuoteExporter.download(blob,'配置与报价逐项对照.json');};
 if(!context.missing)el('#comparison-draft').onclick=()=>{modal('生成本项目参考校准稿',`<p>源稿：${esc(source.title||'未命名报价')}。项目参考：${esc(ref.title||'未命名报价')}。</p><p>将参考报价中的 ${s.referenceRows} 项供货清单、规格、数量和价格生成独立报价，逐条保留参考位置与源稿对应关系。</p><p>源稿继续保留。未对应源项进入核对清单；项目修订保留在本项目，不改行业规则或公式。</p>`,'<button id="comparison-create" class="primary">创建独立校准稿</button>');el('#comparison-create').onclick=()=>busy(async()=>{await saveNow();q=KnowledgeWorkflow.projectDraft(source,ref,result);q.referenceBookId=referenceBookId;templateEdit=null;filter='all';await saveNow();closeModal();renderQuote();toast('已生成独立参考校准稿，可查看依据、调价和导出。');});};
}
root.KnowledgeUI={init,enrich,prepare,refreshRow,mount,open,compare,getState:()=>({catalog,books,reference:currentReference()})};
})(window);
