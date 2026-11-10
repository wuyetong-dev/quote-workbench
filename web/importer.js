(function(root){
'use strict';
const M=typeof module!=='undefined'?require('./model.js'):root.QuoteModel;
const {clean,text,number,uid}=M;
// Shared semantic vocabulary drives flat lists and nested process tables. It
// classifies labels, never row values, file names or fixed column positions.
const FIELD_LABELS={
 operation:['工艺名称','工艺','流程','流程名称','工序','工序名称','作业名称','作业','工步名称','工步','处理工序'],
 station:['工位号','工位编号','工位序号','槽号','槽位号','槽位编号','工序号','工序编号','站号','站位编号'],
 quantity:['数量','用量','总量','工程量','采购数量','订购数量','需求数量','交付数量','设备数量','供货数量','台数','套数','槽数'],
 name:['名称','品名','物料名称','配件名称','部件名称','产品名称','设备名称','项目名称','供货设备','设备'],
 equipment_reference:['使用设备','共用设备引用','引用设备','所用设备','设备引用'],
 unit:['单位','计量单位','供货单位'],notes:['备注','说明','供货说明','配置说明','成套说明'],section:['工段','工段名称','区段','分段']
};
const labelStem=value=>clean(value).replace(/\([^)]*\)$/,'');
const hasLabel=(kind,value)=>FIELD_LABELS[kind]?.includes(labelStem(value))||kind==='station'&&/^(?:工位|槽位|工序|站位|站|槽)(?:号|编号|序号|编码|标识|ID)$/i.test(labelStem(value));
const isSemanticHeader=value=>Object.keys(FIELD_LABELS).some(kind=>hasLabel(kind,value))||/^(?:长(?:度)?|宽(?:度)?|高(?:度)?|板厚|壁厚|厚度|材料|材质|规格|型号|型式|功率|频率|电流|电压|工位数|联数|内净尺寸|槽体尺寸)$/.test(labelStem(value));
const processName={test:value=>hasLabel('operation',value)};
const patterns={name:/^(?:(?:设备|产品)?名称(?:及|和)(?:配置说明|配置|规格说明|规格|说明)|名称|品名|物料名称|配件名称|部件名称|产品名称|设备名称|项目名称|供货设备|设备)$/,spec:/规格|技术参数|型号/,price:/单价|^销售价$|^售价$/,brand:/品牌|厂商/,amount:/^(?:金额|总价|总额)(?:\([^)]*\))?$/};
function header(row){const map={};for(let c=0;c<row.length;c++){const s=clean(row[c]);if(hasLabel('station',s)||s==='序号')map.seq=c;
 for(const kind of ['name','quantity','unit','operation'])if(hasLabel(kind,s)&&map[kind==='operation'?'name':kind]===undefined)map[kind==='operation'?'name':kind]=c;
 for(const [key,re]of Object.entries(patterns))if(re.test(s)&&map[key]===undefined&&!(key==='spec'&&patterns.name.test(s)))map[key]=c;
 }return map.name!==undefined?map:null;}

