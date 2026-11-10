(function(root){
'use strict';
let examples=[],selected='',undo=null;
const D=()=>root.QuoteDecomposition;
const cleanHeader=value=>M.clean(value);
async function hashId(value){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function mappingIndex(mappings){
 const index=Object.create(null);
 for(const mapping of mappings)(index[JSON.stringify(mapping.headerRows[0])]??=[]).push(mapping);
 return index;
}
async function excel(file,{process=false}={}){
 const buffer=await file.arrayBuffer(),names=XLSX.read(buffer,{type:'array',bookSheets:true}).SheetNames,sheets=names.length>1?await chooseSheets(names):names;
 if(!sheets)return null;
 if(!process)return QuoteImporter.parse(buffer,file.name,XLSX,{sheets});
 const [mappings,rules]=await Promise.all([api('process-mappings'),api('process-scope-rules')]);
 const quote=QuoteImporter.parse(buffer,file.name,XLSX,{sheets,processMappings:mappingIndex(mappings),allowUnmapped:true});
 if(quote.sources.some(s=>s.type==='process')){QuoteBOM.applyApprovedScopes(quote,rules);B.attach(quote);}
 return quote;
}
const processSources=()=>q.sources?.filter(s=>s.type==='process'||s.type==='unmapped'||!s.type&&QuoteImporter.standardProcess(s))||[];
const standard=s=>s.standardProcess||QuoteImporter.standardProcess(s);
function stationView(source,station){
 modal('工艺字段与原表位置',`<p>${E(source.sheet)} · 第 ${station.row} 行 · ${E(station.operation)}</p><p>${station.candidateGroup?'候选工位组 '+E(station.candidateGroup):''}</p><table><thead><tr><th>字段</th><th>原值</th><th>位置</th></tr></thead><tbody>${station.fields.filter(f=>f.raw!=='').map(f=>`<tr><td>${E(f.path.join(' / ')||f.label)}${f.blocked?' · 待确认':''}</td><td>${E(f.raw)}</td><td>${E(f.range)}</td></tr>`).join('')}</tbody></table>`,'<button id="process-back">返回预览</button>',true);
 $('#process-back').onclick=preview;
}
function preview(){
 const sources=processSources(),stations=sources.flatMap(source=>(standard(source)?.sections||[]).flatMap(section=>section.stations.map(station=>({source,station}))));
 modal('工艺拆解预览',`<p>已保存草稿 · ${stations.length} 个工位 · ${q.rows.filter(r=>!M.isRequirement(r)).length} 项供货明细</p><div class="knowledge-tasks">${stations.map(({source,station},i)=>`<article><button data-process-station="${i}" class="quiet">${E(station.stationNumber||station.order)} · ${E(station.operation)}</button><small>${E(source.sheet)} · 第 ${station.row} 行</small></article>`).join('')||'<p>尚未识别工序列。请在待核对中指定表头和字段映射。</p>'}</div>`,'<button id="process-preview-review">待核对</button><button id="process-preview-continue" class="primary">继续编辑报价</button>',true);
 $('#modal').querySelectorAll('[data-process-station]').forEach(button=>{button.onclick=()=>{const {source,station}=stations[Number(button.dataset.processStation)];stationView(source,station);};});
 $('#process-preview-review').onclick=review;
 $('#process-preview-continue').onclick=closeModal;
}
function mappingEditor(source,section){
 const heading=section?.headerRow||1,depth=section?section.startRow-heading:1;
 const option=(c,label,selected)=>`<option value="${c}" ${selected?'selected':''}>${E(label)}</option>`;
 const draw=()=>{
  const row=Number($('#mapping-header').value)-1,levels=Number($('#mapping-depth').value),matching=section?.headerRow===row+1?section:null;
  const width=source.rows[row]?.length||0,columns=Array.from({length:width},(_,c)=>({c,label:XLSX.utils.encode_col(c)+' · '+(matching?.columns[c]?.path.join(' / ')||source.rows.slice(row,row+levels).map(r=>r[c]).filter(v=>M.text(v)).join(' / '))}));
  $('#mapping-fields').innerHTML=`<p>工序列 <select id="mapping-operation" aria-label="工序列">${columns.map(({c,label})=>option(c,label,c===matching?.nameColumn)).join('')}</select> 工位号列 <select id="mapping-station" aria-label="工位号列">${option('','按原表顺序',matching?.stationColumn==null)}${columns.map(({c,label})=>option(c,label,c===matching?.stationColumn)).join('')}</select></p><details open><summary>选择要修正的字段</summary>${columns.map(({c,label})=>`<label class="field">${E(label)}<input data-mapping-column="${c}" value="${E(matching?.columns[c]?.mapped||'')}" placeholder="例如 过滤机 / 数量 或 主槽 / 长(mm)"></label>`).join('')}</details>`;
 };
 modal('确认字段映射',`<p>${E(source.sheet)}。选择工序列，并为有歧义的字段填写设备 / 字段。应用后生成一份新底稿，便于和当前草稿核对。</p><label>表头起始行 <input id="mapping-header" type="number" min="1" max="${source.rows.length}" value="${heading}"></label> <label>表头层数 <input id="mapping-depth" type="number" min="1" max="30" value="${Math.max(1,depth)}"></label><div id="mapping-fields"></div>`,'<button id="mapping-apply" class="primary">保存映射并生成新底稿</button>',true);
 $('#mapping-header').onchange=draw;$('#mapping-depth').onchange=draw;draw();
 $('#mapping-apply').onclick=()=>busy(async()=>{
  const header=Number($('#mapping-header').value)-1,depth=Number($('#mapping-depth').value);
  const headerRows=source.rows.slice(header,header+depth).map(row=>row.map(cleanHeader));
  const name=Number($('#mapping-operation').value),seq=$('#mapping-station').value===''?null:Number($('#mapping-station').value);
  if(header<0||depth<1||depth!==headerRows.length||name===seq||!headerRows[0]?.length)throw Error('请核对表头行、层数及工位列');
  const id=await hashId(JSON.stringify(headerRows));
  const columns=Object.fromEntries([...$('#modal').querySelectorAll('[data-mapping-column]')].filter(input=>input.value.trim()).map(input=>[input.dataset.mappingColumn,input.value.trim().split(/\s*\/\s*(?![^()]*\))/).join(' / ')]));
  const profile={id,headerRows,name,seq,columns};
  const [stored,rules]=await Promise.all([api('process-mappings'),api('process-scope-rules')]);
  const mappings=stored.filter(entry=>entry.id!==id).concat(profile);
  const next=QuoteImporter.rebuildProcess(q,mappingIndex(mappings),XLSX);
  QuoteBOM.applyApprovedScopes(next,rules);B.attach(next);
  await api('process-mappings',profile);await saveNow();
  q=next;templateEdit=null;filter='all';await saveNow();closeModal();render();toast('映射已保存，已生成新报价底稿');
 });
}
function reviewSpecification(row){
 const sourceSpec=row.rawSpec||row.spec;
 modal('核对报价规格',`<p>${E(row.name)} · ${E(row.bom.sourceRanges?.join('；')||row.source)}</p><div class="knowledge-pair"><article><strong>原表规格</strong><pre class="source-view">${E(sourceSpec)}</pre></article><label class="field">工程确认的报价规格<textarea id="reviewed-spec" rows="5">${E(row.spec)}</textarea></label></div><label class="field">差异原因及依据<input id="reviewed-spec-reason" maxlength="500" value="${E(row.bom.specReview?.reason||'')}"></label>`,'<button id="confirm-reviewed-spec" class="primary">保存报价规格</button>',true);
 $('#confirm-reviewed-spec').onclick=()=>busy(async()=>{
  const spec=$('#reviewed-spec').value.trim(),reason=$('#reviewed-spec-reason').value.trim();
  if(!spec||!reason)throw Error('请填写报价规格和工程确认依据');
  F.edit(row,'spec',spec);row.bom.specReview={sourceSpec,confirmedSpec:spec,reason};
  M.autoPrice(q);changed();await saveNow();renderQuote();review();
 });
}
function review(){
 const sources=processSources(),sections=sources.flatMap(source=>{
  const groups=standard(source)?.sections||[];
  return groups.length?groups.map(section=>({source,section})): [{source,section:null}];
 });
 const mappingIssues=sections.flatMap(({source,section})=>section?section.issues:[{range:source.sheet,message:'未识别工序列，请指定表头与工序列'}]);
 const counts=new Map();
 for(const {source,section} of sections)for(const station of section?.stations||[])if(station.stationNumber){
  const locations=counts.get(station.stationNumber)||new Set();locations.add(source.sheet);counts.set(station.stationNumber,locations);
 }
 const duplicate=[...counts].filter(([,sheets])=>sheets.size>1);
 const list=items=>items.length?items.map(({name,message,range})=>`<article><strong>${E(name||'')}</strong><p>${E(message)}</p><small>${E(range||'')}</small></article>`).join(''):'<p>暂无。</p>';
 const supply=q.rows.filter(r=>!M.isRequirement(r)&&!M.isIncluded(r));
 const loc=r=>r.bom?.sourceRanges?.slice(0,6).join('；')||r.source;
 const specReview=supply.filter(r=>r.bom&&!r.geometry&&(r.bom.role==='accessory'||r.bom.role==='shared'||r.bom.explicitDevice));
 const sourceNotes=(q.warnings||[]).map(warning=>`<li>${E(warning)}</li>`).join('');
 modal('待核对',`<div class="knowledge-tasks">
  ${sourceNotes?`<section class="source-review-note"><h3>原资料提示</h3><ul>${sourceNotes}</ul>${q.sources?.length?'<button id="process-original-source">查看原表</button>':''}</section>`:''}
  <h3>字段与跨表对应</h3>${list(mappingIssues.concat(duplicate.map(([station,sheets])=>({name:'工位 '+station,range:[...sheets].join('、'),message:'多页出现相同工位号，请核对设备标识及服务范围'}))))}${sections.map(({source,section},i)=>`<button data-mapping-section="${i}">${E(source.sheet)}${section?' · 表头第 '+section.headerRow+' 行':''} · 确认字段映射</button>`).join('')}<h3>取量缺口</h3>${list(supply.filter(r=>M.number(r.quantity)===null).map(r=>({name:r.name,message:r.bom?.quantityBasis||'请核对供货数量和计量单位',range:loc(r)})))}<h3>规格与工程条件</h3>${list(supply.filter(r=>r.warning||r.geometryIssue||r.pricing?.issues?.length||r.bom?.chamberCount>1).map(r=>({name:r.name,message:r.warning||r.geometryIssue||r.pricing?.issues?.join('；')||'核对联槽整体尺寸和轴向',range:loc(r)})))}${specReview.length?`<details><summary>核对设备报价规格</summary>${specReview.map((r,i)=>`<article><button data-review-spec="${i}">${E(r.name)} · ${E(r.subgroup||'')}</button><small>${E(loc(r)||'')}</small></article>`).join('')}</details>`:''}<h3>供货范围待确认</h3>${q.rows.filter(M.isRequirement).map(r=>`<article><strong>${E(r.name)}</strong><p>${E(r.rawSpec||r.spec)}</p><small>${E(loc(r)||'')}</small><button data-confirm-part="${E(r.id)}">确认独立供货</button>${r.parentId&&q.rows.some(p=>p.id===r.parentId&&!M.isRequirement(p)&&!M.isIncluded(p))?`<button data-include-part="${E(r.id)}">确认已含在主项</button>`:''}</article>`).join('')||'<p>暂无。</p>'}</div>`,'<button id="process-review-done" class="primary">返回底稿</button>',true);
 const changeScope=(id,included)=>{
  const row=q.rows.find(r=>r.id===id);if(!row||!M.isRequirement(row))return;
  const status=included?'included':'confirmed';
  modal('确认供货范围',`<p>${E(row.name)} · ${included?'包内子项':'独立供货'}</p><p>${E(row.rawSpec||row.spec)}</p><p>${E(loc(row)||'')}</p><label class="field">判断依据<input id="scope-reason" maxlength="500"></label><details><summary>作为同规格供货规则复用</summary><p>复用要求工艺、源规格和主项完全对应。数量和价格从当前项目取证。</p><label class="field">适用条件<input id="scope-condition" maxlength="500"></label><label class="field">不适用的例子<input id="scope-counterexample" maxlength="500"></label></details>`,`<button id="scope-apply">仅应用本项目</button><button id="scope-store" class="primary">保存规则并应用</button>`,true);
  const accept=reuse=>busy(async()=>{
   const reason=$('#scope-reason').value.trim();
   if(!reason)throw Error('请填写本次判断依据');
   let ruleId;
   if(reuse){
    const condition=$('#scope-condition').value.trim(),counterexample=$('#scope-counterexample').value.trim();
    if(!condition||!counterexample)throw Error('复用规则需要适用条件和反例');
    const key=QuoteBOM.scopeKey(row,q.rows);ruleId=await hashId(key);
    await api('process-scope-rules',{id:ruleId,key,status,condition,counterexample,reason});
   }
   QuoteBOM.confirmScope(row,status,{ruleId,reason});
   changed();renderQuote();review();
  });
  $('#scope-apply').onclick=()=>accept(false);$('#scope-store').onclick=()=>accept(true);
 };
 $('#modal').querySelectorAll('[data-mapping-section]').forEach(button=>{button.onclick=()=>{const {source,section}=sections[Number(button.dataset.mappingSection)];mappingEditor(source,section);};});
 $('#modal').querySelectorAll('[data-review-spec]').forEach(button=>{button.onclick=()=>reviewSpecification(specReview[Number(button.dataset.reviewSpec)]);});
 $('#modal').querySelectorAll('[data-confirm-part]').forEach(button=>{button.onclick=()=>changeScope(button.dataset.confirmPart,false);});
 $('#modal').querySelectorAll('[data-include-part]').forEach(button=>{button.onclick=()=>changeScope(button.dataset.includePart,true);});
 $('#process-review-done').onclick=closeModal;
 if($('#process-original-source'))$('#process-original-source').onclick=showSource;
}
async function chooseExample(){examples=await api('decomposition-examples');return examples.find(x=>x.id===selected)||null;}
async function generate(draft){const example=await chooseExample(),plan=await api('decompose',D().request(draft,example));return {quote:D().apply(draft,plan,example),plan};}
async function importFile(file){
 if(!/\.(xlsx?|pdf|png|jpe?g|webp)$/i.test(file.name))return toast('请选择Excel、PDF或工艺图片');
 await busy(async()=>{
  if(file.size>20*1024*1024)throw Error('请选择20MB以内的工艺资料');
  let imported;
  const isExcel=/\.xlsx?$/i.test(file.name);
  if(isExcel)imported=await excel(file,{process:true});
  else {const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败'));reader.readAsDataURL(file);}),source=await api('extract-process',{filename:file.name,data});imported=M.draft();imported.title=file.name.replace(/\.[^.]+$/,'');imported.sources=[source];}
  if(!imported)return;
  if(!isExcel){const result=await generate(imported);imported=result.quote;if(!imported.rows.length)throw Error('原资料尚未形成可编辑部件；请检查来源');}
  await saveNow();q=imported;undo=null;M.matchParts(q,parts);q.priceReviewPending=true;templateEdit=null;filter='all';page='quote';await saveNow();render();
  toast(q.rows.length?'报价底稿已保存':'原表已保存，请核对工序和字段映射');
 });$('#file-input').value='';
}
function evidence(row){modal('部件拆解依据',`<h3>${E(row.name)}</h3><p>${E(row.scope)}</p><p>所属系统：${E(row.decompositionSystem)}</p><p>数量：${row.quantity??'待确认'} ${E(row.unit)}</p><h3>原文依据</h3>${(row.decomposition.evidence||[]).map(e=>`<pre class="source-view">${E(e.quote)}</pre>`).join('')||'<p>由拆解样例提出的模块候选，当前工艺未给出完整选型。</p>'}<p>${E(row.source)}</p><h3>还缺什么</h3><p>${E((row.decomposition.missing||[]).join('；')||'暂无模型标记的缺条件；可按原资料核对')}</p>`,'',true);}
function mountRows(){for(const tr of document.querySelectorAll('[data-row]')){const row=q.rows.find(r=>r.id===tr.dataset.row);if(!row?.decomposition)continue;const name=tr.querySelector('.row-name');if(name&&!name.querySelector('.decomposition-evidence')){const button=document.createElement('button');button.className='quiet decomposition-evidence';button.textContent=row.decomposition.relationship==='included'?'包内子件 · 查看拆解依据':'查看拆解依据';button.onclick=()=>evidence(row);name.append(button);}if(row.decomposition.relationship==='included'){const check=tr.querySelector('[data-key="selected"]');if(check){check.checked=false;check.disabled=true;}}}}
async function run(){await busy(async()=>{commitQuoteField();const before=structuredClone(q),result=await generate(q);undo=before;q=result.quote;delete q.decompositionError;changed();await saveNow();renderQuote();toast('补充拆出 '+q.decomposition.addedRowIds.length+' 项设备/模块');});}
function loadExample(){const input=document.createElement('input');input.type='file';input.accept='.xls,.xlsx';input.onchange=()=>busy(async()=>{if(!input.files[0])return;const parsed=await excel(input.files[0]);if(!parsed)return;const modules=D().modules(parsed);if(!modules.length)throw Error('所选工作表没有可用的人工拆解明细');const example={id:M.uid(),name:input.files[0].name,modules,createdAt:new Date().toISOString()};await api('decomposition-examples',example);selected=example.id;examples.unshift(example);advanced();toast('已载入 '+modules.length+' 类拆解模块；样例的数量和价格不带入新项目');});input.click();}
function advanced(){
 const data=q.decomposition;
 modal('高级功能',`<h3>可选模型补查</h3>
  <p>使用当前工艺资料补查漏项。Excel 导入和本地核价可直接完成。</p>
  ${q.decompositionError?`<p class="warning">${E(q.decompositionError)}</p>`:''}
  <div class="form-field"><label for="decomposition-example-select">拆解样例</label>
   <select id="decomposition-example-select"><option value="">不使用样例</option>${examples.map(x=>`<option value="${E(x.id)}" ${x.id===selected?'selected':''}>${E(x.name)}</option>`).join('')}</select>
  </div>
  <div class="actions"><button id="decompose-process" class="primary">模型补查漏项</button><button id="decomposition-example">载入人工拆解样例</button>
   ${undo?'<button id="decomposition-undo">撤销本次拆解</button>':''}
   ${data?'<button id="decomposition-coverage">查看覆盖情况</button>':''}
  </div>`);
 $('#decompose-process').onclick=()=>{closeModal();root.QuoteWorkflow.startAI().catch(e=>toast(e.message));};
 $('#decomposition-example').onclick=loadExample;
 $('#decomposition-example-select').onchange=e=>selected=e.target.value;
 if(undo)$('#decomposition-undo').onclick=()=>busy(async()=>{q=undo;undo=null;closeModal();await saveNow();renderQuote();});
 if(data)$('#decomposition-coverage').onclick=()=>{
  const byId=new Map(D().fragments(q).map(f=>[f.id,f])),chapters=B.view(q).sections.filter(s=>s.rows.length);
  modal('整线拆解覆盖情况',`<h3>系统与部件</h3>${chapters.map(s=>`<p><strong>${E(s.title)}</strong> · ${s.rows.length} 项</p>`).join('')}<h3>尚未建立新增部件对应的来源</h3><p>其中可能包含表头、工艺约束，以及已由原解析覆盖的内容；保留逐段核对。</p>${data.unresolvedSourceIds.map(id=>`<details><summary>${E(byId.get(id)?.source||id)}</summary><pre class="source-view">${E(byId.get(id)?.text)}</pre></details>`).join('')}`,'',true);
 };
}
function mount(){
 if(undo&&undo.id!==q.id)undo=null;
 const panel=$('#decomposition-panel');if(!panel)return;
 panel.innerHTML='';
 $('#quote-advanced').onclick=advanced;
 mountRows();
}
async function init(){try{examples=await api('decomposition-examples');}catch{}mount();}
root.QuoteDecompositionUI={importFile,readExcel:excel,mount,mountRows,review,init};
})(window);
