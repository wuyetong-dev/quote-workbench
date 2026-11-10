(function(root){
'use strict';
function candidates(row){const seen=new Set();return (row.knowledgeEvidence?.priceMatches||[]).flatMap(match=>(match.candidates||[]).map(candidate=>({match,candidate}))).filter(({candidate:c})=>{const key=JSON.stringify([c.name,c.spec,c.unit,c.price]);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,3);}
function source(row,record){
 const ranges=row.bom?.sourceRanges||[],basis=row.bom?.quantityBasis||'',hasSheet=Boolean(sourceForQuoteRow(row));
 const references=(record?.sourceRefs||[]).map(ref=>typeof ref==='string'?ref:[ref.filename||ref.source,ref.location].filter(Boolean).join(' · ')).filter(Boolean);
 modal('部件来源',`<h3>${E(row.name)}</h3><p>${E(row.source||'手动添加')}</p>
  <h4>原始规格</h4><pre class="source-view">${E(row.rawSpec||row.spec)}</pre>
  ${row.parameterConflicts?.length?`<p class="warning">${E(row.parameterConflicts.join('；'))}</p>`:''}
  ${basis||ranges.length?`<h4>数量与原单元格</h4><p>${E(basis)}</p><div class="source-addresses">${ranges.map(range=>`<span>${E(range)}</span>`).join('')}</div>`:''}
  ${row.engineeringRequirements?.length?`<details><summary>原配置与工程要求</summary><ul>${row.engineeringRequirements.map(r=>`<li>${E(typeof r==='string'?r:r.text)}</li>`).join('')}</ul></details>`:''}
  ${record?`<h4>历史候选来源</h4>${references.length?`<ul>${references.map(ref=>`<li>${E(ref)}</li>`).join('')}</ul>`:''}<p>${E(record.spec)}</p>`:''}`,
  hasSheet?'<button id="open-row-source-sheet" class="primary">查看对应原表</button>':'',true);
 if(hasSheet)document.querySelector('#open-row-source-sheet').onclick=()=>showSource(row);
}
function mountRows(){
 const displayed=new Map(B.presentation(q).orderedRows.map(r=>[r.id,r.quotation]));
 document.querySelectorAll('[data-row]').forEach(tr=>{
  const row=q.rows.find(r=>r.id===tr.dataset.row);if(!row)return;
  tr.dataset.businessCode=displayed.get(row.id)?.code||row.business?.code||'';tr.dataset.parentId=displayed.get(row.id)?.parentId||row.parentId||row.bom?.parentId||'';tr.dataset.depth=String(displayed.get(row.id)?.depth??row.business?.depth??0);
  const name=tr.querySelector('.row-name');
  if(name&&!name.querySelector('.business-code')){const code=document.createElement('strong');code.className='business-code';const parent=q.rows.find(p=>p.id===(row.parentId||row.bom?.parentId));code.textContent=(displayed.get(row.id)?.code||row.business?.customerCode||((row.business?.depth||0)>0?'↳ 配套':''))+(parent&&M.isRequirement(parent)?' · 属'+parent.name:'');name.prepend(code);}
  tr.querySelectorAll('.row-name .row-source:not(.row-warning)').forEach(el=>el.remove());

  const label=tr.querySelector('.price-cell .row-source');if(label){label.textContent=row.pricing?.mode==='linked_reference'?'已确认整组项目参考价':row.priceEvidence?'已确认历史候选':row.pricing?.mode==='assembly'?(row.pricing.scope==='linked'?'规格价表待确认':row.priceSource):row.pricing?.mode==='formula'?'已确认公式':row.pricing?.mode==='manual'?'人工确认价':'';label.removeAttribute('title');}
  if(row.pricing?.mode==='assembly'){
   const button=tr.querySelector('.formula-button');if(button){const pending=row.basePrice==null||row.pricing.pendingInclusions?.length;button.textContent=pending?'去待补齐':row.pricing.scope==='linked'?'联槽价格 / 计算方式':'主体已算 · 保温 / 外包';button.onclick=()=>pending?root.QuotePendingUI.open({rowId:row.id}):row.pricing.scope==='linked'?QuoteLinkedPriceUI.open(row.id):extras(row);}
   const note=tr.querySelector('.calculation-status');if(note)note.textContent=row.pricing.scope==='linked'?(row.linkedPriceMatch?.reason||'按槽型、单节尺寸、材质和节数匹配整组参考价'):[...(row.pricing.issues||[]),...(row.pricing.pendingInclusions||[])].join('；');
  }
  if(row.pricing?.mode==='linked_reference'){const button=tr.querySelector('.formula-button');if(button){button.textContent='查看整组参考价依据';button.onclick=()=>QuoteLinkedPriceUI.open(row.id);}const note=tr.querySelector('.calculation-status');if(note)note.textContent=row.linkedPriceMatch?.reason||'项目参考整组价，已确认';}

 });
}
function mount(){
 mountRows();
 const summary=document.querySelector('#summary');if(!summary)return;
 const linked=q.rows.filter(r=>r.bom?.role==='tank'&&QuoteAssemblyPricing.linked(r));
 let pricing=document.querySelector('#linked-pricing-summary');
 if(q.linkedPriceTable||q.linkedReferenceHistory?.length){
  if(!pricing){pricing=document.createElement('div');pricing.id='linked-pricing-summary';pricing.className='linked-pricing-summary';summary.append(pricing);}
  const applied=linked.filter(r=>r.pricing?.mode==='linked_reference'&&r.pricing.confirmed).length;
  const matched=linked.filter(r=>r.linkedPriceMatch?.status==='matched').length;
  pricing.innerHTML=`<button id="linked-pricing-open">联槽参考价格</button>
   <small>${linked.length} 项联槽${q.linkedPriceTable?' · 可确认 '+matched+' 项 · 已确认 '+applied+' 项':' · 待读取价表'}</small>
   ${q.linkedReferenceHistory?.length?'<button id="linked-pricing-undo" class="quiet">撤销上次参考价采用</button>':''}`;
  pricing.querySelector('#linked-pricing-open').onclick=policy;
  const undo=pricing.querySelector('#linked-pricing-undo');if(undo)undo.onclick=()=>QuoteLinkedPriceUI.undo();
 }else pricing?.remove();
}
function policy(){return QuoteLinkedPriceUI.open();}
function extras(row){
 if(row.pricing?.pendingInclusions?.length||row.pricing?.issues?.length)return root.QuotePendingUI.open({rowId:row.id});
 const A=QuoteAssemblyPricing,p=row.pricing,items=p.adjustments||[];
 modal('槽体主体与附加结构报价',`<p><strong>${E(row.name)}</strong> · 主体基础单价 ¥${money(p.bodyPrice)}</p><p>主体按已确认公式计算；保温与外包按下面的包含范围计价。</p>${items.map((item,i)=>`<section class="extra-structure"><strong>${E(item.label)}</strong><p>${E(item.spec||'原配置已要求该结构')}</p><div class="form-grid"><div class="form-field"><label for="extra-choice-${i}">报价包含范围</label><select id="extra-choice-${i}"><option value="pending" ${item.choice==='pending'?'selected':''}>含 / 另计待确认</option><option value="included" ${item.choice==='included'?'selected':''}>包含在当前主体报价</option><option value="separate" ${item.choice==='separate'?'selected':''}>另计附加价</option></select></div><div class="form-field"><label for="extra-fixed-${i}">另计固定单价（元 / 本槽）</label><input id="extra-fixed-${i}" type="number" min="0" step="0.01" value="${item.fixedPrice??''}"></div><div class="form-field"><label for="extra-rate-${i}">或按面积单价（元 / ㎡）</label><input id="extra-rate-${i}" type="number" min="0" step="0.01" value="${item.rate??''}"></div><div class="form-field"><label>五面面积（㎡）</label><p>${item.area??'尺寸待补'}</p></div></div></section>`).join('')}`,'<button id="extra-pricing-save" class="primary">保存包含范围与附加价</button>',true);
 document.querySelector('#extra-pricing-save').onclick=()=>{row.extraPricing=row.extraPricing||{};items.forEach((item,i)=>row.extraPricing[item.kind]={choice:document.querySelector('#extra-choice-'+i).value,fixedPrice:document.querySelector('#extra-fixed-'+i).value,rate:document.querySelector('#extra-rate-'+i).value});A.apply(q);closeModal();changed();renderQuote();toast('主体价与附加结构已更新');};
}
async function exportBusiness(pdf){await busy(async()=>{await saveNow();if(pdf){const blob=await api('business-pdf',q);previewUrl=URL.createObjectURL(blob);modal('业务报价 PDF 预览',`<iframe title="业务报价PDF预览" src="${previewUrl}"></iframe>`,'<button id="download-business-pdf" class="primary">下载业务报价 PDF</button>',true);document.querySelector('#download-business-pdf').onclick=()=>QuoteExporter.download(blob,safeFilename(q.title)+'-业务报价.pdf');}else{const blob=q.exportTemplateId==='custom'?await QuoteBusinessExporter.excel(await api('prepare-business-export',q)):await api('reference-excel',q);QuoteExporter.download(blob,safeFilename(q.title)+'-业务报价.xlsx');toast('业务报价 Excel 已导出');}});}
root.QuoteBusinessUI={mount,mountRows,source,policy,extras,exportBusiness};
})(window);
