(function(root){
'use strict';
const C=()=>root.QuoteCalculation;
function open(row,onSave,legacy){
 const c=structuredClone(row.calculation||{}),rules=(q.calculationRules||[]).filter(r=>r.approved);
 modal('计价方法',`<p><strong>${E(row.name)}</strong> · 每 ${E(row.unit||'件')} 的基础单价</p><div class="form-grid"><div class="form-field"><label for="calc-method">计算方式</label><select id="calc-method"><option value="fixed">确认单价</option><option value="components">多部件 / 成套组成</option><option value="rule">企业公式</option><option value="geometry">槽体材料与几何公式</option></select></div><div class="form-field"><label for="calc-kind">价格口径</label><select id="calc-kind">${Object.entries(C().KINDS).map(([id,label])=>`<option value="${id}">${E(label)}</option>`).join('')}</select></div></div><div id="calc-fields"></div><div class="form-field"><label for="calc-owner">确认人 / 负责人</label><input id="calc-owner" value="${E(c.confirmedBy||'报价员')}"></div><p id="calc-result" role="status"></p>`, '<button id="calc-cancel">取消</button><button id="calc-save" class="primary">确认计价</button>',true);
 $('#calc-method').value=c.method||(row.pricing?.mode==='formula'?'geometry':'fixed');$('#calc-kind').value=c.priceKind||row.priceKind||'enterprise_quote';
 let components=structuredClone(c.components||[{name:'',quantity:1,unitPrice:null,priceKind:'purchase_cost'}]);
 function draw(){
  const method=$('#calc-method').value;
  if(method==='geometry'){$('#calc-fields').innerHTML='<p>保留已确认的 C01/C02 正式口径，按尺寸、板厚、材料和结构条件计算。</p><button id="calc-geometry-open">填写槽体计算条件</button>';$('#calc-geometry-open').onclick=()=>{closeModal();legacy();};return;}
  if(method==='fixed')$('#calc-fields').innerHTML=`<div class="form-field"><label for="calc-fixed">基础单价（元）</label><input id="calc-fixed" type="number" min="0" step="0.01" value="${E(c.unitPrice??row.basePrice??'')}"></div>`;
  if(method==='components'){
   $('#calc-fields').innerHTML=`<div class="table-scroll"><table><thead><tr><th>组成名称</th><th>每套用量</th><th>单价</th><th>口径</th><th></th></tr></thead><tbody>${components.map((p,i)=>`<tr data-calc-part="${i}"><td><input data-calc-key="name" aria-label="组成名称" value="${E(p.name)}"></td><td><input data-calc-key="quantity" aria-label="每套用量" type="number" min="0" step="any" value="${p.quantity??''}"></td><td><input data-calc-key="unitPrice" aria-label="组成单价" type="number" min="0" step="0.01" value="${p.unitPrice??''}"></td><td><select data-calc-key="priceKind" aria-label="组成价格口径">${Object.entries(C().KINDS).map(([id,label])=>`<option value="${id}" ${id===p.priceKind?'selected':''}>${E(label)}</option>`).join('')}</select></td><td><button data-calc-remove="${i}" aria-label="删除组成">×</button></td></tr>`).join('')}</tbody></table></div><button id="calc-add" class="quiet">＋ 添加组成</button><div class="form-grid"><div class="form-field"><label for="calc-policy">成本转报价</label><select id="calc-policy"><option value="markup">成本加成</option><option value="margin">销售毛利</option></select></div><div class="form-field"><label for="calc-percent">比例（%）</label><input id="calc-percent" type="number" min="0" step="any" value="${c.salePolicy?.percent??0}"></div></div><p class="summary-note">成本组成需使用同一口径；每套计算结果再乘报价数量。</p>`;
   $('#calc-policy').value=c.salePolicy?.method||'markup';
   $('#calc-policy').onchange=$('#calc-percent').onchange=()=>{c.salePolicy={method:$('#calc-policy').value,percent:$('#calc-percent').value};};
   document.querySelectorAll('[data-calc-part] input,[data-calc-part] select').forEach(input=>input.onchange=()=>{const p=components[Number(input.closest('[data-calc-part]').dataset.calcPart)],key=input.dataset.calcKey;p[key]=['quantity','unitPrice'].includes(key)?M.number(input.value):input.value;});
   $('#calc-add').onclick=()=>{components.push({name:'',quantity:1,unitPrice:null,priceKind:'purchase_cost'});draw();};
   document.querySelectorAll('[data-calc-remove]').forEach(b=>b.onclick=()=>{components.splice(Number(b.dataset.calcRemove),1);draw();});
  }
  if(method==='rule'){
   $('#calc-fields').innerHTML=`<div class="form-field"><label for="calc-rule">已确认企业公式</label><select id="calc-rule"><option value="">请选择</option>${rules.map((r,i)=>`<option value="${i}">${E(r.label)} · ${E(r.version)}</option>`).join('')}</select></div><div id="calc-parameters"></div><details><summary>登记可复用的新公式</summary><p class="summary-note">使用普通算术表达式，例如：工时 × 每工时报价 + 辅料。经负责人确认后随本工程及模板复用。</p><div class="form-field"><label for="calc-rule-name">公式名称</label><input id="calc-rule-name"></div><div class="form-field"><label for="calc-rule-params">参数名称（逗号分隔）</label><input id="calc-rule-params" placeholder="工时,每工时报价,辅料"></div><div class="form-field"><label for="calc-rule-expression">表达式</label><input id="calc-rule-expression" placeholder="工时 × 每工时报价 + 辅料"></div><button id="calc-rule-register">确认并登记公式</button></details>`;
   function params(){const rule=rules[Number($('#calc-rule').value)];$('#calc-parameters').innerHTML=$('#calc-rule').value===''?'':`<div class="form-grid">${rule.parameters.map(p=>`<div class="form-field"><label>${E(p.label)}${p.unit?'（'+E(p.unit)+'）':''}<input data-calc-param="${E(p.id)}" aria-label="${E(p.label)}" type="number" step="any" value="${E(c.parameters?.[p.id]?.value??'')}"></label></div>`).join('')}</div>`;}
   $('#calc-rule').onchange=params;const selected=rules.findIndex(r=>r.id===c.ruleId&&r.version===c.ruleVersion);if(selected>=0)$('#calc-rule').value=String(selected);params();
   $('#calc-rule-register').onclick=()=>{try{const label=$('#calc-rule-name').value.trim(),labels=$('#calc-rule-params').value.split(/[,，]/).map(x=>x.trim()).filter(Boolean),owner=$('#calc-owner').value.trim();if(!label||!labels.length||!owner)throw Error('请填写公式名称、参数和确认人');const parameters=labels.map((name,i)=>({id:'p'+i,label:name,min:0})),rule={id:M.uid(),version:'1',label,priceKind:$('#calc-kind').value,approved:true,approvedBy:owner,approvedAt:new Date().toISOString(),parameters,expression:C().compile($('#calc-rule-expression').value,parameters)};QuoteWorkflow.checkpoint('登记企业公式');q.calculationRules=[...(q.calculationRules||[]),rule];rules.push(rule);changed();c.ruleId=rule.id;c.ruleVersion=rule.version;draw();toast('公式已登记，可随模板复用');}catch(error){$('#calc-result').textContent=error.message;}};
  }
 }
 function definition(){
  const method=$('#calc-method').value,confirmedBy=$('#calc-owner').value.trim(),d={method,priceKind:$('#calc-kind').value,confirmed:true,confirmedBy};
  if(method==='fixed')d.unitPrice=M.number($('#calc-fixed').value);
  if(method==='components'){d.components=[...document.querySelectorAll('[data-calc-part]')].map(tr=>Object.fromEntries([...tr.querySelectorAll('[data-calc-key]')].map(input=>[input.dataset.calcKey,['quantity','unitPrice'].includes(input.dataset.calcKey)?M.number(input.value):input.value]))).map(p=>({...p,confirmed:true}));d.salePolicy={method:$('#calc-policy').value,percent:M.number($('#calc-percent').value),confirmed:true,confirmedBy};}
  if(method==='rule'){if($('#calc-rule').value==='')throw Error('请选择已确认公式');const rule=rules[Number($('#calc-rule').value)];Object.assign(d,{ruleId:rule.id,ruleVersion:rule.version,parameters:{}});document.querySelectorAll('[data-calc-param]').forEach(input=>d.parameters[input.dataset.calcParam]={value:M.number(input.value)});}
  return d;
 }
 function preview(){try{if($('#calc-method').value==='geometry')return;const d=definition(),result=C().assign(structuredClone(row),d,q),reference=['purchase_cost','estimate'].includes(d.priceKind);$('#calc-save').textContent=reference?'记录'+C().KINDS[d.priceKind]:'确认报价';$('#calc-result').textContent=result.value!==null?`${reference?C().KINDS[d.priceKind]+'参考值':'报价基础单价'}：¥${money(result.value)} / ${row.unit||'件'}${reference?'。选择企业报价，可将成本按确认比例转成售价。':''}`:[...result.missing,...result.issues].join('；');const policy=$('#calc-percent');if(policy){policy.disabled=reference;$('#calc-policy').disabled=reference;}}catch(error){$('#calc-result').textContent=error.message;}}
 $('#calc-method').onchange=()=>{draw();preview();};draw();
 if(!$('#calc-save'))return;
 $('#calc-cancel').onclick=closeModal;
 $('#calc-kind').onchange=preview;$('#modal .modal-body').oninput=preview;$('#modal .modal-body').onchange=preview;preview();
 $('#calc-save').onclick=()=>{try{
  const method=$('#calc-method').value,confirmedBy=$('#calc-owner').value.trim();if(!confirmedBy)throw Error('请填写确认人');
  if(method==='geometry'){closeModal();return legacy();}
  const d=definition();if(method==='fixed'&&d.unitPrice===null)throw Error('请填写有效单价');if(method==='components'&&d.components.some(p=>!p.name.trim()||p.quantity===null||p.unitPrice===null))throw Error('请补齐组成名称、用量和单价');
  QuoteWorkflow.checkpoint('修改计价方法');const result=C().assign(row,d,q);closeModal();onSave();toast(result.status==='reference'?`已记录${C().KINDS[d.priceKind]} ¥${money(result.value)}，可在计价方法中转为报价`:result.basePrice===null?'条件已保存，仍有待补内容':'已更新计算单价');
 }catch(error){$('#calc-result').textContent=error.message;}};
}
root.QuoteCalculationUI={open};
})(window);
