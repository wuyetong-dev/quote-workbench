(function(root){
'use strict';
const clone=v=>structuredClone(v);
function ordered(document){const byParent=new Map();for(const n of document.nodes){const key=n.parentId||null;if(!byParent.has(key))byParent.set(key,[]);byParent.get(key).push(n);}const result=[],seen=new Set();function visit(n,depth){if(seen.has(n.id))throw Error('层级不能形成循环');seen.add(n.id);result.push({...n,depth});for(const c of byParent.get(n.id)||[])visit(c,depth+1);}for(const n of byParent.get(null)||[])visit(n,0);if(result.length!==document.nodes.length)throw Error('有内容没有有效上级');return result;}
function change(document,id,action){const d=clone(document),n=d.nodes.find(n=>n.id===id);if(!n)throw Error('请先选中一行');const siblings=d.nodes.filter(v=>(v.parentId||null)===(n.parentId||null)),index=siblings.findIndex(v=>v.id===id),parent=d.nodes.find(v=>v.id===n.parentId);
 if(action==='up'||action==='down'){const other=siblings[index+(action==='up'?-1:1)];if(!other)throw Error('已经到这一层的边界');const a=d.nodes.indexOf(n),b=d.nodes.indexOf(other);[d.nodes[a],d.nodes[b]]=[d.nodes[b],d.nodes[a]];}
 else if(action==='promote'){if(!parent)throw Error('已经是最高层级');if(!parent.parentId){if(n.type==='chapter'){n.type='line';n.parentId=null;}else throw Error('部件已直接属于生产线；可添加章节后归入');}else n.parentId=parent.parentId;}
 else if(action==='demote'){const previous=siblings.slice(0,index).reverse().find(v=>v.type!=='note');if(!previous)throw Error('前面没有可作为上级的内容');if(n.type==='line')n.type='chapter';n.parentId=previous.id;}
 ordered(d);return d;
}
function presentation(q){
 const raw=new Map(q.rows.map(r=>[r.id,r])),nodes=ordered(q.exportDocument),byId=new Map(nodes.map(n=>[n.id,n])),children=new Map();for(const n of nodes){if(!children.has(n.parentId||null))children.set(n.parentId||null,[]);children.get(n.parentId||null).push(n);}
 const sections=[],entries=[],seen=new Set(),continuous=q.exportConfig?.chapters?.numberingMode!=='configured';
 const cn=n=>n<10?'一二三四五六七八九'[n-1]:(n<20?'':'一二三四五六七八九'[Math.floor(n/10)-1])+'十'+(n%10?'一二三四五六七八九'[n%10-1]:'');
 for(const line of children.get(null)||[]){if(line.type!=='line')continue;const counters=new Map(),sectionCounts=new Map(),childCounts=new Map();let direct;
  entries.push({type:'line',id:line.id,title:line.title});
  function chapter(n,path=[]){const count=(counters.get(n.parentId)||0)+1;counters.set(n.parentId,count);const number=continuous?count:n.number||count,full=[...path,number],title=(path.length?'（'+cn(number)+'）':cn(number)+'、')+n.title.replace(/^[一二三四五六七八九十百\d]+[、.．]\s*/,'').replace(/^[、.．\s]+/,''),s={id:n.id,chapterNo:full.join('.'),chapterTitle:title,lineTitle:line.title,rows:[],path:full};sections.push(s);entries.push({type:'chapter',id:n.id,title});return s;}
  function visit(n,s,parent){if(n.type==='chapter'){s=chapter(n,s?.path||[]);parent=null;}else if(n.type==='note')entries.push({type:'note',id:n.id,title:n.title});else if(n.rowId&&raw.has(n.rowId)){
    s||=(direct||=chapter({id:'direct-'+line.id,parentId:line.id,title:'设备明细'}));const row=raw.get(n.rowId),requirement=row.kind==='requirement'||row.bom?.role==='requirement';let code='';
    if(!requirement){const key=parent?.id||s.id,map=parent?childCounts:sectionCounts,count=(map.get(key)||0)+1;map.set(key,count);code=parent?parent.quotation.code+'.'+count:s.chapterNo+'-'+String(count).padStart(2,'0');}
    const result={...row,quotation:{code,chapterId:s.id,chapterNo:s.chapterNo,chapterTitle:s.chapterTitle,lineId:line.id,lineTitle:line.title,parentId:parent?.id||null,depth:parent?(parent.quotation.depth||0)+1:0}};seen.add(row.id);s.rows.push(result);entries.push({type:'row',row:result});if(!requirement)parent=result;
   }for(const c of children.get(n.id)||[])visit(c,s,parent);
  }for(const n of children.get(line.id)||[])visit(n,null,null);
 }
 const projected=new Map(sections.flatMap(s=>s.rows).map(r=>[r.id,r]));
 for(const row of q.rows.filter(r=>!seen.has(r.id))){const parent=projected.get(row.parentId||row.bom?.parentId),s=parent?sections.find(s=>s.id===parent.quotation.chapterId):sections.find(s=>s.id==='auto-unassigned');let target=s;if(!target){target={id:'auto-unassigned',chapterNo:sections.length+1,chapterTitle:'未归章设备',lineTitle:'',rows:[]};sections.push(target);entries.push({type:'chapter',id:target.id,title:target.chapterTitle});}const result={...row,quotation:{...parent?.quotation,chapterId:target.id,chapterTitle:target.chapterTitle,parentId:parent?.id||null,depth:parent?(parent.quotation.depth||0)+1:0,code:''}};target.rows.push(result);entries.push({type:'row',row:result});}
 return {sections,orderedRows:entries.filter(e=>e.type==='row').map(e=>e.row),entries};
}
root.QuoteQuotationDocument={ordered,change,presentation};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteQuotationDocument;
})(typeof window!=='undefined'?window:globalThis);
