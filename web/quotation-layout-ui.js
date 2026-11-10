(function(root){
'use strict';
const clone=v=>structuredClone(v);
function mount(){
 $('#process-review')?.remove();let button=$('#quote-layout-button');
 if(!button&&$('#quote-export')){button=document.createElement('button');button.id='quote-layout-button';button.textContent='编辑报价表';button.title='编辑生产线、章节、设备和配套，修改同步到本表及导出文件';$('.table-toolbar>strong')?.after(button);}
 if(button){button.disabled=!q.rows.length;button.onclick=()=>busy(QuoteQuotationDocumentUI.open);}
 document.querySelectorAll('[data-row]').forEach(tr=>{const row=q.rows.find(r=>r.id===tr.dataset.row);if(!row||M.isRequirement(row))return;const cell=tr.querySelector('.spec-cell');if(cell&&!cell.querySelector('.quote-description-edit')){const b=document.createElement('button');b.className='quiet quote-description-edit';b.textContent='补强 / 报价说明';b.onclick=()=>busy(()=>description(row));cell.append(b);}});
}
async function settings(){const saved=await api('export-config');return {revision:0,config:clone(q.exportConfig||saved.config)};}
async function open(){
 const quoteId=q.id,initial=await settings();
 if(!q.exportConfig){
  const model=await api('export-config-preview',{quote:q,config:initial.config});
  initial.config.chapters.definitions=model.chapters.map(ch=>({...clone(initial.config.chapters.definitions.find(d=>d.id===ch.id)||{id:ch.id,sourceChapterNumbers:[],nameContains:[]}),number:ch.chapterNo,title:ch.chapterTitle}));
  initial.config.chapters.hideEmpty=false;
 }
 modal('本单章节与报价格式','<div id="export-format"></div>','<button id="quote-format-back">返回报价</button>',true);
 $('#quote-format-back').onclick=closeModal;
 await QuoteExportConfigUI.mount({getQuote:()=>q,api:async(path,body)=>{
  if(path==='export-config'&&!body)return initial;
  if(path==='export-config'&&body){if(q.id!==quoteId)throw Error('报价已切换，请重新打开');q.exportConfig=clone(body.config);changed();renderQuote();return {revision:body.revision+1,config:clone(body.config)};}
  return api(path,body);
 }});
 $('#export-format .format-heading p').textContent='只调整本单。可添加章节、改名、填写章号或上下移动；主设备与配套一起归章。';
 $('#format-save').textContent='保存到本单';
}
async function description(row){
 const cfg=await settings(),model=await api('export-config-preview',{quote:q,config:cfg.config}),item=model.chapters.flatMap(ch=>ch.rows).find(r=>r.id===row.id);
 const definitions=cfg.config.chapters.definitions,parent=row.parentId||row.bom?.parentId;
 modal('补强与报价说明',`<h3>${E(row.name)}</h3><p>尺寸、材质和数量沿用当前规格。需要改变它们时，请返回“修改尺寸 / 材质”。</p><pre class="source-view">${E(item?.description||row.spec)}</pre><label>补强说明<textarea id="quotation-reinforcement" placeholder="原资料或本次确认的补强做法">${E(row.reinforcement||'')}</textarea></label><label>其他报价说明<textarea id="quotation-remark">${E(row.quoteRemark||'')}</textarea></label>${!parent?`<label>所属章节<select id="quotation-chapter"><option value="">自动归章</option>${definitions.map(d=>`<option value="${E(d.id)}">${E(d.title)}</option>`).join('')}</select></label>`:'<p>配套设备随主设备归章。</p>'}`,'<button id="quotation-description-save" class="primary">保存说明</button>',true);
 if($('#quotation-chapter'))$('#quotation-chapter').value=row.exportChapterId||'';
 $('#quotation-description-save').onclick=()=>{QuoteWorkflow.checkpoint('修改报价说明');row.reinforcement=$('#quotation-reinforcement').value.trim();row.quoteRemark=$('#quotation-remark').value.trim();if($('#quotation-chapter'))row.exportChapterId=$('#quotation-chapter').value;changed();closeModal();renderQuote();};
}
root.QuoteQuotationLayoutUI={mount,open};
})(window);
