(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports,M=node?require('./model.js'):root.QuoteModel,P=node?require('./pending.js'):root.QuotePending;
function build(q,blocks=[],issues=[]){
 const calculated=M.calculate(q),rows=new Map(calculated.rows.map(r=>[r.id,r])),groups=P.groups(q).map(g=>({...g,rows:[...g.rows]})),byRow=new Map(groups.flatMap(g=>g.rows.map(r=>[r.id,g])));
 function ensure(id){if(byRow.has(id))return byRow.get(id);const row=rows.get(id);if(!row)return null;let main=row,seen=new Set([id]);while(rows.has(main.parentId||main.bom?.parentId)&&!seen.has(main.parentId||main.bom?.parentId)){main=rows.get(main.parentId||main.bom?.parentId);seen.add(main.id);}let g=groups.find(g=>g.id===main.id);if(!g){g={id:main.id,name:main.name,main,rows:[main],pending:0};groups.push(g);byRow.set(main.id,g);}if(!g.rows.some(r=>r.id===id))g.rows.push(row);byRow.set(id,g);return g;}
 for(const b of blocks)for(const id of b.rowIds)ensure(id);for(const issue of issues)if(issue.rowId)ensure(issue.rowId);
 const merged=new Set();for(const b of blocks.filter(b=>b.relationType==='assembly'||b.type==='scope'&&b.rowIds.every(id=>M.isRequirement(rows.get(id))))){const members=[...new Set(b.rowIds.map(id=>byRow.get(id)))].filter(Boolean);if(members.length<2||members.some(g=>!b.rowIds.includes(g.id)))continue;const first=members[0];if(b.type==='scope')first.batchScope=true;first.memberIds=members.map(g=>g.id);for(const g of members.slice(1)){first.rows.push(...g.rows.filter(r=>!first.rows.some(x=>x.id===r.id)));first.conditions=[...(first.conditions||[]),...(g.conditions||[])];first.pending+=g.pending;for(const r of g.rows)byRow.set(r.id,first);merged.add(g.id);}}
 const placed=new Map(),fields=new Map(),links=new Map();
 for(const b of blocks){const first=b.rowIds.find(id=>byRow.has(id));if(!first)continue;if(!placed.has(first))placed.set(first,[]);placed.get(first).push(b);for(const id of b.rowIds){for(const field of b.fields||[]){const key=id+'|'+field;if(!fields.has(key))fields.set(key,{block:b.id,rowId:first});}if(id!==first){if(!links.has(id))links.set(id,[]);links.get(id).push({block:b.id,rowId:first,label:b.label});}}}
 return {groups:groups.filter(g=>!merged.has(g.id)),placed,fields,links,byRow,rows};
}
root.QuotePendingWorkspace={build};if(node)module.exports=root.QuotePendingWorkspace;
})(typeof window!=='undefined'?window:globalThis);
