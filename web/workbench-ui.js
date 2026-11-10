(function(root){
'use strict';
let cached=null,request=0;
const stamp=()=>q.id+'|'+q.updatedAt;
async function audit(){const id=++request,key=stamp(),result=await api('quote-audit',q);if(key!==stamp())throw Error('报价已更新，请重新核对');if(id===request)cached={key,result};return result;}
function issues(){return cached?.key===stamp()?cached.result.sourceAudit?.issues||[]:[];}
function mount(){
 $('#workbench-review')?.remove();if($('#quote-next'))$('#quote-next').hidden=true;
 let summary=$('#automation-summary');if(!summary&&$('#summary')){summary=document.createElement('div');summary.id='automation-summary';summary.className='automation-summary';$('#summary').append(summary);}
 if(summary){const a=q.automationSummary;summary.innerHTML=a?`<details><summary>整理情况</summary><small>自动整理：补数量 ${a.quantity} 项 · 匹配价格 ${a.price} 项 · 关联工艺 ${a.conditions} 项</small></details>`:'';}
 let commercial=$('#commercial-open');if(!commercial&&$('#summary')){commercial=document.createElement('button');commercial.id='commercial-open';commercial.textContent='附加费用 / 整单优惠';if($('#summary .total'))$('#summary .total').after(commercial);else $('#summary').append(commercial);}if(commercial){if($('#summary .total'))$('#summary .total').after(commercial);commercial.onclick=commercialOptions;}
 document.querySelectorAll('[data-row]').forEach(tr=>{const row=q.rows.find(r=>r.id===tr.dataset.row);if(!row)return;const pending=Object.values(row.automaticSuggestions||{}).some(s=>s.status==='pending');if(pending){const label=tr.querySelector('.price-cell .row-source');if(label)label.textContent='自动建议 · 待确认';}if(row.engineeringBill){const b=tr.querySelector('.formula-button');if(b){b.textContent='工程清单 · '+row.engineeringBill.items.length+'项';b.onclick=()=>QuoteEngineeringUI.open(row);}}});
}
function commercialOptions(){
 const c=q.commercial||{},current=M.calculate(q);
 modal('费用与整单优惠',`<div class="commercial-explanation"><p>附加费用会新增到本单明细；整单优惠只调整合计，设备单价保持原值。按本单税价口径在优惠后计税。</p><p>应用后更新主页面和以后导出的 Excel / PDF。导入的原始 Excel、已经导出的文件和已发正式版保持原样。</p></div><div class="form-grid"><label>优惠方式<select id="commercial-type"><option value="amount">减固定金额（元）</option><option value="percent">按整单比例优惠（%）</option></select></label><label id="commercial-value-label">优惠金额 / 比例<input id="commercial-value" type="number" min="0" step="0.01" value="${E(c.discountValue||0)}"></label></div><label class="commercial-reason">调整依据<input id="commercial-reason" value="${E(c.reason||'')}" placeholder="例如：本次议价、批量采购优惠"></label><label class="commercial-check"><input id="commercial-show-discount" type="checkbox" ${c.showDiscount!==false?'checked':''}>在导出的 Excel / PDF 中单独显示优惠金额</label><small>取消勾选仍按优惠后的成交价报价，仅隐藏优惠明细行。</small><h3>增加一项费用</h3><div class="form-grid"><label>费用名称<input id="fee-name" placeholder="运输、安装、包装等"></label><label>费用金额（元）<input id="fee-value" type="number" min="0" step="0.01"></label></div><div id="commercial-preview" class="commercial-preview" role="status"></div>`,'<button id="commercial-cancel">返回</button><button id="commercial-save" class="primary">应用到本单</button>');
 $('#commercial-type').value=c.discountType||'amount';
 const next=()=>({discountType:$('#commercial-type').value,discountValue:M.number($('#commercial-value').value),reason:$('#commercial-reason').value.trim(),showDiscount:$('#commercial-show-discount').checked});
 function preview(){try{const fee=M.number($('#fee-value').value)||0,value=QuoteCommercial.apply(Math.round((current.grossTotal+fee)*100)/100,{commercial:next()}),tax=q.taxMode==='excluded'?M.product(value.total,Number(q.taxRate||0)/100):0;$('#commercial-preview').innerHTML=`<p>当前明细小计 <b>¥${money(current.grossTotal)}</b></p><p>＋ 新增费用 <b>¥${money(fee)}</b></p><p>－ 整单优惠 <b>¥${money(value.discount)}</b></p>${q.taxMode==='excluded'?`<p>＋ 税额（${E(q.taxRate)}%） <b>¥${money(tax)}</b></p>`:''}<p class="commercial-final">本次${q.taxMode==='excluded'||q.taxMode==='included'?'含税':''}合计 <b>¥${money(Math.round((value.total+tax)*100)/100)}</b></p>`;}catch(e){$('#commercial-preview').textContent=e.message;}}
 for(const id of ['commercial-type','commercial-value','fee-value']){$('#'+id).oninput=preview;$('#'+id).onchange=preview;}preview();$('#commercial-cancel').onclick=closeModal;
 $('#commercial-save').onclick=()=>{try{const commercial=next(),fee=M.number($('#fee-value').value),name=$('#fee-name').value.trim();if(commercial.discountValue===null)throw Error('请填写有效优惠');if(commercial.discountValue&&!commercial.reason)throw Error('请填写调整依据');if((name||$('#fee-value').value)&&(fee===null||!name))throw Error('请填齐费用名称和金额');QuoteCommercial.apply(current.grossTotal+(fee||0),{commercial});commit('调整费用与优惠',()=>{q.commercialHistory=[...(q.commercialHistory||[]),{at:new Date().toISOString(),before:q.commercial||{},after:commercial}];q.commercial=commercial;if(name)q.rows.push({id:M.uid(),name,spec:'本单附加费用',quantity:1,unit:'项',basePrice:fee,override:fee,selected:true,brand:'',pricing:{mode:'manual'},priceKind:'confirmed_sale',priceSource:'人工附加费用',group:'附加费用',source:'本单费用调整'});});closeModal();}catch(e){toast(e.message);}};
}

function commit(label,fn){QuoteWorkflow.checkpoint(label);fn();M.autoPrice(q);changed();renderQuote();}
function open(){return root.QuotePendingUI.open();}
function applyAudit(draft,item,action,reason){
 if(!reason.trim())throw Error('请填写差异处理依据');
 if(!['recomputed','original','merge','distinct','add','accepted'].includes(action))throw Error('差异处理方式无效');
  const row=draft.rows.find(r=>r.id===item.rowId);
  if(['recomputed','original'].includes(action)&&!row)throw Error('原表对应项目已更新，请重新核对');
  if(action==='merge'&&(!item.rowIds?.length||item.rowIds.some(id=>!draft.rows.some(r=>r.id===id))))throw Error('重复项目已更新，请重新核对');
  if(action==='recomputed'&&row){F.edit(row,'basePrice',item.originalPrice);row.priceSource='原表量价复核';}
  if(action==='original'&&row){if(!(M.number(row.quantity)>0))throw Error('请先补齐本次数量');row.override=M.product(item.original/row.quantity,1);row.priceSource='按原金额折算 · 人工确认';}
  if(action==='merge'){const main=draft.rows.find(r=>r.id===item.rowIds[0]);for(const id of item.rowIds.slice(1)){const r=draft.rows.find(v=>v.id===id);r.selected=false;r.parentId=main.id;r.bom={...r.bom,role:'included',supplyStatus:'included',parentId:main.id,confirmed:true};}}
  if(action==='add')draft.rows.push({id:M.uid(),...item.item,selected:true,kind:'component',override:null,brand:'',group:'原表补入',priceSource:'原表单价'});
  draft.sourceAuditReviews=[...(draft.sourceAuditReviews||[]),{key:item.key,action,reason,at:new Date().toISOString()}];
 return draft;
}
root.QuoteWorkbenchUI={open,mount,audit,issues,applyAudit};
})(window);

