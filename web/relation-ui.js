(function(root){
'use strict';
const R=root.QuoteRelations,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function prepare(q){
 const fragments=root.QuoteDecomposition.fragments(q),tasks=R.tasks(q,fragments,root.QuoteDecomposition.baseline(q)),offers=new Map();
 const blocks=tasks.map(t=>{
  let choices=R.proposals(q,t);const ai=(q.relationReview||[]).find(r=>r.taskId===t.id&&r.taskBasis===t.basis&&r.status==='proposal');
  if(ai){const d=ai.decision;if(t.type==='allocation'&&!choices.some(c=>JSON.stringify(c.allocations)===JSON.stringify(d.allocations)))choices.unshift({label:d.allocations.map(a=>t.targets.find(r=>r.rowId===a.rowId).owner+' '+a.quantity).join(' / ')+t.unit,allocations:d.allocations});else if(t.type==='assembly')choices.sort((a,b)=>Number(b.dimensions===d.dimensions)-Number(a.dimensions===d.dimensions));}
  choices=[...new Map(choices.map(c=>[JSON.stringify([c.dimensions,c.quantity,c.method,c.allocations]),c])).values()];offers.set(t.id,{task:t,choices});
  const id=esc(t.id);
  const custom=t.type==='allocation'?t.targets.map(r=>'<label>'+esc(r.owner)+'<input type="number" min="0" step="any" data-allocation-task="'+id+'" data-allocation-row="'+esc(r.rowId)+'" value="'+(r.quantity??'')+'" placeholder="'+esc(t.unit)+'" aria-label="'+esc(r.owner+t.name)+'分配数量"></label>').join(''):'<div class="pending-fields"><label>尺寸含义<select data-relation-dimensions="'+id+'"><option value="">请选择</option><option value="section">每节尺寸</option><option value="total_length">整组总长</option><option value="total_width">整组总宽</option><option value="total_height">整组总高</option></select></label><label>每处组数<input data-relation-quantity="'+id+'" type="number" min="0" step="any"></label><label>计价方式<select data-relation-method="'+id+'"><option value="">请选择</option><option value="stations">各节主体价相加</option><option value="existing">沿用本单口径</option></select></label></div>';
  const first=q.rows.find(r=>r.id===t.targets[0].rowId);
  const html='<section class="pending-context relation-choice" data-context="'+id+'"><strong>'+(t.type==='allocation'?'数量分配 · 共'+t.total+esc(t.unit):'联槽尺寸 · '+[t.geometry.length,t.geometry.width,t.geometry.height].join('×')+'mm')+'<small> · '+t.targets.length+'处'+(t.type==='assembly'?' · 各节主体计价':'')+'</small></strong><div class="relation-actions">'+choices.map((c,i)=>'<button type="button" data-relation-quick="'+id+'" data-choice="'+i+'">'+esc(c.label)+'</button>').join('')+'<input type="hidden" data-relation-use="'+id+'" value=""></div>'+(choices.length?'<details><summary>自行填写</summary>'+custom+'</details>':custom)+'<details><summary>原文依据</summary>'+(t.type==='allocation'?(t.evidence||[]).map(e=>'<p>'+esc(e.quote)+'<br><small>'+esc(e.range)+'</small></p>').join(''):'<p>'+esc(first.rawSpec||first.spec)+'</p><small>快捷方案需本次确认；附加结构费用保留。</small>')+'</details></section>';
  return {id:t.id,type:'relation',relationType:t.type,label:t.type==='allocation'?'数量分配':'联槽尺寸',rowIds:t.targets.map(r=>r.rowId),fields:t.type==='allocation'?['quantity']:['quantity','price'],html};
 });
 function apply(quote,host,source){let draft=quote,count=0;
  for(const [id,{task,choices}]of offers){const value=host.querySelector('[data-relation-use="'+id+'"]')?.value;
   if(value!==''&&value!=null){const choice=choices[Number(value)];if(!choice)throw Error('方案已更新');draft=R.choose(draft,task,choice,source);count+=task.targets.length;continue;}
   if(task.type==='allocation'){const fields=[...host.querySelectorAll('[data-allocation-task="'+id+'"]')];if(fields.some(f=>f.value!==String(task.targets.find(r=>r.rowId===f.dataset.allocationRow).quantity??''))){if(fields.some(f=>f.value===''))throw Error('请填齐分配数量');draft=R.choose(draft,task,{allocations:fields.map(f=>({rowId:f.dataset.allocationRow,quantity:Number(f.value)}))},source);count+=task.targets.length;}}
   else{const dimensions=host.querySelector('[data-relation-dimensions="'+id+'"]')?.value,quantity=host.querySelector('[data-relation-quantity="'+id+'"]')?.value,method=host.querySelector('[data-relation-method="'+id+'"]')?.value;if(dimensions||quantity||method){draft=R.choose(draft,task,{dimensions,quantity,method},source);count+=task.targets.length;}}
  }return {quote:draft,count};
 }
 return {blocks,html:blocks.map(b=>b.html).join(''),apply,tasks};
}
root.QuoteRelationUI={prepare};
})(window);
