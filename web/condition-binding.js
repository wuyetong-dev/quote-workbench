(function(root){
'use strict';
const text=v=>String(v??'').normalize('NFKC').trim();
const sourceText=row=>text(row.spec||row.rawSpec);
function parentId(row){return row.parentId||row.bom?.parentId;}
function condition(row,rows){
 const parent=rows.find(r=>r.id===parentId(row));
 if(!parent||parent.kind==='requirement'||parent.bom?.role==='requirement')return null;
 const spec=sourceText(row),lines=spec.split('\n').map(s=>s.trim()).filter(Boolean);
 if(!lines.length)return null;
 let temperature=false,ambient=true;
 for(const line of lines){
  const match=line.match(/^([^:：]+)[:：]\s*(.+)$/);if(!match)return null;
  const label=match[1].split('/').at(-1).replace(/\([^)]*\)/g,'').replace(/\s/g,''),value=match[2].trim();
  if(/^(?:工艺|处理|停留)?时间(?:MIN|S|秒|分钟)?$/i.test(label)){
   if(!/^[\d\s.～~至–—\-]+(?:MIN|S|H|秒|分钟|分|小时)?$/i.test(value))return null;
  }else if(/^(?:工艺|工作)?温度(?:°?C|℃)?$|^槽温(?:°?C|℃)?$/i.test(label)){
   temperature=true;
   if(!/^(?:室温|常温|RT)$/i.test(value)){ambient=false;if(!/^[\d\s.～~至–—\-]+(?:°?C|℃)?$/i.test(value))return null;}
  }else if(/^使用场景\//.test(match[1])&&/^(?:手动线|自动线|半自动线)$/.test(label)){
   if(!/^(?:√|✓|是|适用|有)$/.test(value)||!row.bom?.sourceRanges?.length)return null;
  }else return null;
 }
 const hardware=rows.filter(r=>parentId(r)===parent.id&&r.selected!==false&&r.kind!=='requirement'&&r.bom?.role!=='requirement'&&/加温|加热|换热|冷却|制冷/.test(r.name));
 if(temperature&&!ambient&&!hardware.length)return null;
 return {parentId:parent.id,basis:spec,method:'source-process-condition',hardwareIds:temperature&&!ambient?hardware.map(r=>r.id):[]};
}
function valid(row,rows){
 const b=row.conditionBinding;if(!b)return !!row.bom?.resolved;
 const current=condition(row,rows),parent=rows.find(r=>r.id===b.parentId);
 return !!current&&b.method===current.method&&b.parentId===current.parentId&&b.basis===current.basis&&JSON.stringify(b.hardwareIds||[])===JSON.stringify(current.hardwareIds)&&!!parent?.engineeringRequirements?.some(e=>e.requirementId===row.id&&e.text===b.basis);
}
function apply(q){
 const changes=[];
 for(const row of q.rows||[]){
  if(row.kind!=='requirement'&&row.bom?.role!=='requirement')continue;
  if(row.scopeReview?.confirmedAt)continue;
  const old=row.conditionBinding;
  if(row.bom?.resolved&&!old)continue; // Preserve explicit human decisions.
  const binding=condition(row,q.rows);
  if(old&&!valid(row,q.rows)){
   for(const parent of q.rows)if(parent.engineeringRequirements)parent.engineeringRequirements=parent.engineeringRequirements.filter(e=>e.requirementId!==row.id);
   delete row.conditionBinding;row.bom={...row.bom,resolved:false};
  }
  if(!binding||valid(row,q.rows)&&row.conditionBinding)continue;
  row.conditionBinding=binding;row.bom={...row.bom,resolved:true};
  const parent=q.rows.find(r=>r.id===binding.parentId);
  parent.engineeringRequirements=[...(parent.engineeringRequirements||[]).filter(e=>e.requirementId!==row.id),{text:binding.basis,source:row.source,requirementId:row.id}];
  changes.push({rowId:row.id,type:'condition'});
 }
 return changes;
}
root.QuoteConditionBinding={apply,valid,condition,sourceText};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteConditionBinding;
})(typeof window!=='undefined'?window:globalThis);