const standardVersion=2;
const address=(r,c)=>{let column='';for(let n=c+1;n>0;n=Math.floor((n-1)/26))column=String.fromCharCode(65+(n-1)%26)+column;return column+(r+1);};
function fieldType(path){
 const label=clean(path.at(-1));
 if(hasLabel('quantity',label))return 'quantity';
 if(hasLabel('equipment_reference',label))return 'equipment_reference';
 if(hasLabel('notes',label))return 'notes';
 if(hasLabel('section',label))return 'section';
 if(/^(?:工位(?:数)?|联数)$/.test(label))return 'chambers';
 if(/内净尺寸|槽体尺寸/.test(label))return 'dimensions';
 if(hasLabel('unit',label))return 'unit';
 for(const [name,pattern] of Object.entries({length:/^(?:槽体)?长/,width:/^(?:槽体)?宽/,height:/^(?:槽体)?高/,thickness:/板厚|厚度|壁厚/,material:/材质|材料/,configuration:/过滤|整流|超声|加热|冷却|制冷|喷淋|温控|排风|搅拌|补水|容量|功率|电流|电压|时间|温度|规格|频率|用水|溢流|底阀|压力|流量/}))if(pattern.test(label))return name;
 return 'unmapped';
}
function standardProcess(source,profiles={}){
 const {rows=[],merges=[],sheet}=source;
 const B=typeof module!=='undefined'&&module.exports?require('./process-bom.js'):root.QuoteBOM;
 const valueAt=(r,c)=>{const merge=merges.find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=c&&m.e.c>=c);return (merge?rows[merge.s.r]?.[merge.s.c]:rows[r]?.[c])??'';};
 const headers=rows.flatMap((row,index)=>{
  const signature=JSON.stringify(row.map(clean));
  const profile=(profiles[signature]||[]).find(candidate=>JSON.stringify(rows.slice(index,index+candidate.headerRows.length).map(row=>row.map(clean)))===JSON.stringify(candidate.headerRows));
  const map=header(row),name=profile?.name??row.findIndex(v=>processName.test(clean(v)));
  if(name<0)return [];
  const seq=profile&&Object.hasOwn(profile,'seq')?profile.seq:map?.seq;
  return [{index,name,seq,signature,profile}];
 });
 if(!headers.length)return null;
 const sections=headers.map(({index,name,seq,signature,profile},sectionIndex)=>{
  const end=headers[sectionIndex+1]?.index??rows.length;
  // Merges beginning in the header are structural evidence for its depth.
  // In particular an inherited operation label in a vertical header merge is
  // not a process record, even when the station identifier column is unknown.
  const headerFloor=Math.max(index+1,...merges.filter(merge=>merge.s.r===index).map(merge=>merge.e.r+1));
  const isHeaderContinuation=(row,r)=>{
   if(r<headerFloor)return true;
   if(processName.test(valueAt(r,name)))return true;
   if(seq!=null&&hasLabel('station',valueAt(r,seq)))return true;
   const values=row.map(text).filter(Boolean);
   return values.length>1&&values.every(isSemanticHeader);
  };
  const isStation=(row,r)=>{
   if(isHeaderContinuation(row,r))return false;
   const value=text(valueAt(r,name));
   if(!value||/^(?:备注|说明|注)\s*[:：]|^(?:合计|小计|总计)(?:$|\s)/.test(value))return false;
   // An explicitly labelled identifier owns its original value. Identifiers
   // may contain letters, separators or local naming conventions.
   return seq==null||!text(valueAt(r,seq))||!isSemanticHeader(valueAt(r,seq));
  };
  let start=profile?index+profile.headerRows.length:rows.findIndex((row,r)=>r>index&&r<end&&isStation(row,r)&&(seq==null||text(row[seq])));
  if(start<0)start=rows.findIndex((row,r)=>r>index&&r<end&&isStation(row,r));
  if(start<0)start=end;
  const width=rows.slice(index,end).reduce((max,row)=>Math.max(max,row.length),0);
  const columns=Array.from({length:width},(_,c)=>{
   const path=[],leafPath=[];
   for(let r=index;r<start;r++){
    const merge=merges.find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=c&&m.e.c>=c);
    const value=(text(rows[r]?.[c])||text(merge?rows[merge.s.r]?.[merge.s.c]:'')).replace(/\s+/g,'');
    if(!value)continue;
    if(!path.includes(value))path.push(value);
    const nested=merge&&merges.some(m=>m.s.r>r&&m.s.r<start&&m.s.c<=c&&m.e.c>=c&&m.e.c>m.s.c&&m.s.c>=merge.s.c&&m.e.c<=merge.e.c&&m.e.c-m.s.c<merge.e.c-merge.s.c);
    if(!nested&&!leafPath.includes(value))leafPath.push(value);
   }
   const mapped=profile?.columns?.[c];
   const bomPath=mapped?mapped.split(' / '):path.filter(value=>!/主槽.*管理槽/.test(value));
   const label=bomPath.join(' / ')||'原列'+address(0,c).slice(0,-1);
   const semantics=bomPath.flatMap(part=>part.split(/\s*\/\s*(?=(?:数量|用量|台数|套数|槽数|采购数量|订购数量|交付数量|设备数量|供货数量|工位|联数|内净尺寸|长|宽|高|材料|材质|板厚|厚度|壁厚|单位|规格))/));
   let type=c===name?'operation':c===seq?'station':fieldType(semantics);
   if(type==='unmapped'&&B?.configurationFamily(label))type='configuration';
   const explicitDevice=rows[index].some(value=>/^(?:设备|设备名称|部件名称|供货设备)$/.test(clean(value)));
   const device=semantics.slice(0,-1).join(' / ')||(type==='quantity'?(explicitDevice?'设备':''):semantics[0]||'');
   return {column:c,path,semanticPath:semantics,scope:B?.columnScope(semantics)||null,label,modelLabel:(mapped||leafPath.join(' / ')),type,device,mapped:mapped||''};
  });
  const issues=[],quantities=new Map();
  for(const col of columns.filter(col=>col.type==='quantity')){
   const device=clean(col.device),same=quantities.get(device)||[];
   same.push(col);quantities.set(device,same);
  }
  for(const [device,cols] of quantities)if(!device||cols.length>1){
   const explicit=cols.filter(col=>col.mapped);
   for(const col of cols)if((!device&&!col.mapped)||cols.length>1&&(explicit.length!==1||col!==explicit[0])){
    col.blocked=true;
    issues.push({kind:'mapping',row:index+1,column:col.column,range:sheet+'!'+address(index,col.column),message:device?'同一设备有多列数量，请确认取量列':'数量列缺少设备归属，请确认映射'});
   }
  }
  const stations=[];
  for(let r=start;r<end;r++){
   if(!isStation(rows[r],r))continue;
   const fields=columns.flatMap(col=>{
    const c=col.column,cell=address(r,c),merge=merges.find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=c&&m.e.c>=c);
    const anchor=merge?address(merge.s.r,merge.s.c):cell;
    const range=merge?anchor+':'+address(merge.e.r,merge.e.c):cell;
    const value=(merge?rows[merge.s.r]?.[merge.s.c]:rows[r][c])??'';
    if(!col.path.length&&!col.mapped&&!text(value))return [];
    const numeric=['length','width','height','thickness','quantity','chambers'].includes(col.type);
    const geometric=['length','width','height','thickness'].includes(col.type);
    const unit=col.label.normalize('NFKC').match(/(mm|cm|m|毫米|厘米|米|台|套|个|组|件|英寸|英尺|inch|feet|ft)\)?$/i)?.[1]||(col.type==='quantity'?text(value).match(/(台|套|个|组|件)\s*$/)?.[1]:'')||'';
    const unsupported=geometric&&/^(?:英寸|英尺|inch|feet|ft)$/i.test(unit);
    const scale=geometric?({cm:10,厘米:10,m:1000,米:1000}[unit.toLowerCase()]||1):1;
    const numericValue=number(col.type==='quantity'?text(value).replace(/\s*(台|套|个|组|件)\s*$/,''):value),normalized=numeric?(numericValue===null||unsupported?null:numericValue*scale):text(value);
    if(col.type==='unmapped'&&text(value))issues.push({kind:'mapping',row:r+1,column:c,range:sheet+'!'+range,message:'字段未匹配：'+col.label});
    return [{id:JSON.stringify([sheet,cell]),column:c,device:col.device,field:col.type,path:col.path,semanticPath:col.semanticPath,scope:col.scope,label:col.label,raw:source.rawValues?.[anchor]??value,value,normalized,unit,normalizedUnit:geometric?'mm':unit,sheet,cell,anchor,range:sheet+'!'+range,blocked:!!col.blocked}];
   });
   const stationNumber=seq==null?'':text(valueAt(r,seq));
   const group=fields.find(f=>f.field==='chambers');
   const operation=text(valueAt(r,name));
   const configurations=B?.configurations(fields,{filename:source.filename,sheet,row:r+1,stationNumber,operation})||[];
   stations.push({order:stations.length+1,row:r+1,stationNumber,operation,candidateGroup:group?.range||'',fields,configurations});
  }
  return {headerRow:index+1,headerEndRow:start,startRow:start+1,endRow:end,signature,nameColumn:name,stationColumn:seq??null,columns,stations,issues};
 });
 const stationRows=new Set(sections.flatMap(section=>section.stations.map(station=>station.row)));
 return {version:standardVersion,sheet,sections,otherRows:rows.flatMap((row,index)=>row.some(v=>text(v))&&!stationRows.has(index+1)?[index+1]:[])};
}
function splitCombinedNameSpecification(inputName,inputSpec){
 const originalName=text(inputName),spec=text(inputSpec),unchanged={name:originalName,spec};
 if(spec||!originalName)return unchanged;
 // A label introducing a combined cell is not the equipment name itself.
 const value=originalName.replace(/^(?:配置|配制|设备名称|部件名称|名称)\s*[:：]\s*/,''),technical=/采用|材质|主体|结构|板厚|壁厚|厚度|尺寸|直径|管径|功率|电压|电流|流量|过滤量|扬程|风量|压力|规格|型号|温度|不锈钢|钢板|方管|方通|焊接|制作|加工|防腐|喷塑|除锈|光电|射频|防干扰/;
 const numericUnit=/\d+(?:\.\d+)?\s*(?:T\s*\/\s*H|m[³3]\s*\/\s*h|L\s*\/\s*min|mm|cm|kg|kHz|Hz|kW|HP|W|V|A|米|毫米|厘米|吨\/时)(?![A-Za-z])/i;
 const technicalLead=/^(?:采用|配置|配备|材质|主体|结构|板厚|壁厚|厚度|尺寸|直径|管径|功率|电压|电流|流量|过滤量|扬程|风量|压力|规格|型号|温度|每(?:位|槽|组|套|台)\s*\d)/;
 const dimension=/\d+(?:\.\d+)?\s*[×xX＊*]\s*\d+(?:\.\d+)?|(?:长|宽|高|厚|直径|管径|DN|[Φφ])\s*[:：]?\s*\d|\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米|米)(?![A-Za-z])/i;
 const sensibleName=s=>s.length>=2&&s.length<=60&&!/[:：,，;；\r\n]/.test(s.replace(/[（(][^）)]*[）)]/g,''));
 const result=(at,skip=0)=>{const name=value.slice(0,at).trim(),description=value.slice(at+skip).trim();return sensibleName(name)&&description?{name,spec:description,originalName,originalCombinedText:originalName}:null;};
 let depth=0;
 for(let i=0;i<value.length;i++){
  const ch=value[i];
  if(!depth&&/[（(]/.test(ch)){
   const end=value.slice(i+1).search(/[）)]/);if(end>=0&&dimension.test(value.slice(i+1,i+1+end))){const found=result(i);if(found)return found;}
  }
  if(/[（(]/.test(ch)){depth++;continue;}if(/[）)]/.test(ch)){depth=Math.max(0,depth-1);continue;}if(depth)continue;
  if(value.startsWith('采用',i)&&i>0){const right=value.slice(i+2);if(technical.test(right)||numericUnit.test(right)){const found=result(i);if(found)return found;}}
  if(!/[:：,，\n]/.test(ch))continue;
  const right=value.slice(i+1).trim(),first=right.split(/[,，;；\r\n]/)[0];
  const reliable=/[,，]/.test(ch)?technicalLead.test(first)||numericUnit.test(first):technical.test(right)||numericUnit.test(right)||dimension.test(first);
  if(reliable){const found=result(i,1);if(found)return found;}
 }
 return unchanged;
}
// No eval: only arithmetic, cell references, SUM and ROUND are accepted.
function formulaValue(sheet,address,X,stack=new Set()){
 if(stack.has(address)||stack.size>80)return null;
 const c=sheet[address];if(!c)return 0;if(typeof c.v==='number'&&Number.isFinite(c.v))return c.v;if(!c.f)return number(c.v);
 const next=new Set(stack);next.add(address);
 let s=c.f.replace(/^=/,'').replace(/\$/g,'').toUpperCase();
 try{
  s=s.replace(/SUM\(([A-Z]+\d+):([A-Z]+\d+)\)/g,(_,a,b)=>{const ra=X.utils.decode_cell(a),rb=X.utils.decode_cell(b);if((rb.r-ra.r+1)*(rb.c-ra.c+1)>10000)throw Error();let total=0;for(let r=ra.r;r<=rb.r;r++)for(let c=ra.c;c<=rb.c;c++){const v=formulaValue(sheet,X.utils.encode_cell({r,c}),X,next);if(v===null)throw Error();total+=v;}return String(total);});
  s=s.replace(/\b[A-Z]{1,3}\d+\b/g,a=>{const v=formulaValue(sheet,a,X,next);if(v===null)throw Error();return String(v);});
  const tokens=s.match(/ROUND|SUM|\d+(?:\.\d+)?|[()+\-*/%,]/g)||[];if(tokens.join('')!==s.replace(/\s/g,''))return null;let i=0;
  function atom(){let v;if(tokens[i]==='-'){i++;return -atom();}if(tokens[i]==='+'){i++;return atom();}if(tokens[i]==='('){i++;v=expr();if(tokens[i++]!==')')throw Error();}else if(tokens[i]==='ROUND'||tokens[i]==='SUM'){const f=tokens[i++];if(tokens[i++]!=='(')throw Error();const args=[expr()];while(tokens[i]===','){i++;args.push(expr());}if(tokens[i++]!==')')throw Error();v=f==='SUM'?args.reduce((a,b)=>a+b,0):Math.round((args[0]+Number.EPSILON)*10**args[1])/10**args[1];}else{if(!/^\d/.test(tokens[i]||''))throw Error();v=Number(tokens[i++]);}if(tokens[i]==='%'){i++;v/=100;}return v;}
  function term(){let v=atom();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],b=atom();v=op==='*'?v*b:v/b;}return v;}
  function expr(){let v=term();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],b=term();v=op==='+'?v+b:v-b;}return v;}
  const value=expr();return i===tokens.length&&Number.isFinite(value)&&value>=0?value:null;
 }catch{return null;}
}
function buildProcess(source,standard,X){
 const B=typeof module!=='undefined'&&module.exports?require('./process-bom.js'):root.QuoteBOM;
 const {rows,merges,filename,sheet:sheetName}=source,items=[],warnings=[];
 for(const section of standard.sections){
  const map={name:section.nameColumn,seq:section.stationColumn},headers=section.columns.map(col=>col.blocked?'未确认数量列'+address(0,col.column).slice(0,-1):col.label);
  const bom=B.build({rows,merges,headers,start:section.startRow-1,map,filename,sheetName,X,section});
  if(bom){items.push(...bom.rows);warnings.push(...bom.warnings);continue;}
  for(const station of section.stations){
   const equipment=B.namedProcessEquipment(station,filename,sheetName);
   if(equipment){items.push(equipment);continue;}
   const fields=station.fields.filter(f=>!['operation','station'].includes(f.field)&&text(f.value));
   const device=fields.find(f=>/^(?:设备|设备名称|部件名称|供货设备)$/.test(clean(f.label)));
   const qty=fields.find(f=>f.field==='quantity'&&!f.blocked),unit=fields.find(f=>f.field==='unit');
   items.push({id:uid(),name:text(device?.value)||station.operation,spec:fields.filter(f=>f!==device).map(f=>f.label+'：'+f.value).join('\n'),brand:'',quantity:device?qty?.normalized??null:null,unit:device?text(unit?.value||qty?.unit):'',basePrice:null,override:null,selected:!!device,kind:device?'component':'requirement',group:sheetName,source:filename+' / '+sheetName+' / 第'+station.row+'行',sourceRow:station.row,bom:{role:device?'component':'requirement',supplyStatus:device?'confirmed':'pending',explicitDevice:!!device,stationNumber:station.stationNumber,operation:station.operation,sheet:sheetName,sourceRanges:fields.map(f=>f.range),fieldSources:fields,equipmentReferences:fields.filter(f=>f.field==='equipment_reference').map(f=>({name:text(f.value),range:f.range})),quantityBasis:qty&&device?'原表设备数量':'需确认设备供货数量'}});
  }
  const covered=new Set(items.filter(item=>item.bom?.explicitDevice||item.bom?.ruleId==='named-independent-equipment').flatMap(item=>item.bom.sourceRanges||[]));
  items.push(...B.configurationCandidates(section.stations,{filename,sheetName,parents:items,covered}));
  warnings.push(sheetName+'：部分工序缺少可识别的完整槽体尺寸，供货范围及数量请核对');
 }
 // The reference mechanism is independent of geometry: a usage column in a
 // complete tank matrix and a standalone usage sheet carries the same meaning.
 for(const station of standard.sections.flatMap(section=>section.stations)){
  const references=station.fields.filter(field=>field.field==='equipment_reference'&&text(field.value));if(!references.length)continue;
  const owner=items.find(row=>row.bom?.stationMembers?.some(member=>member.sourceRow===station.row))||items.find(row=>row.sourceRow===station.row);
  if(!owner)continue;owner.bom.equipmentReferences??=[];
  for(const field of references){
   const reference=owner.bom.equipmentReferences.find(ref=>ref.range===field.range&&ref.name===text(field.value))||{name:text(field.value),range:field.range};
   reference.station={row:station.row,stationNumber:station.stationNumber,operation:station.operation,sheet:sheetName};
   reference.evidence=station.fields.filter(f=>f.field==='equipment_reference'||f.field==='notes').map(f=>({range:f.range,label:f.label,value:f.raw??f.value,field:f.field}));
   if(!owner.bom.equipmentReferences.includes(reference))owner.bom.equipmentReferences.push(reference);
  }
 }
 const headerRows=new Set(standard.sections.flatMap(section=>Array.from({length:section.startRow-section.headerRow},(_,i)=>section.headerRow+i)));
 const configured=new Map();
 for(const row of standard.otherRows.filter(row=>!headerRows.has(row)))for(const [c,cell] of rows[row-1].entries()){
  const match=text(cell).normalize('NFKC').match(/^([^:：，,；;\d]{2,24}?)(?:数量|台数|套数)\s*:\s*(\d+(?:\.\d+)?)\s*(台|套|组|个|件)$/);
  if(!match)continue;
  const [,name,quantity,unit]=match;
  const key=clean(name),entry=configured.get(key)||{name,unit,row,quantity:Number(quantity),specs:[],ranges:[]};
  if(entry.quantity!==Number(quantity)||entry.unit!==unit)entry.quantity=null;
  entry.specs.push(text(cell));entry.ranges.push(sheetName+'!'+address(row-1,c));configured.set(key,entry);
 }
 for(const entry of configured.values())items.push({id:uid(),name:entry.name,spec:entry.specs.join('\n'),brand:'',quantity:entry.quantity,unit:entry.unit,basePrice:null,override:null,selected:false,kind:'requirement',group:sheetName,source:filename+' / '+sheetName+' / 第'+entry.row+'行',sourceRow:entry.row,bom:{role:'requirement',supplyStatus:'pending',sourceRanges:entry.ranges,quantityBasis:entry.quantity===null?'整线配置存在不同数量或单位，请核对':'原表整线配置数量，供货边界待核对'}});
 return {items,warnings};
}
function reconcileProcessSheets(quote){
 const sources=quote.sources.filter(source=>source.standardProcess);
 const mains=new Map(),devices=new Map();
 for(const source of sources){
  const prefix=source.filename+' / '+source.sheet+' / ';
  const stations=new Map(source.standardProcess.sections.flatMap(section=>section.stations.map(station=>[station.row,station])));
  for(const row of quote.rows.filter(row=>row.source?.startsWith(prefix)&&row.bom?.role==='tank')){
   for(const member of row.bom.stationMembers||[]){
    const station=stations.get(member.sourceRow);if(!station?.stationNumber)continue;
    const key=JSON.stringify([station.stationNumber,clean(station.operation)]);
    (mains.get(key)||mains.set(key,[]).get(key)).push({row,sheet:source.sheet});
   }
  }
 }
 for(const row of quote.rows.filter(row=>row.bom?.explicitDevice&&row.bom.stationNumber)){
  const key=JSON.stringify([row.bom.stationNumber,clean(row.bom.operation)]);
  const candidates=(mains.get(key)||[]).filter(main=>main.sheet!==row.bom.sheet);
  if(candidates.length===1){row.parentId=candidates[0].row.id;row.bom.parentId=row.parentId;row.bom.crossSheetSource=candidates[0].row.source;}
  if(candidates.length>1)row.warning='跨表工位对应不唯一，请确认设备归属';
  const deviceKey=key+clean(row.name);
  (devices.get(deviceKey)||devices.set(deviceKey,[]).get(deviceKey)).push(row);
 }
 for(const rows of devices.values())if(new Set(rows.map(row=>row.bom.sheet)).size>1){
  for(const row of rows){row.kind='requirement';row.selected=false;row.bom.supplyStatus='pending';row.warning='多页存在同工位同名设备，请核对独立或共用供货范围';}
 }
 // Usage records point to a physical delivery item; they are not additional
 // purchases. Link only an exact, unique equipment identity, including any tag.
 const physical=new Map();
 for(const row of quote.rows.filter(row=>row.kind!=='requirement'&&row.bom?.explicitDevice)){
  const key=clean(row.name).toUpperCase();(physical.get(key)||physical.set(key,[]).get(key)).push(row);
 }
 for(const usage of quote.rows.filter(row=>row.bom?.equipmentReferences?.length))for(const reference of usage.bom.equipmentReferences){
  const targets=(physical.get(clean(reference.name).toUpperCase())||[]).filter(row=>row.id!==usage.id);
  if(targets.length!==1){usage.bom.referenceStatus=targets.length?'ambiguous':'unresolved';usage.warning=targets.length?'同名供货设备不唯一，请核对设备编号':'尚未找到对应供货设备，请补设备清单';continue;}
  const target=targets[0],station=reference.station||{row:usage.sourceRow,stationNumber:usage.bom.stationNumber,operation:usage.bom.operation,sheet:usage.bom.sheet};
  target.bom.serviceStations??=[];if(!target.bom.serviceStations.some(s=>s.sheet===station.sheet&&s.row===station.row))target.bom.serviceStations.push(station);
  target.bom.usageEvidence??=[];for(const field of reference.evidence||usage.bom.fieldSources||[])if(!target.bom.usageEvidence.some(e=>e.range===field.range))target.bom.usageEvidence.push({range:field.range,label:field.label,value:field.raw??field.value,field:field.field});
  target.bom.sourceRanges=[...new Set([...(target.bom.sourceRanges||[]),...target.bom.usageEvidence.map(e=>e.range)])];target.bom.shared=target.bom.serviceStations.length>1;
  usage.bom.referenceStatus='linked';usage.bom.referenceIds=[...new Set([...(usage.bom.referenceIds||[]),target.id])];reference.targetId=target.id;
 }
}
function rebuildProcess(draft,profiles,X){
 const next=M.copy(draft),processed=new Set(),generated=[];
 delete next.decomposition;
 delete next.decompositionError;
 for(const source of next.sources){
  const standard=standardProcess(source,profiles);
  if(!standard||source.type==='quotation')continue;
  source.standardProcess=standard;source.type='process';
  processed.add(source.filename+' / '+source.sheet+' / ');
  generated.push(...buildProcess(source,standard,X).items);
 }
 next.rows=next.rows.filter(row=>![...processed].some(prefix=>row.source?.startsWith(prefix))).concat(generated);
 reconcileProcessSheets(next);
 const B=typeof module!=='undefined'&&module.exports?require('./business-structure.js'):root.QuoteBusinessStructure;
 B.attach(next);M.autoPrice(next);
 return next;
}
function taxReference(row,map,headers,{filename,sheetName,r,X}){
 const label=clean(row[map.name]);
 if(!/^(?:增值税(?:额|金)?|税金|税额|税费|税率|VAT|TAX)(?:\([^)]*\)|[:：]?\d+(?:\.\d+)?%?)*$/i.test(label))return null;
 const fields=row.flatMap((value,c)=>text(value)?[{label:headers[c]||'原列'+X.utils.encode_col(c),value:text(value),range:sheetName+'!'+X.utils.encode_cell({r,c}),column:c}]:[]);
 const source=filename+' / '+sheetName+' / 第'+(r+1)+'行',sourceRanges=fields.map(field=>field.range);
 const reference={name:row[map.name]??'',specification:row[map.spec]??'',quantity:row[map.quantity]??'',unit:row[map.unit]??'',unitPrice:row[map.price]??'',amount:row[map.amount]??'',fields};
 const percent=clean([reference.name,reference.specification].join(' ')).match(/(\d+(?:\.\d+)?)%/),rateOnly=/^税率/.test(label);
 const quantity=number(reference.quantity),price=number(reference.unitPrice);
 const rate=percent?Number(percent[1]):rateOnly?quantity??price:null;
 const amount=rateOnly?null:number(reference.amount)??(price===null?null:quantity===null?price:M.product(quantity,price))??(!text(reference.unit)?quantity:null);
 return {id:uid(),name:text(row[map.name]),spec:text(row[map.spec]),quantity:null,unit:'',basePrice:null,override:null,selected:false,kind:'requirement',source,sourceRow:r+1,priceSource:'',fields,reference,
  warning:'原表税额仅作参考，请确认本次税价口径',financialSource:{kind:'tax',rate,amount,source,sourceRow:r+1,sourceRanges,reference},
  bom:{role:'requirement',supplyStatus:'pending',sourceRanges,evidence:fields,quantityBasis:'税额参考，不是设备供货数量',missingConditions:['本次税价口径及计税基数']}};
}
function parse(buffer,filename,X,options={}){
 if(buffer.byteLength>20*1024*1024)throw Error('文件超过20MB，请拆分后导入。');
 const book=X.read(buffer,{type:'array',cellFormula:true,cellDates:false}),q=M.draft();q.title=filename.replace(/\.[^.]+$/,'');const warnings=[];
 for(const sheetName of book.SheetNames){if(options.sheets&&!options.sheets.includes(sheetName))continue;const sheet=book.Sheets[sheetName];if(!sheet['!ref'])continue;
  // Compute real content bounds; formatting-only distant cells are ignored.
  const cells=Object.entries(sheet).filter(([k,c])=>!k.startsWith('!')&&(c.v!==undefined&&c.v!==''||c.f));if(cells.length>150000)throw Error('表格内容过多，请按工作表拆分。');
  let maxR=0,maxC=0;for(const [a]of cells){const p=X.utils.decode_cell(a);maxR=Math.max(maxR,p.r);maxC=Math.max(maxC,p.c);}if(maxR>20000||maxC>300)throw Error('表格范围过大，请删除表外杂项后重试。');
  const rows=Array.from({length:maxR+1},()=>Array(maxC+1).fill('')),formulas={},rawValues={};for(const [a,c]of cells){const p=X.utils.decode_cell(a);rows[p.r][p.c]=c.v??'';if(c.f){formulas[a]=c.f;const value=formulaValue(sheet,a,X);if(value!==null){rawValues[a]=rows[p.r][p.c];rows[p.r][p.c]=value;}}}
  const source={filename,sheet:sheetName,rows,formulas,merges:sheet['!merges']||[]};
  if(Object.keys(rawValues).length)source.rawValues=rawValues;
  q.sources.push(source);
  function metadata(pattern){for(const row of rows)for(let c=0;c<row.length;c++){const match=text(row[c]).match(pattern);if(!match)continue;const inline=text(match[1]);if(inline)return inline;const next=text(row[c+1]);if(next&&!/[:：]/.test(next))return next;return '';}return '';}
  const customer=metadata(/^(?:客户名称|客[ \t]*户)[ \t]*[:：][ \t]*([^\r\n]*)/);if(customer&&!q.customer)q.customer=customer;
  const project=metadata(/^(?:项目|项[ \t]*目|工程名称)[ \t]*[:：][ \t]*([^\r\n]*)/);if(project)q.title=project;
  let headIndex=rows.findIndex(r=>{const h=header(r);return h&&(h.price!==undefined||h.unit!==undefined)&&h.quantity!==undefined;});
  const standard=standardProcess(source,options.processMappings);
  const quotation=headIndex>=0&&(!standard||!processName.test(clean(rows[headIndex][header(rows[headIndex]).name]))&&headIndex<standard.sections[0].headerRow-1);
  if(standard&&!quotation){
   source.standardProcess=standard;source.type='process';
   const built=buildProcess(source,standard,X);q.rows.push(...built.items);warnings.push(...built.warnings);
   continue;
  }
  source.type=quotation?'quotation':'unmapped';
  if(headIndex<0){warnings.push(sheetName+'：未找到名称及数量/工艺表头，原表已保留');continue;}
  let map=header(rows[headIndex]),headers=rows[headIndex].map(text),section=sheetName,last=null,mainSection='',subsection='';
  let inNotes=false;
  const rowFields=(row,r)=>row.flatMap((value,c)=>text(value)?[{label:headers[c]||'原列'+X.utils.encode_col(c),value:text(value),range:sheetName+'!'+X.utils.encode_cell({r,c}),column:c}]:[]);
  function appendContinuation(item,row,r){
   const continuation=text(row[map.spec]);if(!item||!continuation)return;
   item.spec+=(item.spec?'\n':'')+continuation;
   const fields=rowFields(row,r);item.fields=[...(item.fields||[]),...fields];
   item.bom??={role:'component'};item.bom.sourceRanges=[...new Set([...(item.bom.sourceRanges||[]),...item.fields.map(field=>field.range).filter(Boolean)])];
   item.bom.continuationEvidence=[...(item.bom.continuationEvidence||[]),...fields];
  }
  for(let r=headIndex+1;r<rows.length;r++){
   const row=rows[r],non=row.map(text).filter(Boolean),str=non.join(' ');if(!non.length)continue;
   if(/^(?:备注[:：]|注[:：]|商务条款|付款方式|交货)/.test(str)){inNotes=true;q.notes+=(q.notes?'\n':'')+str;continue;}if(inNotes){if(/^(?:购方|供方)(?:代表人签署|签署日期)\s*[:：]/.test(str)||(str.match(/(?:购方|供方)\s*[:：]/g)||[]).length>=2)continue;q.notes+='\n'+str;continue;}
   const h=header(row);if(h&&h.quantity!==undefined){map=h;headers=row.map(text);last=null;continue;}
   const financial=taxReference(row,map,headers,{filename,sheetName,r,X});if(financial){financial.group=section;q.rows.push(financial);last=null;continue;}
   if(/^(?:合计|总计|小计|未税合计|含税合计|税率|税额|本次最终报价|最终报价|总金额)/.test(str)){last=null;continue;}
   const chapter=non.find(v=>/^[一二三四五六七八九十百]+[、.．]/.test(v)&&v.length<100);
   if(chapter){mainSection=/^[一二三四五六七八九十百]+[、.．]+$/.test(chapter)?chapter+(non.find(v=>v!==chapter&&!/^\d+(?:\.\d+)?$/.test(v))||''):chapter;section=mainSection;subsection='';last=null;
    // A chapter marker can share a row with a priced assembly. Preserve that
    // assembly as a normal item under the new chapter instead of skipping it.
    if(!text(row[map.name])||(number(row[map.quantity])===null&&!text(row[map.price])))continue;
   }
   const wideHeading=non.length===1&&number(row[map.quantity])===null&&!text(row[map.price])&&(sheet['!merges']||[]).some(m=>m.s.r===r&&m.e.r===r&&m.s.c<=map.name&&m.e.c-m.s.c>=3&&m.e.c>=Math.max(map.name,map.spec??0));
   if(wideHeading){if(mainSection)subsection=str;else section=str;last=null;continue;}
   let name=text(row[map.name]),inheritedName=false;
   if(!name){const merge=(sheet['!merges']||[]).find(m=>m.s.r<=r&&m.e.r>=r&&m.s.c<=map.name&&m.e.c>=map.name);if(merge){name=text(rows[merge.s.r][merge.s.c]);inheritedName=true;}}
   const independentDetail=!name&&text(row[map.spec])&&number(row[map.quantity])!==null&&text(row[map.unit])&&(number(row[map.price])!==null||number(row[map.amount])!==null),detailParent=independentDetail?last:null;
   if(independentDetail)name=text(row[map.spec]).split(/\r?\n/)[0];
   if(inheritedName&&number(row[map.quantity])===null&&!text(row[map.price])){if(last&&(last.originalName??last.name)===name)appendContinuation(last,row,r);continue;}
   if(/(?:金额)?(?:合计|总计|小计)(?:\s*[(（].*[)）])?$/.test(clean(name))){last=null;continue;}
   if(non.length<=2&&name===''&&!number(row[map.quantity])){if(last&&text(row[map.spec]))appendContinuation(last,row,r);else if(non.length===1){if(mainSection)subsection=str;else section=str;last=null;}continue;}
   if(!name){appendContinuation(last,row,r);continue;}
   if(number(row[map.quantity])===null&&!text(row[map.price])&&!text(row[map.unit])){
    const seq=text(row[map.seq]);
    if(/^[一二三四五六七八九十百]+$/.test(seq)){mainSection=seq+'、'+name;section=mainSection;subsection='';last=null;continue;}
    const next=rows[r+1];if(map.seq!==undefined&&/^\d+[-.]\d+$/.test(seq)&&next&&!text(next[map.seq])&&text(next[map.name])&&number(next[map.quantity])!==null&&text(next[map.price])){subsection=name;last=null;continue;}
   }
   if(/^[一二三四五六七八九十]+[、.．]/.test(str)&&!number(row[map.price])){section=str;last=null;continue;}
   const fields=row.map((v,c)=>text(v)?{label:headers[c]||'原列'+X.utils.encode_col(c),value:text(v),range:sheetName+'!'+X.utils.encode_cell({r,c}),column:c}:null).filter(Boolean);
   const priceColumns=headers.map((v,c)=>/单价|售价|销售价/.test(clean(v))?c:-1).filter(c=>c>=0);
   let pc=map.price;if(priceColumns.length>1){const sales=priceColumns.filter(c=>/销售|售价|报价/.test(headers[c])&&!/采购|成本/.test(headers[c]));pc=sales.length===1?sales[0]:undefined;}
   const rawPrice=pc===undefined?'':row[pc],priceLabel=pc===undefined?'':headers[pc];let basePrice=number(rawPrice);
   if(/成本|采购|美元|USD|欧元|EUR|\$/i.test(priceLabel))basePrice=null;
   if(basePrice!==null&&/万元/.test(priceLabel))basePrice=M.product(basePrice,10000);
   const weightRate=basePrice!==null&&/(?:\/|每)(?:kg|公斤|千克)/i.test(priceLabel)&&!/^(?:kg|公斤|千克)$/i.test(text(row[map.unit]))?basePrice:null;
   if(weightRate!==null)basePrice=null;
   const address=pc===undefined?'':X.utils.encode_cell({r,c:pc});const cell=sheet[address];
   // A recap points back to a subtotal already represented by detailed lines.
   // Retain its source formula, but do not charge the same system a second time.
   const direct=cell?.f?.replace(/\$/g,'').replace(/^=/,'').match(/^([A-Z]+\d+)$/i);
   if(direct){const target=X.utils.decode_cell(direct[1]),targetText=(rows[target.r]||[]).map(text).join(' ');if(target.r<r&&/(?:合计|小计|总计)/.test(targetText)){last=null;continue;}}
   // An explicitly combined source column stores its first line as the item
   // name and its remaining lines as specifications. Its original cell and
   // fields stay intact; an independent specification column takes precedence.
   let combinedSpec;const originalCombinedName=name;
   if(map.spec===undefined&&/(?:及|和)(?:配置说明|配置|规格说明|规格|说明)$/.test(clean(headers[map.name]))){const lines=name.split(/\r?\n/);if(lines.length>1){name=text(lines[0]);combinedSpec=lines.slice(1).join('\n').trim();}}
   const separated=combinedSpec!==undefined?{name,spec:combinedSpec,originalName:originalCombinedName,originalCombinedText:originalCombinedName}:splitCombinedNameSpecification(name,text(row[map.spec]));
   if(separated)name=separated.name;
   const rowItem={id:uid(),name,spec:combinedSpec??text(row[map.spec]),brand:text(row[map.brand]),unit:text(row[map.unit]),quantity:number(row[map.quantity]),basePrice,override:null,selected:!/^不含|客户自备|客户提供$/.test(text(rawPrice)),group:section,source:filename+' / '+sheetName+' / 第'+(r+1)+'行',sourceFormula:cell?.f||'',priceSource:basePrice===null?'':cell?.f?'原表公式':'原表单价',fields,sourceRow:r+1};
   if(independentDetail){
    rowItem.kind='component';rowItem.reference={name:row[map.name]??'',specification:row[map.spec]??'',quantity:row[map.quantity]??'',unit:row[map.unit]??'',unitPrice:pc===undefined?'':row[pc]??'',amount:row[map.amount]??''};
    rowItem.bom={role:'component',ruleId:'specification-detail',nameSource:'specification',sourceRanges:fields.map(field=>field.range),evidence:fields,quantityEvidence:[{range:sheetName+'!'+X.utils.encode_cell({r,c:map.quantity}),value:row[map.quantity],normalized:rowItem.quantity}],quantityBasis:'原表空名称明细有独立数量、单位及量价，单独计量'};
    if(detailParent){rowItem.parentId=detailParent.id;rowItem.bom.parentId=detailParent.id;}
   }
   if(map.price===undefined&&map.amount===undefined)rowItem.bom={role:'component',explicitDevice:true,sheet:sheetName,sourceRanges:fields.map(f=>f.range),evidence:fields,quantityEvidence:[{range:sheetName+'!'+X.utils.encode_cell({r,c:map.quantity}),value:row[map.quantity],normalized:rowItem.quantity}],quantityBasis:'原设备清单独立供货数量；使用关系不累计为供货'};
   if(separated)Object.assign(rowItem,separated);
   if(mainSection){rowItem.group=mainSection;if(subsection)rowItem.subgroup=subsection;}
   if(weightRate!==null)rowItem.spec+=(rowItem.spec?'\n':'')+'每公斤报价：'+weightRate;
   if(cell?.f&&basePrice===null)rowItem.warning='单价公式无可计算结果，请手动补价';
   if(priceColumns.length>1&&pc===undefined)rowItem.warning='原表有多列价格，请选择本次单价';
   q.rows.push(rowItem);last=rowItem;
  }
 }
 q.warnings=[...new Set(warnings)];if(!q.rows.length&&!options.allowUnmapped)throw Error('未识别到可报价条目。请使用含“名称、数量”等表头的清单；原文件未修改。');const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;F.splitProcess(q);reconcileProcessSheets(q);const B=typeof module!=='undefined'&&module.exports?require('./business-structure.js'):root.QuoteBusinessStructure;B?.attach(q);M.autoPrice(q);return q;
}
 root.QuoteImporter={parse,formulaValue,splitCombinedNameSpecification,standardProcess,rebuildProcess};if(typeof module!=='undefined')module.exports=root.QuoteImporter;
})(typeof window!=='undefined'?window:globalThis);
