(function(root){
'use strict';
const M=typeof module!=='undefined'&&module.exports?require('./model.js'):root.QuoteModel;
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const clone=v=>structuredClone(v),key=(s,n)=>s.id+'::'+n.id;
function index(library){const all=new Map();for(const source of library.sources){const rows=new Map(source.rows.map(r=>[r.id,r]));for(const node of source.document.nodes)all.set(key(source,node),{source,node,row:rows.get(node.rowId)});}return all;}
function expanded(library,selections){
 const all=index(library),chosen=new Map();
 for(const selection of selections){const found=all.get(selection.key);if(!found)throw Error('所选方案已更新，请重新勾选');
  const visit=node=>{const k=key(found.source,node),old=chosen.get(k);chosen.set(k,{...found,node,row:found.source.rows.find(r=>r.id===node.rowId),selection:old?.selection?.changes&&Object.keys(old.selection.changes).length?old.selection:selection});
   if(!selection.selfOnly)for(const child of found.source.document.nodes.filter(n=>n.parentId===node.id))visit(child);};visit(found.node);
 }
 // Configuration choices must retain their device and chapter context, once.
 for(const item of [...chosen.values()]){let parent=item.node.parentId;while(parent){const node=item.source.document.nodes.find(n=>n.id===parent);if(!node)throw Error('原方案层级不完整');const k=key(item.source,node);if(!chosen.has(k))chosen.set(k,{...item,node,row:item.source.rows.find(r=>r.id===node.rowId),selection:{line:item.selection.line}});parent=node.parentId;}}
 return {all,chosen};
}
function assembleSingle(library,plan,{mode='selection'}={}){
 const q=M.draft(),{chosen}=expanded(library,plan.selections||[]),aliases=new Map(),nodes=[],items=[];
 const caseSources=[...new Map([...chosen.values()].filter(v=>v.source.historyBookId).map(v=>[v.source.id,v.source])).values()];
 const contexts=[...new Set(caseSources.map(s=>JSON.stringify(s.priceContext||{})))];
 if(contexts.length===1&&caseSources.length){const context=caseSources[0].priceContext;if(context?.currency==='CNY'&&['included','excluded'].includes(context.taxMode)&&M.number(context.taxRate)!=null){q.taxMode=context.taxMode;q.taxRate=M.number(context.taxRate);}}
 q.title=String(plan.title||'勾选报价');q.exportMode='draft';q.notes=String(plan.basis||'');
 for(const [k,v]of chosen){aliases.set(k,M.uid());if(v.row)aliases.set(v.source.id+'::row:'+v.row.id,M.uid());}
 const remap=(value,source)=>{if(Array.isArray(value))return value.map(v=>remap(v,source));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,source)]));return typeof value==='string'?(aliases.get(source.id+'::row:'+value)||value):value;};
 // Use the original outline order, independent of click/AI selection order.
 for(const source of library.sources)for(const node of source.document.nodes){const k=key(source,node),item=chosen.get(k);if(!item)continue;
  const id=aliases.get(k),parentId=node.parentId?aliases.get(key(source,{id:node.parentId})):null;
  const next={...clone(node),id,parentId};
  if(node.type==='line'&&item.selection.line)next.title=item.selection.line;
  if(item.row){const row=remap(clone(item.row),source),changes=item.selection.key===k?(item.selection.changes||{}):{};
   row.id=aliases.get(source.id+'::row:'+item.row.id);next.rowId=row.id;
   delete row.knowledgeEvidence;delete row.engineering;delete row.linkedPriceMatch;delete row.automaticSuggestions;delete row.origin;
   row.selected=true;row.override=null;row.basePrice=M.number(item.row.override)??M.number(item.row.basePrice);
   if(item.row.referenceOnly)row.basePrice=null;
   row.entryEvidence={sourceId:source.id,rowId:item.row.id,sourceTitle:source.title,origin:clone(source.origin),originalSpec:item.row.spec||'',originalQuantity:item.row.quantity,price:row.basePrice};
   row.entryEvidence.originPriceContext=clone(source.priceContext||{});
   if(source.historyBookId){
    // Historical selling conditions belong to the source, never to the new
    // project's effective context. The normal matcher decides adoption below.
    row.entryEvidence.historyBookId=source.historyBookId;row.entryEvidence.historicalSale=row.basePrice;
    row.basePrice=null;row.override=null;row.pricing={};delete row.priceContext;delete row.historyPriceContext;delete row.priceEvidence;
    const context=source.priceContext||{},quantityChanged=Object.hasOwn(changes,'quantity')&&M.number(changes.quantity)!==M.number(item.row.quantity),specChanged=['name','spec','unit'].some(f=>changes[f]!==undefined&&String(changes[f]).trim()!==String(item.row[f]||'').trim());
    const conflicting=context.currency&&context.currency!=='CNY'||q.taxMode!=='none'&&['included','excluded'].includes(context.taxMode)&&(context.taxMode!==q.taxMode||(context.taxRate??0)!==q.taxRate);
    // Selecting an unchanged case is a proposal to reuse that case's original
    // selling conditions, not a match against a different engineering request.
    // Keep its real sale as one reversible, case-wide proposal; final export is
    // blocked until the existing pending panel confirms its business scope.
    if(!quantityChanged&&!specChanged&&!conflicting&&!item.row.historyBlocked&&M.number(row.entryEvidence.historicalSale)!=null){
     row.basePrice=row.entryEvidence.historicalSale;row.override=row.basePrice;row.priceKind='confirmed_sale';row.pricing={mode:'manual'};
     row.priceEvidence={priceNature:'historical_case',sourceBookId:source.historyBookId,originPriceContext:clone(context),source:row.source};
     row.automaticSuggestions={price:{status:'pending',group:'historical-case:'+source.id,value:row.basePrice,message:'沿用历史方案原规格与售价；本单税运及供货范围需确认',basis:JSON.stringify([row.name,row.spec,row.unit,row.brand||'',row.basePrice])}};
    }
   }else if(source.priceContext&&['included','excluded'].includes(source.priceContext.taxMode)){
    const same=source.priceContext.taxMode===q.taxMode&&(source.priceContext.taxRate??0)===(q.taxRate??0)&&(source.priceContext.currency||'CNY')===(q.currency||'CNY');
    if(!same){row.basePrice=null;row.override=null;row.pricing={};row.entryEvidence.conditionDifference='历史税价或币种与本单不同';}
   }
   if(!source.historyBookId&&row.basePrice!=null&&M.number(item.row.override)!=null){row.override=M.number(item.row.override);row.priceKind='confirmed_sale';}
   row.source=row.source||source.title;row.priceSource=row.basePrice!=null?(source.historyBookId?'历史方案原口径 · 待本单确认 · ':'基础方案历史价 · ')+source.title:row.priceSource||'';
   if(row.basePrice!=null&&!['formula','assembly','linked_reference'].includes(row.pricing?.mode))row.pricing={mode:'manual'};
   const invalidates=['name','spec','unit'].some(f=>changes[f]!==undefined&&String(changes[f]).trim()!==String(row[f]||'').trim());
   for(const f of ['name','spec','unit'])if(changes[f]!==undefined){F.edit(row,f,String(changes[f]));row[f]=String(changes[f]);}
   if(invalidates){row.basePrice=null;row.override=null;row.pricing={};delete row.calculation;delete row.engineeringBill;delete row.priceEvidence;delete row.geometry;row.fields=[];row.rawSpec=row.spec;row.parameterConflicts=[];row.priceSource='规格已变更，重新匹配或计算';}
   if(Object.hasOwn(changes,'quantity')){row.quantity=M.number(changes.quantity);row.quantityEdited=true;row.quantityBasis=mode==='sentence'?'本次需求明确数量':'本次勾选数量';}
   if(source.historyBookId&&row.basePrice!=null)row.historyReuseBasis=M.historyBasis(row,q);
   items.push(row);
  }
  nodes.push(next);
 }
 const newLines=new Map(),newChapters=new Map(),newRows=new Map();
 for(const item of plan.newItems||[]){
  if(!String(item.name||'').trim())continue;
  const line=String(item.line||q.title),chapter=String(item.chapter||'设备明细');
  if(!newLines.has(line)){const existing=nodes.find(n=>n.type==='line'&&n.title===line);const id=existing?.id||M.uid();newLines.set(line,id);if(!existing)nodes.push({id,type:'line',title:line,parentId:null});}
  const chapterKey=line+'|'+chapter;if(!newChapters.has(chapterKey)){const id=M.uid();newChapters.set(chapterKey,id);nodes.push({id,type:'chapter',title:chapter,parentId:newLines.get(line)});}
  const id=M.uid(),nodeId=M.uid(),row={id,name:String(item.name),spec:String(item.spec||''),unit:String(item.unit||''),quantity:M.number(item.quantity),basePrice:null,override:null,selected:true,brand:'',group:chapter,source:'本次报价需求',quantityBasis:'本次需求；未给定数量时留空',entryEvidence:{new:true}};
  items.push(row);newRows.set(line+'|'+item.name,{row,nodeId,item,chapterId:newChapters.get(chapterKey)});nodes.push({id:nodeId,type:'item',rowId:id,parentId:newChapters.get(chapterKey)});
 }
 for(const [lookup,{row,nodeId,item}]of newRows){const line=lookup.split('|')[0],parent=newRows.get(line+'|'+item.parent);if(item.parent&&parent&&parent.nodeId!==nodeId){nodes.find(n=>n.id===nodeId).parentId=parent.nodeId;row.parentId=parent.row.id;row.bom={role:'accessory',parentId:parent.row.id,supplyStatus:'confirmed'};}}
 if(!items.length)throw Error('请至少选择一项设备或配置');
 q.rows=items;q.exportDocument={version:1,nodes};q.entryOrigin={mode,brief:plan.brief||'',basis:plan.basis||'',sources:[...new Set([...chosen.values()].map(i=>i.source.id))],version:'2026-11-09.quote-entry.1'};
 M.autoPrice(q);return q;
}
function assemble(library,plan,options={}){
 const lines=new Set([...(plan.selections||[]).map(s=>s.line||''),...(plan.newItems||[]).map(s=>s.line||'')]);
 if(lines.size<=1)return assembleSingle(library,plan,options);
 const quotes=[...lines].map(line=>assembleSingle(library,{...plan,selections:(plan.selections||[]).filter(s=>(s.line||'')===line),newItems:(plan.newItems||[]).filter(s=>(s.line||'')===line)},options));
 const q=quotes[0];q.title=plan.title||q.title;q.rows=quotes.flatMap(v=>v.rows);q.exportDocument.nodes=quotes.flatMap(v=>v.exportDocument.nodes);q.entryOrigin.sources=[...new Set(quotes.flatMap(v=>v.entryOrigin.sources))];M.autoPrice(q);return q;
}
root.QuoteEntry={index,expanded,assemble};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteEntry;
})(typeof window!=='undefined'?window:globalThis);
