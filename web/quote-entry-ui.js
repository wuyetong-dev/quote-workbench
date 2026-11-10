(function(root){
'use strict';
let mode='import',library=null,loading=null,brief='',questions=[],answers=[],selected=new Set(),quantities=new Map(),sourceId='',find='';
async function getLibrary(refresh=false){if(library&&!refresh)return library;if(!loading)loading=api('quote-entry/catalog').then(v=>library=v).finally(()=>loading=null);return loading;}
async function adopt(next){M.matchParts(next,parts.filter(p=>!p.referenceOnly));KnowledgeUI.prepare(next);await saveNow();q=next;templateEdit=null;filter='all';quoteSearch='';page='quote';await saveNow();renderQuote();toast('已生成过程报价，可直接修改');}
function mount(){
 const bar=$('.quote-context-bar');if(!bar)return;
 const host=document.createElement('section');host.className='quote-entry';host.id='quote-entry';bar.before(host);
 host.innerHTML='<div class="segmented entry-tabs" role="group" aria-label="报价方式">'+[['import','Excel导入'],['sentence','一句话报价'],['selection','勾选报价']].map(([v,label])=>'<button data-entry-mode="'+v+'" class="'+(mode===v?'active':'')+'">'+label+'</button>').join('')+'</div><div id="entry-panel"></div>';
 host.querySelectorAll('[data-entry-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.entryMode;mountPanel();host.querySelectorAll('[data-entry-mode]').forEach(v=>v.classList.toggle('active',v.dataset.entryMode===mode));});
 mountPanel();
}
function mountPanel(){
 const panel=$('#entry-panel');$('#dropzone').hidden=mode!=='import';
 if(mode==='import'){panel.innerHTML='';return;}
 if(mode==='sentence'){
  panel.innerHTML='<div class="entry-sentence"><textarea id="entry-brief" aria-label="报价需求" placeholder="例如：做一条全自动挂镀镍线，先按企业已有方案出基础报价">'+E(brief)+'</textarea><div id="entry-questions">'+questions.map((s,i)=>'<label>'+E(s)+'<input data-entry-answer="'+i+'" value="'+E(answers[i]||'')+'"></label>').join('')+'</div><button id="entry-generate" class="primary">'+(questions.length?'补充后生成':'生成基础报价')+'</button><span id="entry-message" role="status"></span></div>';
  $('#entry-brief').oninput=e=>brief=e.target.value;
  document.querySelectorAll('[data-entry-answer]').forEach(e=>e.oninput=()=>answers[Number(e.dataset.entryAnswer)]=e.value);
  $('#entry-generate').onclick=()=>busy(async()=>{
   if(!brief.trim())throw Error('请说一下要做的设备或生产线');
   const button=$('#entry-generate');button.disabled=true;$('#entry-message').textContent='正在理解需求并匹配企业方案…';
   try{const [catalog,plan]=await Promise.all([getLibrary(true),api('quote-entry-plan',{brief:[brief,...questions.map((v,i)=>answers[i]?v+'：'+answers[i]:'')].filter(Boolean).join('\n')})]);
    if(plan.questions.length){questions=plan.questions;answers=[];mountPanel();$('#entry-questions input')?.focus();return;}
    const next=QuoteEntry.assemble(catalog,plan,{mode:'sentence'});questions=[];answers=[];mode='import';await adopt(next);
   }finally{if(button.isConnected){button.disabled=false;$('#entry-message').textContent='';}}
  });return;
 }
 panel.innerHTML='<p role="status">正在读取已有方案…</p>';
 getLibrary(true).then(value=>{if(mode!=='selection'||!panel.isConnected)return;
  if(!value.sources.length){panel.innerHTML='<p>还没有已有方案。可导入历史报价后存为模板，或在部件库维护配置。</p>';return;}
  if(!value.sources.some(s=>s.id===sourceId))sourceId=value.sources[0].id;
  panel.innerHTML='<div class="entry-picker-tools"><select id="entry-source" aria-label="已有线路或部件库">'+value.sources.map(s=>'<option value="'+E(s.id)+'" '+(s.id===sourceId?'selected':'')+'>'+E(s.title)+'</option>').join('')+'</select><input id="entry-find" type="search" aria-label="查找已有设备配置" placeholder="查找设备、规格" value="'+E(find)+'"><span id="entry-count"></span><button id="entry-compose" class="primary">生成报价</button></div><div id="entry-tree" class="entry-tree"></div>';
  $('#entry-source').onchange=e=>{sourceId=e.target.value;drawTree();};$('#entry-find').oninput=e=>{find=e.target.value;searchTree();};drawTree();
  $('#entry-compose').onclick=()=>busy(async()=>{
   const selections=[...selected].map(k=>({key:k,selfOnly:true,changes:quantities.has(k)?{quantity:quantities.get(k)}:{}}));
   const next=QuoteEntry.assemble(value,{title:'勾选报价',basis:'基础方案来自所选企业配置；历史规格与价格保留来源，按本单实际条件调整。',selections});
   selected.clear();quantities.clear();mode='import';await adopt(next);
  });
 }).catch(e=>{if(panel.isConnected)panel.textContent='读取失败：'+e.message;});
}
function drawTree(){
 const source=library.sources.find(s=>s.id===sourceId),rows=new Map(source.rows.map(r=>[r.id,r])),nodes=source.document.nodes;
 const child=id=>nodes.filter(n=>(n.parentId||null)===id),rowKeys=n=>[...(n.rowId?[source.id+'::'+n.id]:[]),...child(n.id).flatMap(rowKeys)];
 function render(n){const row=rows.get(n.rowId),kids=child(n.id),k=source.id+'::'+n.id,label=row?.name||n.title||'配置';
  const line='<label class="entry-choice"><input type="checkbox" data-entry-check="'+E(n.id)+'"><span>'+E(label)+'</span></label>'+(row?'<label class="entry-quantity">数量<input type="number" min="0" step="any" data-entry-quantity="'+E(n.id)+'" aria-label="'+E(label)+'数量" value="'+E(quantities.has(k)?quantities.get(k)??'':row.quantity??'')+'"></label>':'');
  return '<div data-entry-node="'+E(n.id)+'" data-entry-text="'+E([label,row?.spec].join(' ').toLowerCase())+'">'+(kids.length?'<details'+(n.type==='line'?' open':'')+'><summary>'+line+'</summary><div class="entry-children">'+kids.map(render).join('')+'</div></details>':'<div class="entry-leaf">'+line+'</div>')+(row?.spec?'<small class="entry-spec">'+E(row.spec.slice(0,150))+'</small>':'')+'</div>';
 }
 $('#entry-tree').innerHTML=child(null).map(render).join('');
 function sync(){for(const el of document.querySelectorAll('[data-entry-check]')){const n=nodes.find(n=>n.id===el.dataset.entryCheck),keys=rowKeys(n),count=keys.filter(k=>selected.has(k)).length;el.checked=keys.length>0&&count===keys.length;el.indeterminate=count>0&&count<keys.length;}$('#entry-count').textContent='已选 '+selected.size+' 项';$('#entry-compose').disabled=!selected.size;}
 document.querySelectorAll('[data-entry-check]').forEach(el=>el.onchange=()=>{
  const n=nodes.find(n=>n.id===el.dataset.entryCheck);for(const k of rowKeys(n)){if(el.checked)selected.add(k);else selected.delete(k);}
  if(el.checked){let parent=n.parentId;while(parent){const p=nodes.find(v=>v.id===parent);if(!p)break;if(p.rowId)selected.add(source.id+'::'+p.id);parent=p.parentId;}}
  sync();
 });
 document.querySelectorAll('[data-entry-quantity]').forEach(el=>el.onchange=()=>{quantities.set(source.id+'::'+el.dataset.entryQuantity,M.number(el.value));});
 sync();searchTree();
}
function searchTree(){const tree=$('#entry-tree');if(!tree)return;const nodes=[...tree.querySelectorAll('[data-entry-node]')];for(const node of nodes.reverse()){node.hidden=!!find&&!node.dataset.entryText.includes(find.toLowerCase())&&![...node.querySelectorAll('[data-entry-node]')].some(n=>!n.hidden);if(find&&!node.hidden)node.querySelector('details')?.setAttribute('open','');}}
root.QuoteEntryUI={mount};
})(window);
