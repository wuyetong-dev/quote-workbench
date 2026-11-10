(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports,M=node?require('./model.js'):root.QuoteModel,R=node?require('./quote-repair.js'):root.QuoteRepair;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function remaining(quote){const result=M.calculate(quote);return new Set([...result.rows.filter(r=>r.selected!==false&&!M.isRequirement(r)&&!M.isIncluded(r)&&r.amount===null).map(r=>r.id),...(result.completeness?.issues||[]).map((v,i)=>v.rowId||'issue-'+i)]).size;}
function previewText(before,after){const delta=M.calculate(after).total-M.calculate(before).total;return '应用后，已计价金额将'+(delta<0?'减少':'增加')+' ¥'+money(Math.abs(delta))+'（仍有 '+remaining(after)+' 项待处理）';}
function categories(quote,plan,issues){
 const groups=new Map(),add=(key,label)=>{if(!groups.has(key))groups.set(key,{key,label,groups:[],issues:[],ids:new Set()});return groups.get(key);};
 for(const [i,g]of plan.groups.entries()){
  const row=quote.rows.find(r=>r.id===g.items[0]?.id),label=g.type==='price'?(row?.name||'设备价格'):g.type==='quantity'?'供货数量':g.type==='thickness'?'缺失板厚':'保温与外包';
  const c=add(g.type==='price'?'price:'+label:g.type,label);c.groups.push({g,index:i});g.items.forEach(item=>c.ids.add(item.id));
 }
 if(plan.linked.length){const c=add('linked','联槽计价');plan.linked.forEach(id=>c.ids.add(id));c.linked=true;}
 for(const issue of issues){
  const state=plan.rows.find(r=>r.id===issue.rowId),row=quote.rows.find(r=>r.id===issue.rowId);
  const handled=state?.blockers.filter(b=>b.decisionId)||[];
  if((issue.field==='quantity'&&handled.some(b=>b.type==='quantity'))||(issue.field==='basePrice'&&handled.some(b=>b.type!=='quantity')&&!state.blockers.some(b=>b.type!=='scope'&&!b.decisionId))||(/price_scope/.test(issue.code||issue.type)&&handled.some(b=>b.type==='scope')))continue;
  const unresolved=state?.blockers.filter(b=>!b.decisionId)||[];
  const label=unresolved.some(b=>['length','width','height'].includes(b.type))?'缺失尺寸':unresolved.some(b=>b.type==='material')?'未知材质':row&&M.isRequirement(row)?'供货范围':/conflict|duplicate/.test(issue.type)?'重复与冲突':/recognition|mapping|ai/.test(issue.type)?'资料识别':'其他待办';
  const c=add('other:'+label,label),identity=issue.rowId||issue.source||'issue-'+c.issues.length;
  const old=c.issues.find(x=>x.identity===identity);if(old)old.messages.push(issue.message);else c.issues.push({identity,issue,row,messages:[issue.message]});c.ids.add(identity);
 }
 return [...groups.values()].sort((a,b)=>Number(b.groups.some(x=>x.g.status==='candidate'))-Number(a.groups.some(x=>x.g.status==='candidate'))||b.ids.size-a.ids.size);
}
function concise(spec){return String(spec||'规格待补充').split(/\n/).map(s=>s.trim().replace(/^(规格|材质)[:：]\s*/,'' )).filter(Boolean).join(' · ').slice(0,100);}
function open(){return root.QuotePendingUI.open();}

root.QuoteReviewUI={open,categories,remaining,previewText};if(node)module.exports=root.QuoteReviewUI;
})(typeof window!=='undefined'?window:globalThis);
