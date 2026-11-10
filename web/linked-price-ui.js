(function(root){
'use strict';
const copy=value=>value===undefined?undefined:structuredClone(value);
function matches(){const L=QuoteLinkedPricebook,table=q.linkedPriceTable;return q.rows.filter(row=>row.bom?.role==='tank'&&QuoteAssemblyPricing.linked(row)).map(row=>({row,match:table?L.match(row,table,{quote:q}):null}));}
function dims(value){return value?[value.length,value.width,value.height].join('×')+'mm':'单节尺寸待核';}
function candidateMarkup(match){
 return (match?.candidates||[]).slice(0,3).map(entry=>`<div class="linked-reference-candidate"><b>¥${money(entry.price)}</b> · ${E(entry.name)}<small>${E([dims(entry.dimensions),entry.material,entry.thickness?entry.thickness+'mm板':'',entry.chambers+'节',...(entry.differences||[])].filter(Boolean).join(' · '))}</small></div>`).join('')||'—';
}
function partsMarkup(match){return match?.parts?.length?`<details class="linked-parts"><summary>逐工位拆解（${match.parts.length}个）</summary>${match.parts.map((part,index)=>`<div><b>工位${index+1} ${E(part.type||part.name)}</b><small>${E([dims(part.dimensions),part.material,part.match?.reason].filter(Boolean).join(' · '))}</small>${candidateMarkup(part.match)}</div>`).join('')}</details>`:'';}
function snapshot(rows){return {confirmed:q.linkedPriceTable?.confirmed===true,selections:copy(q.linkedReferenceSelections),rows:rows.map(row=>({id:row.id,basis:F.basis(row),basePrice:row.basePrice,override:row.override,pricing:copy(row.pricing),priceSource:row.priceSource,priceEvidence:copy(row.priceEvidence)}))};}
function adopt(ids){
 const rows=q.rows.filter(row=>ids.includes(row.id));q.linkedReferenceHistory=[...(q.linkedReferenceHistory||[]),snapshot(rows)];
 QuoteLinkedPricebook.apply(q,{table:q.linkedPriceTable,confirmed:true,rowIds:ids});changed();renderQuote();open();toast('已采用所选整组项目参考价，可撤销');
}
function undo(){
 const previous=q.linkedReferenceHistory?.pop();if(!previous)return;
 q.linkedReferenceSelections=copy(previous.selections);if(q.linkedPriceTable){q.linkedPriceTable.confirmed=previous.confirmed;delete q.linkedPriceTable.confirmedBasis;}
 for(const state of previous.rows){const row=q.rows.find(item=>item.id===state.id);if(row&&F.basis(row)===state.basis)for(const key of ['basePrice','override','pricing','priceSource','priceEvidence'])row[key]=copy(state[key]);}
 changed();renderQuote();toast('已恢复采用前的联槽价格状态');
}
function open(rowId){
 const selected=typeof rowId==='string'?q.rows.find(r=>r.id===rowId):null;
 if(!q.linkedPriceTable){
  modal(selected?selected.name+' · 联槽报价':'联槽报价',`<p>当前还没有整组参考报价，不需要逐条确认。</p><p>已有尺寸和材质保留。请为当前联槽选择已有计算方式，或填写本次确认的整组价格；主体能计算的部分继续保留。</p><div class="actions"><button id="linked-direct-edit" class="primary">${selected?'编辑这个槽的价格':'在报价表中填写价格'}</button><button id="linked-conditions">计算方式 / 批量核价</button></div><details><summary>已有旧报价，需要比对整组价格</summary><p>按槽型、单节尺寸、材质和节数核对参考价。</p><button id="linked-reference-import">导入联槽参考报价</button><input id="linked-reference-file" type="file" accept=".xlsx,.xls" hidden></details>`,'<button id="linked-close">返回报价</button>',true);
  $('#linked-close').onclick=closeModal;$('#linked-reference-import').onclick=()=>$('#linked-reference-file').click();$('#linked-reference-file').onchange=importReference;$('#linked-direct-edit').onclick=()=>{closeModal();if(selected)revealQuoteRow(selected.id);else busy(QuoteQuotationDocumentUI.open);};$('#linked-conditions').onclick=QuoteWorkflow.review;return;
 }
 const table=q.linkedPriceTable,items=matches().filter(item=>!selected||item.row.id===selected.id),ready=items.filter(item=>item.match?.status==='matched'),pending=items.length-ready.length;
 modal('联槽参考价格',`<p>按<strong>槽型＋单节尺寸＋材质＋节数</strong>逐项取整组项目参考价。矩形长宽互换为等价尺寸；板厚、材质、节数和槽型差异仍逐项保留。点“采用”才计入报价。</p><div class="actions"><button id="linked-reference-import">读取项目参考报价</button><input id="linked-reference-file" type="file" accept=".xlsx,.xls" hidden>${table?'<button id="linked-table-source" class="quiet">查看价表来源</button>':''}${q.linkedReferenceHistory?.length?'<button id="linked-modal-undo" class="quiet">撤销上次采用</button>':''}</div><p id="linked-table-status">${table?`整理${table.entries.length}条价格记录，${table.entries.filter(entry=>entry.usable).length}条规格完整；${items.length}项联槽中可确认${ready.length}项、待确认${pending}项`:'读取参考报价明细页后显示整组规格候选'}</p><div class="linked-price-table"><table><thead><tr><th>本项目联槽 / 单节规格</th><th>项目参考整组价</th><th>匹配结论与采用</th></tr></thead><tbody>${items.map(({row,match})=>{const can=match?.status==='matched',entry=match?.entry;return `<tr data-linked-row="${E(row.id)}" data-match-status="${E(match?.status||'no_table')}"><td><b>${E(row.business?.code||'')} ${E(row.name)}</b><small>${E([dims(row.geometry),row.geometry?.material,(row.bom?.chamberCount||row.geometry?.chambers)+'节'].join(' · '))}</small></td><td>${can?`<b>¥${money(entry.price)}</b><small>${E(entry.name)} · ${E(dims(entry.dimensions))} · ${E(entry.material)}</small><small>项目参考价、需确认</small>`:candidateMarkup(match)}</td><td><p>${E(match?.reason||'需读取规格价表')}</p>${can?`<button data-linked-adopt="${E(row.id)}" class="primary">${row.linkedPriceMatch?.applied?'再次采用':'采用'}</button>`:'<span class="linked-pending-label">待确认</span>'}${partsMarkup(match)}</td></tr>`;}).join('')}</tbody></table></div><p>混工序保留各工位槽型；没有对应整组依据的项目单列待确认，不相加或按节数外推。</p>`,'<button id="linked-confirm" class="primary" '+(!ready.length?'disabled':'')+'>采用全部 '+ready.length+' 项可确认参考价</button>',true);
 document.querySelector('#linked-reference-import').onclick=()=>document.querySelector('#linked-reference-file').click();
 document.querySelector('#linked-reference-file').onchange=importReference;
 document.querySelectorAll('[data-linked-adopt]').forEach(button=>button.onclick=()=>adopt([button.dataset.linkedAdopt]));
 document.querySelector('#linked-confirm').onclick=()=>adopt(ready.map(item=>item.row.id));
 const undoButton=document.querySelector('#linked-modal-undo');if(undoButton)undoButton.onclick=()=>{undo();open();};
 const sourceButton=document.querySelector('#linked-table-source');if(sourceButton)sourceButton.onclick=()=>{modal('查看原表信息 / 规格价表来源',`<pre class="source-view">${E(JSON.stringify({source:table.source,entries:table.entries,rejected:table.rejected},null,2))}</pre>`,'<button id="return-linked-table">返回联槽规格价表</button>',true);document.querySelector('#return-linked-table').onclick=open;};
}
async function importReference(event){
 const file=event.target.files[0];if(!file)return;
 try{const buffer=await file.arrayBuffer(),names=XLSX.read(buffer,{type:'array',bookSheets:true}).SheetNames,sheets=names.length>1?await chooseSheets(names):names;if(!sheets)return;if(sheets.length!==1)return toast('请选择一张参考报价明细工作表');await busy(async()=>{const parsed=QuoteImporter.parse(buffer,file.name,XLSX,{sheets}),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(value=>value.toString(16).padStart(2,'0')).join('');q.linkedPriceTable=QuoteLinkedPricebook.build(parsed,{sha256,filename:file.name,sheet:sheets[0]});q.linkedReferenceSelections={};q.linkedPricing={method:'specification_table',confirmed:false};QuoteLinkedPricebook.apply(q,{table:q.linkedPriceTable,confirmed:false});changed();await saveNow();renderQuote();open();});}catch(error){toast(error.message);}
}
root.QuoteLinkedPriceUI={open,undo};
})(window);
