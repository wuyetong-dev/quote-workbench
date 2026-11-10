(function(root){
'use strict';
// Source cells own engineering parameters. These rules change sales granularity,
// never capacity, material, board thickness or selling prices.
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const Business=typeof module!=='undefined'&&module.exports?require('./business-structure.js'):root.QuoteBusinessStructure;
const clean=v=>String(v??'').normalize('NFKC').replace(/\s/g,'');
const text=v=>String(v??'').trim();
const num=v=>text(v)!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
const uid=()=>globalThis.crypto?.randomUUID?.()||'bom-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const positive=v=>text(v)!==''&&!/^(?:无|否|不需要|不含|×|✕|x|\/|0|—|-)$/i.test(clean(v));
const baseName=v=>clean(v).replace(/(?:第)?\d+(?:号|#)?$/,'');
const linkedWords=['','单','二','三','四','五','六','七','八','九','十'];
// Device vocabulary is deliberately separate from table positions and supply
// rules. One configuration groups its parameters and their original evidence;
// recognizing equipment never grants a quantity or a selling price.
const CONFIGURATION_FAMILIES=[
 {id:'cooling',name:'冷却换热配置',unit:'套',match:/制冷|冷却|冷水机|冰水机|换热器材质/},
 {id:'filter',name:'过滤机',unit:'台',match:/过滤(?:机|器)?/},
 {id:'rectifier',name:'整流机',unit:'台',match:/整流[机器]/},
 {id:'ultrasonic',name:'超声波系统',unit:'组',match:/超声波/},
 {id:'heating',name:'加热换热配置',unit:'组',match:/加热|加温|热水|热交换|热泵/},
 {id:'spray',name:'喷淋配置',unit:'套',match:/喷淋|喷洗/},
 {id:'dosing',name:'自动加药装置',unit:'套',match:/自动(?:加药|添加)/},
 {id:'barrel',name:'滚筒',unit:'个',match:/滚筒|滚桶/},
 {id:'ventilation',name:'排风配置',unit:'套',match:/排风|抽风|废气/},
 {id:'instrument',name:'仪表配置',unit:'套',match:/温控器|温度传感器|液位计|流量计|PH计|电导率仪/},
 {id:'gantry',name:'行车',unit:'台',match:/行车|龙门车|天车/},
 {id:'frame',name:'机架',unit:'套',match:/机架|骨架|轨道|承载架/},
 {id:'electrical',name:'电气控制系统',unit:'套',match:/电控|电气控制|控制柜|主控柜/}
];
function configurationFamily(label){
 const value=clean(label);
 // A setpoint describes a process condition, not another heating unit.
 if(/(?:温度|槽温|温控|时间)(?:\([^)]*\))?(?:\/°?C|℃)?$/i.test(value)&&!/温控器|传感器/.test(value))return null;
 // A qualified parent wins over a generic exchanger-material leaf.
 if(/加热|加温|热水|热交换|热泵/.test(value)&&!/制冷|冷却|冷水机|冰水机/.test(value))return CONFIGURATION_FAMILIES.find(f=>f.id==='heating');
 return CONFIGURATION_FAMILIES.find(f=>f.match.test(value))||null;
}
function columnScope(path){
 const parts=(Array.isArray(path)?path:[path]).flatMap(value=>String(value??'').split(/\s*\/\s*/)).map(clean).filter(Boolean);
 // Ownership comes from the nearest domain ancestor. Intermediate headings
 // such as geometry/inner size do not erase it, and an equipment ancestor
 // inside a tank heading owns its own dimensions rather than the tank shell.
 for(let index=parts.length-1;index>=0;index--){
  const owner=parts[index];
  if(/管理槽|加药斗|辅槽|中控槽/.test(owner))return {kind:'tank',role:'management',owner,path:parts.slice(0,index+1)};
  if(/外槽|外壳|外封|内衬|保温/.test(owner))return {kind:'structure',owner,path:parts.slice(0,index+1)};
  const family=configurationFamily(owner);if(family)return {kind:'equipment',family:family.id,owner,path:parts.slice(0,index+1)};
  if(/^(?:主槽|槽体|内槽|内净尺寸)/.test(owner))return {kind:'tank',role:'main',owner,path:parts.slice(0,index+1)};
 }
 return null;
}
function configurations(fields,context={}){
 const groups=new Map();
 for(const field of fields){
  if(['operation','station','chambers'].includes(field.field)||!positive(field.value)&&!(field.field==='quantity'&&field.normalized===0)&&!/另配|自备|客户提供|不含|待确认/.test(text(field.value)))continue;
  const family=configurationFamily(field.label);if(!family)continue;
  // Separate explicit instrument names; their quantities are not interchangeable.
  const device=family.id==='instrument'?clean(field.device||field.label):family.id;
  const key=family.id+'|'+device;
  if(!groups.has(key))groups.set(key,{family:family.id,name:family.name,unit:family.unit,fields:[]});
  groups.get(key).fields.push(field);
 }
 return [...groups.values()].map(config=>{
  const quantityFields=config.fields.filter(f=>f.field==='quantity'&&!f.blocked);
  const unique=new Map(quantityFields.map(f=>[f.range,f]));
  const quantityEvidence=[...unique.values()].map(f=>({range:f.range,value:f.raw,normalized:f.normalized}));
  const quantity=unique.size===1?[...unique.values()][0].normalized:null;
  const scopeEvidence=config.fields.filter(f=>/另配|自备|客户提供|不含|待确认/.test(text(f.value))).map(f=>({range:f.range,value:f.raw??f.value}));
  const evidence=config.fields.map(f=>({id:f.id,range:f.range,label:f.label,value:f.raw,normalized:f.normalized,field:f.field}));
  return {...config,id:JSON.stringify([context.filename,context.sheet,context.row,config.family,config.fields[0]?.device]),
   sourceRanges:[...new Set(config.fields.map(f=>f.range))],evidence,quantity,quantityEvidence,scopeEvidence,
   status:scopeEvidence.length?'scope-unconfirmed':quantityEvidence.length>1?'ambiguous-quantity':quantity===null?'quantity-missing':'source-quantity',
   stationNumber:context.stationNumber||'',operation:context.operation||'',sourceRow:context.row};
 });
}
function configurationCandidates(stations,{filename,sheetName,parents=[],covered=new Set()}={}){
 const result=[],seen=new Map();
 for(const station of stations)for(const config of station.configurations||configurations(station.fields,{filename,sheet:sheetName,row:station.row,stationNumber:station.stationNumber,operation:station.operation})){
  const remaining=config.fields.filter(field=>!covered.has(field.range));if(!remaining.length)continue;
  // Already handled equipment owns its whole configuration. A material-only
  // remnant must not create a second unit alongside its correctly read quantity.
  if(config.fields.some(field=>covered.has(field.range)))continue;
  const parent=parents.find(row=>row.bom?.stationMembers?.some(member=>member.sourceRow===station.row)||row.sourceRow===station.row&&row.bom?.role!=='requirement');
  const ranges=config.sourceRanges;
  const identity=JSON.stringify([config.family,...(config.quantityEvidence.length===1?[config.quantityEvidence[0].range]:ranges.slice().sort())]);
  const existing=seen.get(identity);
  const service={row:station.row,operation:station.operation,stationNumber:station.stationNumber};
  if(existing){
   const signature=fields=>JSON.stringify([...new Set(fields.filter(f=>f.field!=='quantity').map(f=>JSON.stringify([f.label,clean(f.value)])))].sort());
   const previousSignature=signature(existing.bom.fieldSources),nextSignature=signature(config.fields);
   if(previousSignature!==nextSignature&&!existing.bom.configurationConflicts){
    existing.kind='requirement';existing.selected=false;existing.bom.role='requirement';existing.bom.supplyStatus='pending';
    existing.bom.configurationConflicts=[{station:existing.bom.serviceStations[0],fields:existing.bom.fieldSources.slice()},{station:service,fields:config.fields}];
    existing.bom.missingConditions=['共用数量范围内设备规格不一致，请确认配置与供货边界'];existing.warning=existing.bom.missingConditions[0];
   }
   if(config.scopeEvidence?.length){existing.kind='requirement';existing.selected=false;existing.bom.role='requirement';existing.bom.supplyStatus='pending';existing.bom.missingConditions=[...new Set([...(existing.bom.missingConditions||[]),'独立、包内或共用的供货范围'])];existing.warning='原表含另配、自备或未确认供货描述，请核对';}
   existing.bom.sourceRanges=[...new Set([...existing.bom.sourceRanges,...ranges])];
   existing.bom.fieldSources.push(...config.fields.filter(f=>!existing.bom.fieldSources.some(old=>old.id===f.id)));
   existing.bom.evidence.push(...config.evidence.filter(f=>!existing.bom.evidence.some(old=>old.id===f.id)));
   existing.bom.serviceStations.push(service);existing.bom.relatedParentIds=[...new Set([...existing.bom.relatedParentIds,parent?.id].filter(Boolean))];existing.bom.shared=existing.bom.relatedParentIds.length>1;continue;
  }
  const confirmed=config.quantity!==null&&config.status==='source-quantity';
  const missingConditions=[...(config.quantity===null?['设备供货数量']:[]),...(!confirmed?['独立、包内或共用的供货范围']:[])];
  const family=CONFIGURATION_FAMILIES.find(f=>f.id===config.family);
  const row={id:uid(),name:config.name,spec:remaining.filter(f=>f.field!=='quantity').map(f=>f.label+'：'+f.value).join('\n'),brand:'',quantity:config.quantity,unit:config.unit,basePrice:null,override:null,
   selected:confirmed,kind:confirmed?'component':'requirement',group:'槽体及配置',source:filename+' / '+sheetName+' / 第'+station.row+'行',sourceRow:station.row,priceSource:'',
   ...(parent?{parentId:parent.id}:{}),warning:missingConditions.length?'待确认：'+missingConditions.join('、'):'',
   bom:{role:confirmed?'accessory':'requirement',supplyStatus:confirmed?'confirmed':'pending',configurationId:config.id,deviceFamily:config.family,
    ruleId:'structured-configuration',engineeringType:'equipment-configuration',sourceRanges:ranges,fieldSources:config.fields,evidence:config.evidence,
    quantityEvidence:config.quantityEvidence,scopeEvidence:config.scopeEvidence||[],quantityBasis:config.quantity===null?'配置已有明确原文；未给出独立设备供货数量':'原表设备独立数量，合并取量锚点只计一次',
    missingConditions,serviceStations:[service],relatedParentIds:parent?[parent.id]:[],parentId:parent?.id||null}};
  if(!parent&&['gantry','frame','electrical'].includes(family?.id))row.group=family.name;
  row.rawSpec=row.spec;seen.set(identity,row);result.push(row);
 }
 return result;
}
// Confirmed process-family supply scopes from the paired business originals.
// Their geometry and equipment selections still come entirely from each input.
const SUPPLY_SCOPES=[{id:'cyanide-copper-assembly',match:/焦铜/,basis:'assembly'},
 {id:'bright-nickel-station',match:/^(?:光镍|光亮镍)/,basis:'station'}];
const INDEPENDENT_EQUIPMENT=[
 {name:/^(?:(?:上|下)线)?移动(?:喷淋|喷洗)?交换车$/,unit:'台',group:'槽体及配置'},
 {name:/^隧道(?:式)?(?:烘干|烘烤)?炉$/,unit:'套',group:'周边配置'}
];
function namedProcessEquipment(station,filename,sheetName){
 const equipmentField=station.fields.find(field=>/^(?:设备|设备名称|部件名称|供货设备)$/.test(clean(field.label))&&positive(field.value));
 const name=text(equipmentField?.value)||station.operation;
 const type=INDEPENDENT_EQUIPMENT.find(equipment=>equipment.name.test(baseName(name)));
 if(!type)return null;
 const quantityField=station.fields.find(field=>field.field==='quantity'&&!field.blocked&&
  (type.name.test(baseName(field.device))||(equipmentField&&clean(field.device)==='设备')));
 const details=station.fields.filter(field=>field!==equipmentField&&positive(field.value)&&
  !['operation','station','chambers','quantity','unit'].includes(field.field));
 const nameField=equipmentField||station.fields.find(field=>field.field==='operation');
 const quantity=quantityField?.normalized??null;
 return {id:uid(),name,spec:details.map(field=>field.label+'：'+field.value).join('\n'),brand:'',quantity,unit:type.unit,
  basePrice:null,override:null,selected:true,kind:'component',group:type.group,
  source:filename+' / '+sheetName+' / 第'+station.row+'行',sourceRow:station.row,priceSource:'',
  bom:{role:'component',ruleId:'named-independent-equipment',explicitDevice:!!equipmentField,
   stationNumber:station.stationNumber,operation:station.operation,sheet:sheetName,
   sourceRanges:[nameField,quantityField,...details].filter(Boolean).map(field=>field.range),
   configurations:(station.configurations||[]).map(config=>({id:config.id,family:config.family,sourceRanges:config.sourceRanges})),
   quantityBasis:quantity===null?'原表明确设备名称，设备供货数量未给出':'原表设备独立数量'}};
}
function scopeKey(row,rows){
 const parent=rows.find(item=>item.id===row.parentId);
 return JSON.stringify([row.name,row.rawSpec||row.spec,parent?.name,parent?.rawSpec||parent?.spec].map(clean));
}
function confirmScope(row,status,review){
 row.kind='component';
 row.spec=row.rawSpec||row.spec;
 row.bom={...row.bom,role:'component',supplyStatus:status,confirmed:true,scopeReview:review};
 row.selected=status==='confirmed';
}
function applyApprovedScopes(quote,rules){
 const approved=new Map(rules.map(rule=>[rule.key,rule]));
 for(const row of quote.rows){
  if(row.kind!=='requirement'||!row.bom)continue;
  const rule=approved.get(scopeKey(row,quote.rows));
  if(!rule)continue;
  const parent=quote.rows.find(item=>item.id===row.parentId);
  if(rule.status==='included'&&(!parent||parent.kind==='requirement'||parent.bom?.supplyStatus==='included'))continue;
  confirmScope(row,rule.status,{ruleId:rule.id,reason:rule.reason});
 }
 return quote;
}
function build({rows,merges,headers,map,filename,sheetName,X,section}){
 const sourceRows=section.stations.map(station=>station.row-1);
 const stationRecords=new Map(section.stations.map(station=>[station.row-1,station]));
 const operationAt=r=>stationRecords.get(r)?.operation||text(rows[r]?.[map.name]);
 const records=new Map(section.stations.map(station=>[station.row-1,new Map(station.fields.map(field=>[field.column,field]))]));
 const used=new Set(),at=(r,c)=>{
  if(c===undefined||c<0)return {value:'',r,c,range:''};
  const field=records.get(r)?.get(c);
  if(!field)return {value:'',r,c,range:''};
  const merge=merges.find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=c&&m.e.c>=c);
  const p=merge?merge.s:{r,c};return {value:field.value,r:p.r,c:p.c,merge,
   range:field.range};
 };
 const cols=headers.map((h,c)=>({h:clean(h),c,type:section.columns?.[c]?.type,blocked:section.columns?.[c]?.blocked,scope:section.columns?.[c]?.scope??columnScope(section.columns?.[c]?.semanticPath||section.columns?.[c]?.path||[h])}));
 const main=cols.filter(x=>x.scope?.kind==='tank'&&x.scope.role==='main');
 const mainCol=(type,word)=>main.find(x=>x.type===type)?.c??main.find(x=>word.test(x.h))?.c;
 const dims={length:mainCol('length',/(?:^|\/)长(?:度)?(?:\(|$)|槽体长/),width:mainCol('width',/(?:^|\/)宽(?:度)?(?:\(|$)|槽体宽/),height:mainCol('height',/(?:^|\/)高(?:度)?(?:\(|$)|槽体高/),
  material:mainCol('material',/材料|材质/),thickness:mainCol('thickness',/厚度|板厚|壁厚/),triple:mainCol('dimensions',/内净尺寸/)};
 if(dims.triple===undefined&&![dims.length,dims.width,dims.height].every(c=>c!==undefined))return null;
 const independent=new Map();
 for(const station of section.stations){
  const item=namedProcessEquipment(station,filename,sheetName);
  if(item)independent.set(station.row-1,item);
 }
 const chamberCol=main.find(x=>x.type==='chambers')?.c;
 const supplyQuantityCol=main.find(x=>x.type==='quantity'&&!x.blocked)?.c;
 function unitScale(c){const label=clean(headers[c]);if(/(?:英寸|英尺|inch|feet|\bft\b)/i.test(label))return null;if(/mm|毫米/i.test(label))return 1;if(/cm|厘米/i.test(label))return 10;if(/(?:^|[^a-z])(?:m|米)(?:$|[^a-z])/i.test(label))return 1000;return 1;}
 function geometry(r,columns=dims){
  const g={},sourceValues=[],origins={};
  const issue=message=>{if(!(g.dimensionIssue||'').includes(message))g.dimensionIssue=[g.dimensionIssue,message].filter(Boolean).join('；');};
  const source=(field,c,parsed)=>{const cell=at(r,c);if(!text(cell.value))return null;const entry={field,label:headers[c],value:cell.value,range:cell.range,...(parsed!==undefined?{parsed}: {})};sourceValues.push(entry);return entry;};
  const put=(key,value,entry)=>{if(value===undefined||value===null||value==='')return;if(g[key]!==undefined&&g[key]!==value){const first=origins[key];issue((F.LABELS[key]||key)+'原表不一致：'+(first?.range||'')+'='+g[key]+' / '+(entry?.range||'')+'='+value);return;}g[key]=value;origins[key]??=entry;};
  for(const k of ['length','width','height','thickness']){const c=columns[k],cell=at(r,c),n=num(cell.value),scale=unitScale(c),entry=source(k,c,n!==null&&scale!==null?n*scale:undefined);if(n!==null&&scale!==null)put(k,n*scale,entry);else if(n!==null)issue('原表尺寸单位需确认：'+headers[c]+'='+cell.value);}
  if(columns.triple!==undefined){const raw=text(at(r,columns.triple).value),parsed=F.parameters(raw,{scope:'tank'}),p={...parsed.params},entry=source('dimensions',columns.triple,p);
   const triple=raw.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米|米)?\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米|米)?\s*[x×*]\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|毫米|厘米|米)?/i)?.[0]||'';
   const explicitDimensionUnit=/(?:mm|cm|毫米|厘米|\d\s*m\b|米)/i.test(triple)||/(?:长|宽|高)(?:度)?\s*\(?\s*(?:mm|cm|m|毫米|厘米|米)\b/i.test(raw);
   const scale=explicitDimensionUnit?1:unitScale(columns.triple);if(scale!==null){for(const k of ['length','width','height'])if(p[k]!==undefined)p[k]*=scale;for(const [key,value]of Object.entries(p))put(key,value,entry);}else issue('原表尺寸单位需确认：'+headers[columns.triple]+'='+raw);
   for(const message of parsed.issues||[])issue((entry?.range||'')+' '+message);
   if(parsed.hasScopedLayers){g.sourceNotes=[g.sourceNotes,'原表尺寸与结构（'+entry?.range+'）：'+raw].filter(Boolean).join('\n');g.structureIssue='原表包含分层结构，需对应结构的计价依据';}
  }
  const material=text(at(r,columns.material).value);if(material){
   const parsed=F.parameters(material,{scope:'tank'}),p=parsed.params,layered=parsed.hasScopedLayers||/外包|外封|外壳|内衬|外槽|夹套|保温|岩棉|双层/.test(material),entry=source('material',columns.material,p);
   const body=parsed.primaryText||material,named=clean(body).match(/SUS(?:304|316)L?(?:镜面)?|PVDF|PTFE|PPS|PP|Ti|钛/i);
   // A layer without an explicitly resolved body must not become the tank shell
   // merely because its material or thickness appeared first in the cell.
   const hasBody=!layered||parsed.hasScopedLayers&&Boolean(parsed.primaryText);
   if(hasBody){const grade=named?.[0],value=p.material==='IMPORT_PP'?'进口PP':grade||p.material||body;put('material',value,entry);}
   let thickness=p.thickness;
   if(thickness===undefined&&!layered){
    const legacy=material.match(/(?:PP|PPS|SUS\s*\d{3}L?)\s*(\d+(?:\.\d+)?)$/i);if(legacy)thickness=Number(legacy[1]);
    // In a material-only column, one material plus one explicit mm scalar is
    // a sheet-thickness specification. Grade digits and compound geometry
    // cannot satisfy this grammar; layered structures keep their own parser.
    const scalar=named?body.replace(named[0],'').trim().match(/^(?:(?:板厚|厚度|壁厚|厚)\s*[:：δ=]?\s*)?(\d+(?:\.\d+)?)\s*(?:mm|毫米)$/i):null;
    if(thickness===undefined&&scalar){thickness=Number(scalar[1]);entry.parsed={...p,thickness};}
   }
   if(hasBody)put('thickness',thickness,entry);
   for(const message of parsed.issues||[])issue((entry?.range||'')+' '+message);
   if(layered||parsed.issues?.length)g.sourceNotes=[g.sourceNotes,'原表材质与结构（'+entry.range+'）：'+material].filter(Boolean).join('\n');
   if(layered)g.structureIssue='原表包含分层结构，需对应结构的计价依据';
  }
  g.sourceValues=sourceValues;
  return g;
 }
 function geometryIdentity(g){const {sourceValues,sourceNotes,...values}=g;return {...values,...(sourceNotes?{structureSources:(sourceValues||[]).filter(v=>['material','dimensions'].includes(v.field)).map(v=>[v.field,v.value])}:{})};}
 function geometrySpec(g){return [['length','长'],['width','宽'],['height','高'],['thickness','厚度']].filter(([k])=>g[k]!==undefined).map(([k,l])=>l+g[k]+'mm').concat(g.material?['材质'+g.material]:[]).join(' ');}
 function make(name,spec,quantity,unit,role,r,ranges,extra={}){
  return {id:uid(),name,spec,brand:'',quantity,unit,basePrice:null,override:null,selected:role!=='requirement',kind:role==='requirement'?'requirement':'component',
   group:role==='shared'?'周边配置':'槽体及配置',source:filename+' / '+sheetName+' / 第'+(r+1)+'行',sourceRow:r+1,priceSource:'',
   bom:{role,sourceRanges:[...new Set(ranges.filter(Boolean))],quantityBasis:quantity===null?'原表未给出供货数量':'原表独立数量',...extra}};
 }
 const assemblies=[];
 const functionalColumns=cols.filter(x=>/主槽.*(?:容积|溢流|底阀|空气搅拌)|(?:^|\/)搅拌\/空气$/.test(x.h));
 const usedRows=new Set();
 for(const r of sourceRows){
  if(usedRows.has(r))continue;
  if(independent.has(r)){assemblies.push({equipment:independent.get(r),members:[r]});continue;}
  const name=operationAt(r),g=geometry(r),cc=at(r,chamberCol),n=num(cc.value);
  if(/(?:主线|支线|生产线|工艺流程)$/.test(clean(name))&&!rows[r].some((v,c)=>c!==map.name&&c!==(map.seq??0)&&positive(v)))continue;
  const span=cc.merge?sourceRows.filter(t=>t>=cc.merge.s.r&&t<=cc.merge.e.r&&!independent.has(t)):[r];
  const chamberCount=n===null?null:n,explicit=chamberCol!==undefined&&n!==null&&n>0;
  // A merge owns one linked assembly, not its value repeated once per row.
  let members=explicit&&cc.merge?span:[r];
  const washRole=t=>/喷淋|喷洗/.test(operationAt(t))?'spray':/^水洗(?:第?\d+[号#]?)?$/.test(clean(operationAt(t)))?'rinse':'';
  const mixedWash=explicit&&cc.merge&&span.length===n&&span.every(washRole)&&new Set(span.map(washRole)).size>1;
  if(mixedWash){
   const matching=JSON.stringify(geometryIdentity(g)),group=washRole(r),index=span.indexOf(r);
   members=[r];
   for(const t of span.slice(index+1)){
    if(t!==members.at(-1)+1||washRole(t)!==group||JSON.stringify(geometryIdentity(geometry(t)))!==matching)break;
    members.push(t);
   }
  }
  members.forEach(t=>usedRows.add(t));
  const names=[...new Set(members.map(t=>baseName(operationAt(t))))],label=names.join('＋');
  const structuralMap=new Map();for(const t of members)for(const x of cols.filter(x=>/保温|外槽|内衬|隔板|槽盖/.test(x.h))){const cell=at(t,x.c);if(!positive(cell.value))continue;const key=x.h+'|'+text(cell.value);if(!structuralMap.has(key))structuralMap.set(key,{label:x.h,value:text(cell.value)});}
  const structural=[...structuralMap.values()];
  const functional=new Map(),functionalRanges=[];for(const t of members)for(const x of functionalColumns){const cell=at(t,x.c);if(positive(cell.value)){functional.set(x.h+'：'+text(cell.value),cell.range);functionalRanges.push(cell.range);}}
  const memberGeometry=members.map(t=>({row:t+1,...geometry(t)}));
  const heterogeneous=new Set(memberGeometry.map(({row,...g})=>JSON.stringify(geometryIdentity(g)))).size>1;
  const inconsistent=Boolean(cc.merge&&n!==null&&span.length!==n);
  const suppliedChambers=mixedWash?members.length:chamberCount;
  const structuralNotes=[...structural.map(f=>f.label+'：'+f.value),...new Set(memberGeometry.map(g=>g.sourceNotes).filter(Boolean)),...memberGeometry.filter(g=>g.dimensionIssue).map(g=>g.dimensionIssue),...(heterogeneous?['联槽各工位尺寸/材质不同，分别保留：',...memberGeometry.map(({row,...g})=>'第'+row+'行：'+geometrySpec(g))]:[]),...(inconsistent?['原表主槽工位数'+n+'与合并范围'+members.length+'行不一致，需确认数量']:[])].join('\n');
  const notes=[structuralNotes,functional.size?'原表功能要求：'+[...functional.keys()].join('；'):''].filter(Boolean).join('\n');
  const complete=['length','width','height'].every(k=>g[k]>0);
  const canonical=geometrySpec(g),linked=suppliedChambers>1?suppliedChambers+'联槽（保留原表单工位尺寸，整体轴向待确认）':'';
  const processConditions=members.map(t=>(stationRecords.get(t)?.fields||[]).filter(f=>/(?:工艺)?温度(?:\(|℃|$)|槽温/.test(clean(f.label))&&!/加热|仪表|传感器|温控器/.test(clean(f.label))&&/\d|室温|常温/.test(clean(f.value))).map(f=>clean(f.value).replace(/常温/g,'室温').replace(/[～~至]/g,'-')));
  const signature=JSON.stringify([label,geometryIdentity(g),suppliedChambers,structural,memberGeometry.map(({row,...v})=>geometryIdentity(v)),processConditions]);
  const prev=assemblies[assemblies.length-1];
  if(complete&&prev&&prev.signature===signature&&r===prev.members[prev.members.length-1]+1&&explicit){prev.members.push(...members);prev.memberGeometry.push(...memberGeometry);prev.quantity++;prev.sourceRanges.push(cc.range,...members.flatMap(t=>main.map(x=>at(t,x.c).range)),...functionalRanges);for(const [key,value]of functional)prev.functional.set(key,value);prev.notes=[prev.structuralNotes,prev.functional.size?'原表功能要求：'+[...prev.functional.keys()].join('；'):''].filter(Boolean).join('\n');continue;}
  const supplyQuantity=supplyQuantityCol===undefined?null:records.get(r)?.get(supplyQuantityCol)?.normalized??null;
  assemblies.push({r,name,label,g,members,sourceGroup:cc.range,mixedWash,quantity:explicit&&!inconsistent?1:supplyQuantity,chamberCount:supplyQuantity!==null&&!explicit?1:suppliedChambers,supplyQuantity,signature,notes,structuralNotes,functional,complete,linked,heterogeneous,memberGeometry,sourceRanges:[...members.map(t=>at(t,map.name).range),...members.flatMap(t=>main.map(x=>at(t,x.c).range)),...functionalRanges],canonical});
 }
 const out=[],globals=[],globalMap=new Map();
 const hasStructuredQuantities=chamberCol!==undefined;
 function equipmentColumns(pattern){return cols.filter(x=>pattern.test(x.h));}
 function specs(r,cs){return cs.filter(x=>positive(at(r,x.c).value)||/另配|自备|客户提供|不含|待确认/.test(text(at(r,x.c).value))).map(x=>({...stationRecords.get(r)?.fields.find(field=>field.column===x.c),label:x.h,value:text(at(r,x.c).value),range:at(r,x.c).range}));}
 function pushGlobal(row,key){const related=row.parentId||row.bom?.parentId;if(related)row.bom.relatedParentIds=[related];if(!globalMap.has(key)){globalMap.set(key,row);globals.push(row);return;}const old=globalMap.get(key);old.quantity=old.quantity!==null&&row.quantity!==null?old.quantity+row.quantity:null;old.bom.sourceRanges=[...new Set([...old.bom.sourceRanges,...row.bom.sourceRanges])];old.bom.relatedParentIds=[...new Set([...(old.bom.relatedParentIds||[]),...(row.bom.relatedParentIds||[])])];old.bom.fieldSources=[...(old.bom.fieldSources||[]),...(row.bom.fieldSources||[])];if(row.fieldIssues?.length)old.fieldIssues=[...(old.fieldIssues||[]),...row.fieldIssues];}
 function addEquipment(parent,a,name,cs,{unit='台',global=false,role='accessory',quantityColumn,scope,knownPerStation=false}={}){
  if(!cs.length)return;
  const records=[],seen=new Set();
  for(const r of a.members){
   const active=specs(r,cs);if(!active.length)continue;
   const qc=quantityColumn??cs.find(x=>x.type==='quantity'&&!x.blocked)?.c;
   const anchor=at(r,qc!==undefined?qc:cs[0].c),key=anchor.range;
   if(seen.has(key)||used.has(name+'|'+key))continue;seen.add(key);used.add(name+'|'+key);
   const quantityField=stationRecords.get(r)?.fields.find(field=>field.column===qc);
   const qty=qc!==undefined?quantityField?.blocked?null:quantityField?.normalized??null:knownPerStation&&hasStructuredQuantities?1:null;
   // Unit-bearing source specifications distinguish independent purchase items.
   const details=active.filter(f=>f.field!=='quantity');
   const issues=details.filter(f=>/功率|(?:^|\/)(?:kW|kVA|电压|电流|频率)(?:\/|$)/i.test(f.label)&&!/[0-9]/.test(f.value)).map(f=>({...f,kind:'invalid_numeric',issue:f.label+'应为数值，原值为“'+f.value+'”'}));
   const desc=details.map(f=>f.label.split('/').slice(-1)[0]+'：'+f.value).join('\n'),customer=details.filter(f=>!issues.some(issue=>issue.range===f.range)).map(f=>f.label.split('/').slice(-1)[0]+'：'+f.value).join('\n');
   const sourceUnit=quantityField?.unit||unit;
   const rec=records.find(x=>x.spec===desc&&x.unit===sourceUnit);if(rec){rec.quantity=rec.quantity!==null&&qty!==null?rec.quantity+qty:null;rec.ranges.push(...active.map(f=>f.range));rec.fields.push(...active);rec.issues.push(...issues);}else records.push({spec:desc,customerSpec:customer,quantity:qty,unit:sourceUnit,ranges:active.map(f=>f.range),fields:active,issues,r});
  }
  for(const rec of records){const deferred=/另配|自备|客户提供|不含|待确认/.test(rec.spec),actualRole=deferred?'requirement':role;const row=make(name,rec.customerSpec,rec.quantity,rec.unit,actualRole,rec.r,rec.ranges,{parentId:parent.id,quantityBasis:deferred?'原表供货边界需核对':scope||(quantityColumn!==undefined||cs.some(x=>x.type==='quantity'&&!x.blocked)?'原表设备数量；合并单元格只计一次':'原表独立配置范围'),stationCount:a.members.length,fieldSources:rec.fields});row.rawSpec=rec.spec;if(deferred){row.bom.missingConditions=['设备供货范围','设备供货数量'];row.warning='原表含另配、自备或未确认供货描述，请核对';}if(rec.issues.length){row.fieldIssues=rec.issues;row.formulaBlocked=true;row.warning=[...new Set(rec.issues.map(issue=>issue.issue))].join('；');}row.parentId=parent.id;row.subgroup=parent.subgroup;row.scope='仅'+name+'；不含槽体';if(global)pushGlobal(row,name+'|'+rec.spec+'|'+rec.unit);else out.push(row);}
 }
  const filterCols=cols.filter(x=>configurationFamily(x.h)?.id==='filter'),rectCols=cols.filter(x=>configurationFamily(x.h)?.id==='rectifier');
 const directEquipment=[
  ['过滤机',filterCols],
  ['整流机',rectCols,{global:true,role:'shared'}],
  ['超声波系统',equipmentColumns(/(?:^|\/)超声波(?:\/|$)/),{unit:'组',knownPerStation:true}],
  ['自动加药装置',equipmentColumns(/(?:^|\/)自动(?:加药|添加)(?:\/|$)/),{unit:'套',global:true,role:'shared'}]
 ];
 function addDirectEquipment(parent,assembly,consumed){
  for(const [name,columns,options] of directEquipment){
   addEquipment(parent,assembly,name,columns,options);
   if(consumed)for(const column of columns)consumed.add(column.c);
  }
 }
 const heatingCols=cols.filter(x=>/热水加$|电加热(?:器)?$|蒸汽(?:加热)?$/.test(x.h));
 const heatingMaterial=cols.find(x=>/加热设备\/材质$/.test(x.h))?.c;
 const manager=cols.filter(x=>/管理槽|加药斗/.test(x.h));
 const managerDims={length:manager.find(x=>/\/长(?:度)?(?:\(|$)/.test(x.h))?.c,width:manager.find(x=>/\/宽(?:度)?(?:\(|$)/.test(x.h))?.c,height:manager.find(x=>/\/高(?:度)?(?:\(|$)/.test(x.h))?.c,material:manager.find(x=>/材质|材料/.test(x.h))?.c};
 for(const a of assemblies){
  if(a.equipment){
   out.push(a.equipment);
   addDirectEquipment(a.equipment,a);
   continue;
  }
  const prefix=a.chamberCount>1?(linkedWords[a.chamberCount]||a.chamberCount)+'连':'';
  const name=prefix+a.label+(a.complete&&!/槽|炉|车|位|烘干/.test(a.label)?'槽':'');
  const role=a.complete?'tank':'requirement',spec=[a.canonical,a.linked,a.notes].filter(Boolean).join('\n');
  const parent=make(name,spec||'原表未给出槽体尺寸或设备供货数量',a.quantity,'个',role,a.r,a.sourceRanges,{chamberCount:a.chamberCount,assemblyCount:a.quantity,stationCount:a.members.length,quantityBasis:a.quantity===null?'无独立槽体数量列；需确认供货数量':a.supplyQuantity!==null?'原表主槽独立供货数量'+a.supplyQuantity+'；未推断联槽结构':a.chamberCount>1?'按主槽工位合并范围组成联槽，再合并相邻同规格组合':'原表主槽工位=1，每个独立槽体1个'});
  parent.bom.sourceStationGroup=a.sourceGroup;
  if(a.mixedWash){parent.bom.ruleId='mixed-spray-rinse';parent.bom.quantityBasis='原工位组内喷淋与普通水洗分供；连续同规格普通水洗按一个槽组合计';}
  parent.bom.geometrySources=a.memberGeometry.map(g=>({row:g.row,values:g.sourceValues}));
   parent.bom.stationMembers=a.members.map(r=>({name:operationAt(r),stationNumber:stationRecords.get(r)?.stationNumber||'',sourceRow:r+1,geometry:geometry(r),sourceRanges:[...new Set([at(r,map.name).range,at(r,chamberCol).range,...main.map(x=>at(r,x.c).range)].filter(Boolean))]}));
  parent.bom.contextEvidence=a.members.flatMap(r=>stationRecords.get(r)?.fields.filter(f=>f.field==='section').map(f=>({range:f.range,label:f.label,value:f.value}))||[]);
  const geometryIssues=[...new Set(a.memberGeometry.flatMap(g=>[g.dimensionIssue,g.structureIssue]).filter(Boolean))];
  if(geometryIssues.length){parent.formulaBlocked=true;parent.geometryIssue=geometryIssues.join('；');parent.warning=parent.geometryIssue;}
  if(a.complete&&!a.heterogeneous)parent.geometry={...a.g,chambers:a.chamberCount,specSuffix:a.notes};
  if(a.heterogeneous){parent.bom.memberGeometry=a.memberGeometry;parent.warning='联槽内工位规格不同，已逐项保留，请核对整体结构';}
  parent.group='槽体及配置';parent.subgroup=a.label+'（第'+(a.r+1)+'行起）';parent.scope='仅槽体；过滤、加温及循环等配套另列';out.push(parent);
  // All source content is recoverable, including fields not yet mapped into BOM.
  const consumed=new Set([map.name,map.seq,chamberCol,supplyQuantityCol,...section.columns.filter(c=>c.type==='section').map(c=>c.column),...Object.values(dims).filter(c=>c!==undefined)]);structuralConsume();
  functionalColumns.forEach(x=>consumed.add(x.c));
  function structuralConsume(){cols.filter(x=>/保温|外槽|内衬|隔板|槽盖/.test(x.h)).forEach(x=>consumed.add(x.c));}
  addDirectEquipment(parent,a,consumed);
  const profile=SUPPLY_SCOPES.find(x=>x.match.test(a.label));
  const heated=a.members.filter(r=>heatingCols.some(x=>positive(at(r,x.c).value)));
  if(heated.length){
   const signatures=new Map();for(const r of heated){const active=heatingCols.filter(x=>positive(at(r,x.c).value)),mat=text(at(r,heatingMaterial).value),desc=active.map(x=>x.h.split('/').slice(-1)[0]+'：'+text(at(r,x.c).value)).join('；')+(mat?'；材质：'+mat:'');if(!signatures.has(desc))signatures.set(desc,{rows:[],ranges:[]});const rec=signatures.get(desc);rec.rows.push(r);rec.ranges.push(...active.map(x=>at(r,x.c).range),at(r,heatingMaterial).range);}
   for(const [desc,rec]of signatures){const qty=!hasStructuredQuantities?null:profile?.basis==='assembly'&&rec.rows.length===a.members.length?a.quantity:rec.rows.length;
    const item=make('加温管',desc,qty,'组','accessory',rec.rows[0],rec.ranges,{parentId:parent.id,quantityBasis:profile?a.label+'配套：'+(profile.basis==='assembly'?'每联槽组合1组':'每工位1组'):'按原表加热配置工位；热源机组选型另确认',ruleId:profile?.id||'source-heating-stations'});item.parentId=parent.id;item.subgroup=parent.subgroup;out.push(item);}
  }
  heatingCols.forEach(x=>consumed.add(x.c));if(heatingMaterial!==undefined)consumed.add(heatingMaterial);
  if(profile&&a.members.some(r=>filterCols.some(x=>positive(at(r,x.c).value)))){const qty=hasStructuredQuantities?(profile.basis==='station'?a.members.length:a.quantity):null;
   const pipe=make('循环管路','按'+a.label+'循环配套；管径和材质待确认',qty,'套','accessory',a.r,filterCols.map(x=>at(a.r,x.c).range),{parentId:parent.id,quantityBasis:a.label+'配套：'+(profile.basis==='station'?'每工位1套':'每联槽组合1套'),ruleId:profile.id});pipe.parentId=parent.id;pipe.subgroup=parent.subgroup;out.push(pipe);}
  // Management tanks have their own independent shared merge extent.
  if(managerDims.length!==undefined){for(const r of a.members){const anchor=at(r,managerDims.length);if(!positive(anchor.value)||used.has('manager'+anchor.range))continue;used.add('manager'+anchor.range);const g=geometry(r,managerDims);if(['length','width','height'].every(k=>g[k]>0)){const note=[g.sourceNotes,g.dimensionIssue].filter(Boolean).join('\n'),row=make(a.label+'管理槽',[geometrySpec(g),note].filter(Boolean).join('\n'),1,'个','tank',r,manager.map(x=>at(r,x.c).range),{shared:true,quantityBasis:'独立管理槽尺寸合并范围1个；不随主槽重复',stationCount:anchor.merge?anchor.merge.e.r-anchor.merge.s.r+1:1,geometrySources:[{row:r+1,values:g.sourceValues}]});row.geometry={...g,chambers:1,specSuffix:note};if(g.dimensionIssue||g.structureIssue){row.formulaBlocked=true;row.geometryIssue=[g.dimensionIssue,g.structureIssue].filter(Boolean).join('；');row.warning=row.geometryIssue;}row.group='周边配置';globals.push(row);}else{const row=make('管理槽配置',specs(r,manager).map(f=>f.label+'：'+f.value).join('\n'),null,'个','requirement',r,manager.map(x=>at(r,x.c).range));globals.push(row);}}}manager.forEach(x=>consumed.add(x.c));
  // Unknown engineering requirements are separately visible and never billed as
  // an extra full assembly. Group only identical requirements within this scope.
   const unresolved=new Map();
  for(const r of a.members)for(const x of cols){if(consumed.has(x.c)||!positive(at(r,x.c).value))continue;const cell=at(r,x.c);const label=x.h,value=text(cell.value),key=label+'|'+value;if(!unresolved.has(key))unresolved.set(key,{label,value,ranges:[],r});unresolved.get(key).ranges.push(cell.range);}
  if(unresolved.size){const categories=new Map();for(const f of unresolved.values()){const label=/废气|排风|排气/.test(f.label)?'抽风要求':/温度|温控|槽温/.test(f.label)?'温控要求':/制冷|冷却/.test(f.label)?'冷却配置':/搅拌|鼓气|湍流/.test(f.label)?'搅拌配置':/进水|排水|底阀|溢流|补水|喷淋|喷洗|用水/.test(f.label)?'水路配置':/时间|工艺温/.test(f.label)?'工艺条件':'其他配套';if(!categories.has(label))categories.set(label,[]);categories.get(label).push(f);}
   for(const [label,fields]of categories){const requirement=make(a.label+' · '+label,fields.map(f=>f.label+'：'+f.value).join('\n'),null,'','requirement',a.r,fields.flatMap(f=>f.ranges),{parentId:parent.id,quantityBasis:'需求说明；未另计价',requirementFields:fields.map(f=>({label:f.label,value:f.value,ranges:f.ranges}))});requirement.parentId=parent.id;requirement.subgroup=parent.subgroup;requirement.scope='仅保留尚无完整选型/数量的工艺要求';out.push(requirement);}}
 }
  // Every still-unhandled structured device becomes one traceable configuration,
  // rather than disappearing inside a temperature/other-requirements sentence.
  const covered=new Set([...out,...globals].filter(row=>row.bom.fieldSources?.length||!['tank','requirement'].includes(row.bom.role)).flatMap(row=>row.bom.sourceRanges||[]));
  const candidates=configurationCandidates(section.stations,{filename,sheetName,parents:out,covered});
  const captured=new Set(candidates.flatMap(row=>row.bom.sourceRanges));
  for(const row of out.filter(row=>row.bom.role==='requirement'&&!row.bom.stationMembers)){
   const fields=(row.bom.sourceRanges||[]).filter(range=>!captured.has(range));
   if(fields.length!==row.bom.sourceRanges.length){
    const original=row.rawSpec||row.spec;
    const kept=original.split('\n').filter(line=>!section.stations.flatMap(s=>s.fields).some(f=>captured.has(f.range)&&line.includes(f.label.replace(/\s/g,''))));
    row.bom.sourceRanges=fields;row.spec=kept.join('\n');row.rawSpec=row.spec;
   }
  }
  const all=[...out.filter(row=>row.bom.role!=='requirement'||row.bom.stationMembers||row.bom.sourceRanges.length),...globals,...candidates];
  for(const row of all){
   row.bom.schemaVersion=2;
   row.bom.deviceFamily??=row.bom.role==='tank'?'tank':configurationFamily(row.name)?.id||null;
   const fields=row.bom.fieldSources||row.bom.geometrySources?.flatMap(record=>record.values)||[];
   row.bom.evidence??=fields.map(field=>({id:field.id||JSON.stringify([filename,field.range,field.field]),range:field.range,label:field.label,value:field.raw??field.value,normalized:field.normalized??field.parsed,field:field.field}));
   row.bom.quantityEvidence??=fields.filter(field=>field.field==='quantity'&&!field.blocked).map(field=>({range:field.range,value:field.raw??field.value,normalized:field.normalized}));
  }
 for(const row of all.filter(row=>['accessory','shared'].includes(row.bom.role))){
  const locations=new Set(row.bom.sourceRanges),parentIds=new Set(row.bom.relatedParentIds||[row.parentId]);
  row.bom.serviceStations=section.stations.filter(station=>station.fields.some(field=>locations.has(field.range))).map(({row,operation,stationNumber})=>({row,operation,stationNumber}));
  for(const parent of out)if(parent.bom.stationMembers?.some(member=>row.bom.serviceStations.some(station=>station.row===member.sourceRow)))parentIds.add(parent.id);
  if(parentIds.size>1){row.bom.relatedParentIds=[...parentIds].filter(Boolean);row.bom.shared=true;}
 }
 return Business.attach({rows:all,warnings:['已按主槽合并范围拆分组合槽；配套按独立共享范围计量，待确认配套不计入报价。','原表尺寸、板厚、设备容量原样保留；未推断行车、机架或热源机组选型。']});
}
 root.QuoteBOM={build,namedProcessEquipment,SUPPLY_SCOPES,scopeKey,confirmScope,applyApprovedScopes,CONFIGURATION_FAMILIES,configurationFamily,columnScope,configurations,configurationCandidates};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteBOM;
})(typeof window!=='undefined'?window:globalThis);
