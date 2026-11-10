(function(root){
'use strict';
let state=null;
const labels={line:'生产线',chapter:'章节',item:'部件',pending:'待补配置',note:'说明'},clone=v=>structuredClone(v);
const current=()=>state?.host?.isConnected&&document.querySelector('#modal')?.open&&q.id===state.quoteId;
function node(){return q.exportDocument?.nodes.find(n=>n.id===state.selected);}
function title(n){return ['item','pending'].includes(n.type)?q.rows.find(r=>r.id===n.rowId)?.name||'已移除部件':n.title;}
function path(n){const result=[];while(n){result.unshift(title(n));n=q.exportDocument.nodes.find(v=>v.id===n.parentId);}return result.join(' / ');}
function viewState(){
 const h=state.host,tree=h.querySelector('#document-tree'),aside=tree.closest('aside'),paper=h.querySelector('.document-paper-wrap'),active=document.activeElement;
 let focus=null;
 if(h.contains(active))for(const key of ['id','data-node','data-doc-row','data-doc-node','data-action','data-add']){const value=active.getAttribute(key);if(value){focus={key,value};break;}}
 return {tree:tree.scrollTop,aside:aside.scrollTop,paper:paper.scrollTop,left:paper.scrollLeft,focus};
}
function restoreFocus(view){
 const f=view?.focus;if(!f)return;const selector=f.key==='id'?'#'+CSS.escape(f.value):`[${f.key}="${CSS.escape(f.value)}"]`;
 const target=state.host.querySelector(selector);if(target&&target!==document.activeElement)target.focus({preventScroll:true});
}
function restoreView(view){
 if(!view)return;const h=state.host,tree=h.querySelector('#document-tree'),paper=h.querySelector('.document-paper-wrap');
 tree.scrollTop=view.tree;tree.closest('aside').scrollTop=view.aside;paper.scrollTop=view.paper;paper.scrollLeft=view.left;
}
function previewSelection(){
 const n=node();if(!n)return null;const host=state.host.querySelector('#document-preview');
 return n.rowId?host.querySelector(`[data-doc-row="${CSS.escape(n.rowId)}"]`):host.querySelector(`[data-doc-node="${CSS.escape(n.id)}"],[data-doc-row="${CSS.escape(n.id)}"]`);
}
function markPreviewSelection(){
 const host=state.host.querySelector('#document-preview');host.querySelectorAll('.document-selected').forEach(el=>{el.classList.remove('document-selected');el.removeAttribute('aria-selected');});
 const selected=previewSelection();if(selected){selected.classList.add('document-selected');if(selected.matches('tr'))selected.setAttribute('aria-selected','true');}
}
function revealPreviewSelection(offset){
 const selected=previewSelection(),paper=state.host.querySelector('.document-paper-wrap');if(!selected)return;
 const r=selected.getBoundingClientRect(),box=paper.getBoundingClientRect(),top=box.top+paper.clientTop,bottom=top+paper.clientHeight;
 const table=selected.closest('table'),header=table?.querySelector('thead')?.getBoundingClientRect().height||0,chapter=table?.querySelector('.format-preview-chapter')?.getBoundingClientRect().height||0;
 const inset=Math.min(paper.clientHeight/3,Math.max(16,header+chapter+12));
 if(offset!=null){const last=Math.max(inset,paper.clientHeight-Math.min(r.height,paper.clientHeight-inset)-12);paper.scrollTop+=r.top-top-Math.min(Math.max(inset,offset),last);}
 else if(r.top<top+inset||r.bottom>bottom-12)paper.scrollTop+=r.top-top-inset;
}
function select(id){state.selected=id;drawTree({reveal:true});drawInspector();markPreviewSelection();revealPreviewSelection();}
function mutate(label,fn,affected=[],{reveal=true}={}){
 const view=viewState(),before={selected:state.selected,view,document:clone(q.exportDocument),exportConfig:q.exportConfig?clone(q.exportConfig):null,rows:affected.map(id=>{const r=q.rows.find(v=>v.id===id);return [id,r?clone(r):null];})};
 try{fn();QuoteQuotationDocument.ordered(q.exportDocument);M.autoPrice(q);}catch(e){state.selected=before.selected;q.exportDocument=before.document;if(before.exportConfig)q.exportConfig=before.exportConfig;else delete q.exportConfig;for(const [id,row] of before.rows){q.rows=q.rows.filter(r=>r.id!==id);if(row)q.rows.push(row);}throw e;}
 state.history.push(before);if(state.history.length>20)state.history.shift();changed();renderRows();refreshSummary();drawTree({reveal});if(!state.inlineEditing)drawInspector();restoreView(view);restoreFocus(view);if(reveal)revealTreeSelection();markPreviewSelection();state.revealPreview=reveal||state.revealPreview;schedule();
}
function schedule(){clearTimeout(state.timer);state.request++;state.host.querySelector('#document-status').textContent='正在重新计算并更新成品…';state.timer=setTimeout(refresh,300);}
async function refresh(){
 if(!current())return;const s=state,id=++s.request;try{const result=await api('quotation-document',q);if(!current()||id!==s.request)return;s.model=result.model;q.exportDocument=result.document;drawTree();drawPreview();s.host.querySelector('#document-status').textContent=`${result.model.selectedCount}项计费 · ${result.model.pricedCount}项已价 · ¥${money(result.model.totals.at(-1).value)} · 成品预览已更新`;}catch(e){if(current()&&id===s.request)s.host.querySelector('#document-status').textContent='成品未更新：'+e.message;}
}
function revealTreeSelection(){
 if(!current())return;const tree=state.host.querySelector('#document-tree'),selected=tree.querySelector('.active');if(!selected)return;
 // Reveal inside the two left panes without scrolling the modal or the page.
 for(const pane of [tree,tree.closest('aside')]){const item=selected.getBoundingClientRect(),box=pane.getBoundingClientRect(),top=box.top+pane.clientTop,bottom=top+pane.clientHeight;if(item.top<top+6)pane.scrollTop+=item.top-top-6;else if(item.bottom>bottom-6)pane.scrollTop+=item.bottom-bottom+6;}
}
function drawTree({reveal=false}={}){
 if(!current())return;const h=state.host,tree=h.querySelector('#document-tree'),view=viewState(),previous=tree.querySelector('.active')?.dataset.node;
 // Keep node buttons alive: committing an input on blur must not remove the
 // next button between pointerdown and click, or consume the user's selection.
 const existing=new Map([...tree.querySelectorAll('[data-node]')].map(b=>[b.dataset.node,b]));
 QuoteQuotationDocument.ordered(q.exportDocument).forEach((n,index)=>{
  let button=existing.get(n.id);existing.delete(n.id);
  if(!button){button=document.createElement('button');button.type='button';button.className='document-node';button.dataset.node=n.id;button.append(document.createElement('span'),document.createElement('strong'));button.onclick=()=>select(button.dataset.node);}
  button.classList.toggle('active',n.id===state.selected);button.setAttribute('aria-pressed',String(n.id===state.selected));button.style.setProperty('--level',Math.min(n.depth,8));
  button.querySelector('span').textContent=labels[n.type];button.querySelector('strong').textContent=title(n);
  if(tree.children[index]!==button)tree.insertBefore(button,tree.children[index]||null);
 });
 existing.forEach(button=>button.remove());tree.scrollTop=view.tree;restoreFocus(view);
 if(reveal||previous!==state.selected){const owner=state,id=state.selected;requestAnimationFrame(()=>{if(state===owner&&current()&&state.selected===id)revealTreeSelection();});}
}
function drawPreview(){
 const host=state.host.querySelector('#document-preview'),paper=host.closest('.document-paper-wrap'),view=viewState(),old=previewSelection(),box=paper.getBoundingClientRect(),rect=old?.getBoundingClientRect();
 const offset=rect&&rect.top>=box.top&&rect.top<box.top+paper.clientHeight?rect.top-box.top:null;
 host.innerHTML=QuoteQuotationPreview.html(state.model,{editable:true});restoreView(view);markPreviewSelection();
 if(state.revealPreview)revealPreviewSelection(offset);state.revealPreview=false;restoreFocus(view);
 host.querySelectorAll('[data-doc-row],[data-doc-node]').forEach(el=>{el.onclick=()=>{const n=q.exportDocument.nodes.find(n=>n.id===el.dataset.docNode||n.rowId===el.dataset.docRow||n.id===el.dataset.docRow);if(n)select(n.id);};el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click();}};});
}
function drawInspector(){
 if(!current())return;const h=state.host,n=node(),r=['item','pending'].includes(n?.type)?q.rows.find(r=>r.id===n.rowId):null,box=h.querySelector('#document-inspector');
 const calculated=M.calculate(q);let displayedPrice=r?calculated.rows.find(v=>v.id===r.id)?.unitPrice:null;
 const moreOpen=!!box.querySelector('.document-more[open]');
 const controls=[...h.querySelectorAll('[data-action],[data-add]:not([data-add="line"]),#document-remove')];const controlFragment=document.createDocumentFragment();controls.forEach(control=>controlFragment.append(control));
 if(!n){box.innerHTML='<p>选中左侧层级或右侧报价行，即可直接修改。</p>';box.append(controlFragment);return;}
 const subtree=new Set([n.id]);let expanded=true;while(expanded){expanded=false;for(const v of q.exportDocument.nodes)if(subtree.has(v.parentId)&&!subtree.has(v.id)){subtree.add(v.id);expanded=true;}}const rowIds=new Set(q.exportDocument.nodes.filter(v=>subtree.has(v.id)).map(v=>v.rowId));const componentRows=calculated.rows.filter(v=>rowIds.has(v.id)&&v.selected!==false&&!M.isRequirement(v)&&!M.isIncluded(v));const groupSum=componentRows.reduce((sum,v)=>sum+(v.amount||0),0),unpriced=componentRows.filter(v=>v.amount==null).length;
 const opts=QuoteQuotationDocument.ordered(q.exportDocument).filter(v=>v.id!==n.id&&v.type!=='note'&&!(n.type==='line'&&v.parentId)).map(v=>`<option value="${E(v.id)}">${'　'.repeat(Math.min(v.depth,6))}${E(labels[v.type]+' · '+title(v))}</option>`).join('');
 box.innerHTML=`<div class="document-selection"><strong>${E(labels[n.type])}</strong><span>${E(path(n))}</span>${r?`<p>\u672c\u7ec4\u5df2\u8ba1\u4ef7 \u00a5${money(groupSum)} \u00b7 ${unpriced}\u9879\u5f85\u8865</p>`:''}</div><div class="document-context-actions"></div><div class="document-fields"><label>${r?'部件名称':'名称 / 说明'}<${n.type==='note'?'textarea':'input'} id="document-title" ${n.type==='note'?'':'value="'+E(title(n))+'"'}>${n.type==='note'?E(title(n)):''}</${n.type==='note'?'textarea':'input'}></label>${n.type!=='line'?`<label>所属上级<select id="document-parent">${opts}</select></label>`:''}${n.type==='chapter'?`<label>手工章号<input id="document-number" type="number" min="1" max="99" value="${n.number||''}" placeholder="默认连续编号"></label>`:''}${r?`<label>\u8ba1\u4ef7\u65b9\u5f0f<select id="document-billing"><option value="separate">\u672c\u9879\u5355\u72ec\u8ba1\u4ef7</option><option value="included">\u5df2\u542b\u5728\u4e0a\u7ea7\u8bbe\u5907\u5355\u4ef7\uff0c\u4e0d\u53e6\u8ba1</option></select></label><label>\u4ef7\u683c\u5bf9\u5e94\u8303\u56f4<input id="document-scope" value="${E(r.scope||'')}"></label><label>\u4ef7\u683c\u6765\u6e90 / \u586b\u5199\u4eba<input id="document-price-source" value="${E(r.manualPriceSource||'')}" placeholder="\u5982\uff1a\u91c7\u8d2d\u8be2\u4ef7\u3001\u8f66\u95f4\u6838\u4ef7"></label><label class="document-spec">规格与配置<textarea id="document-spec">${E(r.spec||r.rawSpec||'')}</textarea></label><label>数量<input id="document-quantity" type="number" min="0" step="any" value="${r.quantity??''}"></label><label>单位<input id="document-unit" value="${E(r.unit)}"></label><label>本次单价<input id="document-price" type="number" min="0" step="0.01" value="${M.calculate(q).rows.find(v=>v.id===r.id)?.unitPrice??''}" placeholder="待核价"></label><label>补强说明<textarea id="document-reinforcement">${E(r.reinforcement||'')}</textarea></label><label>其他说明<textarea id="document-remark">${E(r.quoteRemark||'')}</textarea></label><p class="document-price-scope">本行价格对应：${E(r.scope||r.name)}。所属上级是排版关系；降级不会自动改成“已含价”。</p>`:''}</div>${r?'<button id="document-remember">\u5c06\u672c\u9879\u786e\u8ba4\u5355\u4ef7\u8bb0\u5165\u4f01\u4e1a\u4ef7\u683c</button>':''}<button id="document-apply" class="primary">应用修改，立即更新报价</button>`;
 box.querySelector('.document-context-actions')?.append(controlFragment);
 if(h.querySelector('#document-parent'))h.querySelector('#document-parent').value=n.parentId;
 if(r){const more=document.createElement('details');more.className='document-more';more.open=moreOpen;more.innerHTML='<summary>更多设置</summary><div class="document-fields"></div>';for(const id of ['document-parent','document-billing','document-scope','document-price-source','document-reinforcement','document-remark']){const label=h.querySelector('#'+id)?.closest('label');if(label)more.querySelector('.document-fields').append(label);}more.querySelector('.document-fields').append(h.querySelector('.document-price-scope'));more.append(h.querySelector('#document-remember'));h.querySelector('#document-apply').before(more);}
 if(r)h.querySelector('#document-billing').value=M.isIncluded(r)?'included':'separate';
 if(r)h.querySelector('#document-remember').onclick=()=>busy(async()=>{const price=M.calculate(q).rows.find(v=>v.id===r.id)?.unitPrice;if(price==null)throw Error('\u8bf7\u5148\u586b\u5165\u5e76\u5e94\u7528\u672c\u9879\u4ef7\u683c');if(!r.scope)throw Error('\u8bf7\u5148\u586b\u6e05\u672c\u4ef7\u683c\u7684\u5305\u542b\u8303\u56f4');const rule=QuoteRulesMemory.priceRule(q,r,price,{priceMode:'fixed_sale',source:r.manualPriceSource||'\u672c\u5355\u4eba\u5de5\u786e\u8ba4'});const existing=QuoteRulesMemory.rules.find(v=>v.kind==='price'&&JSON.stringify(v.match)===JSON.stringify(rule.match));await QuoteRulesMemory.save([existing?{...existing,...rule}:rule]);toast('\u5df2\u8bb0\u5165\u4f01\u4e1a\u786e\u8ba4\u4ef7\uff0c\u540e\u7eed\u540c\u6761\u4ef6\u81ea\u52a8\u4f7f\u7528');});
 h.querySelector('#document-apply').onclick=()=>{try{const n=node(),r=['item','pending'].includes(n?.type)?q.rows.find(row=>row.id===n.rowId):null;if(!n)return;const value=h.querySelector('#document-title').value.trim();if(!value)throw Error('请填写名称或说明');const quantity=r?M.number(h.querySelector('#document-quantity').value):null,price=r?M.number(h.querySelector('#document-price').value):null;if(r&&h.querySelector('#document-quantity').value!==''&&quantity===null)throw Error('数量无效');if(r&&h.querySelector('#document-price').value!==''&&price===null)throw Error('价格无效');mutate('编辑报价表',()=>{if(r){const billing=h.querySelector('#document-billing').value,owner=q.exportDocument.nodes.find(v=>v.id===h.querySelector('#document-parent')?.value),ownerRow=owner?.rowId&&q.rows.find(v=>v.id===owner.rowId);if(billing==='included'&&!ownerRow)throw Error('\u8bf7\u9009\u62e9\u5305\u542b\u672c\u9879\u7684\u4e3b\u8bbe\u5907');if(n.type==='pending'){if(billing==='separate'&&(quantity===null||price===null))throw Error('\u786e\u8ba4\u672c\u914d\u7f6e\u4f9b\u8d27\u65f6\uff0c\u8bf7\u586b\u6570\u91cf\u548c\u5355\u4ef7');r.kind='component';r.bom={...r.bom,role:'accessory',resolved:true,confirmed:true};r.scopeReview={status:billing==='included'?'included':'confirmed',reason:'\u672c\u5355\u586b\u4ef7\u5e76\u786e\u8ba4\u4f9b\u8d27',confirmedAt:new Date().toISOString()};n.type='item';r.selected=true;}r.bom={role:r.bom?.role||'component',...r.bom,supplyStatus:billing==='included'?'included':'confirmed'};if(billing==='included'){r.parentId=ownerRow.id;r.bom.parentId=ownerRow.id;}const spec=h.querySelector('#document-spec').value;if(value!==r.name)F.edit(r,'name',value);if(spec!==r.spec){F.edit(r,'spec',spec);if(r.geometry)r.geometry=M.geometryFromSpec(r);}const scope=h.querySelector('#document-scope').value.trim();if(scope!==r.scope)F.edit(r,'scope',scope);r.manualPriceSource=h.querySelector('#document-price-source').value.trim();if(quantity!==M.number(r.quantity)){r.quantity=quantity;r.quantityEdited=true;}const unit=h.querySelector('#document-unit').value.trim();if(unit!==r.unit)F.edit(r,'unit',unit);const old=displayedPrice;if(price!==old){r.priceHistory=[...(r.priceHistory||[]),{at:new Date().toISOString(),before:old,after:price,scope:r.scope,source:r.manualPriceSource||'\u4eba\u5de5\u786e\u8ba4'}];delete r.historyReuseBasis;delete r.automaticSuggestions?.price;r.override=price;r.priceKind='confirmed_sale';r.priceSource=r.manualPriceSource||'\u4eba\u5de5\u786e\u8ba4\u5355\u4ef7';}r.reinforcement=h.querySelector('#document-reinforcement').value.trim();r.quoteRemark=h.querySelector('#document-remark').value.trim();KnowledgeUI.refreshRow(r);}else n.title=value;if(h.querySelector('#document-parent'))n.parentId=h.querySelector('#document-parent').value;if(h.querySelector('#document-number')){const v=h.querySelector('#document-number').value;n.number=v?Number(v):null;if(v){q.exportConfig=clone(q.exportConfig||state.model.exportConfig);q.exportConfig.chapters.numberingMode='configured';}}},r?[r.id]:[],{reveal:!!h.querySelector('#document-parent')&&h.querySelector('#document-parent').value!==n.parentId});if(r){const c=M.calculate(q);displayedPrice=c.rows.find(v=>v.id===r.id)?.unitPrice;h.querySelector('#document-price').value=displayedPrice??'';const rows=c.rows.filter(v=>rowIds.has(v.id)&&v.selected!==false&&!M.isRequirement(v)&&!M.isIncluded(v));h.querySelector('.document-selection p').textContent='本组已计价 ¥'+money(rows.reduce((sum,v)=>sum+(v.amount||0),0))+' · '+rows.filter(v=>v.amount==null).length+'项待补';}}catch(e){toast(e.message);}};
 if(r){h.querySelector('#document-apply').textContent='应用更多设置';for(const id of ['document-title','document-spec','document-quantity','document-unit','document-price'])h.querySelector('#'+id).onchange=()=>{state.inlineEditing=true;try{h.querySelector('#document-apply').click();}finally{state.inlineEditing=false;}};}

}
function add(type){const selected=node(),d=q.exportDocument;let parent=selected;if(type==='line')parent=null;else if(type==='chapter'){while(parent&&parent.type!=='line'&&parent.type!=='chapter')parent=d.nodes.find(n=>n.id===parent.parentId);if(parent?.type==='chapter')parent=d.nodes.find(n=>n.id===parent.parentId);}else if(parent?.type==='note')parent=d.nodes.find(n=>n.id===parent.parentId);if(type!=='line'&&!parent)parent=d.nodes.find(n=>n.type==='line');const id=M.uid(),rowId=type==='item'?M.uid():null;mutate('添加报价层级',()=>{const n={id,type,parentId:parent?.id||null,title:type==='line'?'新生产线':type==='chapter'?'新章节':'补充说明'};if(rowId){delete n.title;n.rowId=rowId;q.rows.push({id:rowId,name:'新部件',spec:'',unit:'项',quantity:1,basePrice:null,override:null,selected:true,pricing:{mode:'manual'},priceSource:'人工添加'});}d.nodes.push(n);state.selected=id;},rowId?[rowId]:[]);}
function remove(){const n=node();if(!n)return;const lines=q.exportDocument.nodes.filter(v=>v.type==='line');if(n.type==='line'&&lines.length===1)throw Error('请保留至少一条生产线，可直接修改名称');const row=['item','pending'].includes(n.type)?q.rows.find(r=>r.id===n.rowId):null;mutate('移除报价层级',()=>{const target=n.parentId||(lines.find(v=>v.id!==n.id)?.id);for(const child of q.exportDocument.nodes)if(child.parentId===n.id)child.parentId=target;if(row){row.selected=false;if(n.type==='pending')row.quoteLayoutHidden=true;}const peers=q.exportDocument.nodes.filter(v=>v.parentId===n.parentId),index=peers.findIndex(v=>v.id===n.id);q.exportDocument.nodes=q.exportDocument.nodes.filter(v=>v.id!==n.id);state.selected=peers[index+1]?.id||peers[index-1]?.id||target;},row?[row.id]:[]);}
async function open(){
 const previous=state?.quoteId===q.id?state.selected:null;const result=await api('quotation-document',q);QuoteWorkflow.checkpoint('编辑报价表');q.exportDocument=result.document;changed();
 modal('编辑报价表',`<div class="document-editor"><div class="document-toolbar"><div><button data-add="line">＋ 生产线</button><button data-add="chapter">＋ 章节</button><button data-add="item">＋ 部件 / 配套</button><button data-add="note">＋ 说明</button></div><div><button data-action="up">↑ 上移</button><button data-action="down">↓ 下移</button><button data-action="promote">← 升级</button><button data-action="demote">→ 降级</button><button id="document-remove">移除</button><button id="document-undo">撤销</button></div></div><p id="document-status" role="status"></p><div class="document-workspace"><aside><div id="document-tree" aria-label="报价层级"></div><div id="document-inspector"></div></aside><div class="document-paper-wrap"><div class="document-preview-heading"><strong>报价表 · 实时预览</strong><span>点选报价行，在左侧修改；修改同步到主页面，Excel / PDF 使用同一张表</span></div><div id="document-preview" tabindex="0"></div></div></div></div>`,'<button id="document-format">列、编号与样式</button><button id="document-excel" class="primary">导出 Excel</button><button id="document-pdf">导出 PDF</button><button id="document-back">返回报价</button>',true);
 const host=$('.document-editor');state={host,quoteId:q.id,model:result.model,selected:q.exportDocument.nodes.some(n=>n.id===previous)?previous:q.exportDocument.nodes[0]?.id,request:0,history:[],revealPreview:true};const owner=state;$('#modal').classList.add('document-dialog');$('#modal').addEventListener('close',()=>{$('#modal').classList.remove('document-dialog');clearTimeout(owner.timer);owner.request++;},{once:true});
 host.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{try{add(b.dataset.add);}catch(e){toast(e.message);}});host.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{try{mutate('调整报价层级',()=>q.exportDocument=QuoteQuotationDocument.change(q.exportDocument,state.selected,b.dataset.action));}catch(e){toast(e.message);}});
 $('#document-remove').onclick=()=>{try{remove();}catch(e){toast(e.message);}};$('#document-undo').onclick=()=>{
  const prior=state.history.pop();if(!prior)return;const focus=viewState();q.exportDocument=prior.document;state.selected=prior.selected;
  if(prior.exportConfig)q.exportConfig=prior.exportConfig;else delete q.exportConfig;
  for(const [id,row] of prior.rows){const index=q.rows.findIndex(r=>r.id===id);if(row){if(index>=0)q.rows[index]=row;else q.rows.push(row);}else if(index>=0)q.rows.splice(index,1);}
  changed();renderRows();refreshSummary();drawTree({reveal:true});drawInspector();restoreView(prior.view);revealTreeSelection();markPreviewSelection();restoreFocus(focus);state.revealPreview=true;schedule();
 };
 $('#document-back').onclick=()=>{closeModal();renderQuote();};$('#document-format').onclick=()=>{closeModal();busy(QuoteQuotationLayoutUI.open);};
 function exportNow(pdf){if(!state.model.completeness.canFinalize){q.exportMode='draft';delete q.deliveryConfirmation;closeModal();QuoteBusinessUI.exportBusiness(pdf);}else{closeModal();openExportOptions();}}
 $('#document-excel').onclick=()=>exportNow(false);$('#document-pdf').onclick=()=>exportNow(true);
 drawTree();drawInspector();drawPreview();schedule();
}
root.QuoteQuotationDocumentUI={open};
})(window);
