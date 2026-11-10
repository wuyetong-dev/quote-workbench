(function(root){
'use strict';
const M=typeof module!=='undefined'&&module.exports?require('./model.js'):root.QuoteModel;
function groups(q){
 const A=typeof module!=='undefined'&&module.exports?require('./automation.js'):root.QuoteAutomation;
 const automatic=A.pending(q),automaticRows=new Set(automatic.map(s=>s.rowId));
 const computed=M.calculate(q),byId=new Map(computed.rows.map(r=>[r.id,r])),parents=new Map(q.rows.map(r=>[r.id,r.parentId||r.bom?.parentId]));
 const nodes=q.exportDocument?.nodes||[],nodeMap=new Map(nodes.map(n=>[n.id,n]));for(const n of nodes)if(n.rowId){let p=nodeMap.get(n.parentId);while(p&&!p.rowId)p=nodeMap.get(p.parentId);if(p?.rowId)parents.set(n.rowId,p.rowId);}
 const pending=r=>M.isRequirement(r)?!(typeof module!=='undefined'&&module.exports?require('./condition-binding.js'):root.QuoteConditionBinding).valid(r,computed.rows)&&!r.scopeReview?.confirmedAt:r.decomposition?.reviewState==='pending'||r.selected!==false&&!M.isIncluded(r)&&(r.amount==null||(r.pricing?.pendingInclusions||[]).length>0||automaticRows.has(r.id));
 const result=new Map();for(const row of computed.rows){let main=row,seen=new Set([row.id]);while(parents.get(main.id)&&byId.has(parents.get(main.id))&&!seen.has(parents.get(main.id))){main=byId.get(parents.get(main.id));seen.add(main.id);}if(!result.has(main.id))result.set(main.id,{id:main.id,name:main.name,main,rows:[],pending:0});const g=result.get(main.id);if(M.isRequirement(row)&&(typeof module!=='undefined'&&module.exports?require('./condition-binding.js'):root.QuoteConditionBinding).valid(row,computed.rows)){(g.conditions??=[]).push(row);}else g.rows.push(row);if(pending(row))g.pending++;}
 const active=[...result.values()].filter(g=>g.pending).map(g=>({...g,automatic:automatic.filter(s=>g.rows.some(r=>r.id===s.rowId))})),merged=new Set();
 // A selected historical case has one business-condition decision. Do not
 // make an operator reopen every already-priced device to confirm it.
 for(const group of new Set(automatic.filter(s=>s.group.startsWith('historical-case:')).map(s=>s.group))){
  const members=active.filter(g=>!merged.has(g.id)&&g.automatic.some(s=>s.group===group)&&g.rows.every(r=>!M.isRequirement(r)&&(r.amount!=null||M.historyTechnicalValid(r,q)&&M.number(r.override??r.basePrice)!=null)&&!(r.pricing?.pendingInclusions||[]).length&&!r.decomposition?.reviewState?.includes('pending')));
  if(!members.length)continue;const first=members[0];first.name='历史方案价格口径';first.batchScope=true;first.memberIds=members.flatMap(g=>g.rows.map(r=>r.id));first.pending=1;
  for(const g of members.slice(1)){first.rows.push(...g.rows);first.automatic.push(...g.automatic);merged.add(g.id);}
 }
 return active.filter(g=>!merged.has(g.id));
}
root.QuotePending={groups};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuotePending;
})(typeof window!=='undefined'?window:globalThis);
