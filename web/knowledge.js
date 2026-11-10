(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const PF=typeof module!=='undefined'&&module.exports?require('./price-features.js'):root.QuotePriceFeatures;
const VERSION='2026-11-05.2';
const norm=v=>String(v??'').normalize('NFKC').trim();
const compact=v=>norm(v).toUpperCase().replace(/[\s，,;；:：]/g,'').replace(/[×＊*]/g,'X');
const clone=v=>JSON.parse(JSON.stringify(v));
const unique=a=>[...new Set(a)];
const number=v=>{if(v===null||v===undefined||v==='')return null;const s=norm(v).replace(/[,，￥¥]/g,'').replace(/元$/,'');return /^\d+(?:\.\d+)?$/.test(s)?Number(s):null;};
const LABELS={name:'部件名称',spec:'完整规格',unit:'计量单位',material:'材料牌号',materialGrade:'材料具体牌号',length:'长度',width:'宽度',height:'高度',thickness:'板厚/壁厚',flow:'流量',flowUnit:'流量单位',voltage:'输出电压',current:'输出电流',power:'功率',frequency:'频率Hz',transducerCount:'振子数量',surfaceFinish:'表面处理',chambers:'联槽节数',linkedChambers:'联槽节数',diameter:'外径/管径',technology:'电源类型',cooling:'冷却方式',sharedScope:'设备共用范围',scope:'供货包含范围',currency:'币种',taxMode:'税价口径',taxRate:'税率',enterpriseId:'企业价格口径',bathType:'槽液类别',tankVolume:'槽液容积',turnoverRate:'每小时周转率',concentration:'槽液浓度',temperature:'工作温度'};
const EQUIPMENT=new Set(['filter','rectifier','heater','pump','ultrasonic','hoist','electrical','exhaust','cooling']);
const REQUIRED={tank:['length','width','height','thickness','material'],filter:['flow','flowUnit','material'],rectifier:['voltage','current'],heater:['material','power'],pump:['flow','flowUnit','material'],pipe:['material','diameter'],busbar:['material','width','thickness'],structure:[],hoist:[],electrical:[],ultrasonic:['power','frequency'],exhaust:[],cooling:[]};
const SPECIAL=/油水分离|水浴.*(?:内槽|内胆)|加热内槽|保温|岩棉|夹套|内衬|钢衬|双层|内外槽|外槽|连槽|联槽|(?:二|两|三|四|五|六|七|八|九|十|\d+)[联连]|隔板|圆形|圆筒|槽盖|封闭结构|异形/i;
let catalog={version:VERSION,sources:[],terms:[],entries:[]};

function load(bundle){
 if(!bundle||!Array.isArray(bundle.sources)||!Array.isArray(bundle.entries)||!Array.isArray(bundle.terms))throw new Error('知识包需要 sources、entries、terms 数组');
 const ids=new Set();for(const s of bundle.sources){if(!s.id||ids.has(s.id))throw new Error('知识来源ID为空或重复');ids.add(s.id);}
 const entryIds=new Set();for(const item of [...bundle.entries,...bundle.terms]){if(!item.id||entryIds.has(item.id))throw new Error('知识条目ID为空或重复');entryIds.add(item.id);for(const ref of item.sourceRefs||[])if(!ids.has(ref.sourceId))throw new Error('知识条目引用未知来源：'+ref.sourceId);}
 catalog=clone(bundle);return {version:catalog.version,sourceCount:catalog.sources.length,entryCount:catalog.entries.length,termCount:catalog.terms.length};
}
function sourceDetails(refs){return (refs||[]).map(ref=>({...ref,...catalog.sources.find(s=>s.id===ref.sourceId)}));}
function queryTokens(query){
 const s=compact(query),tokens=[];for(const term of catalog.terms)for(const alias of [term.name,...term.aliases||[]])if(s.includes(compact(alias)))tokens.push(compact(alias));
 tokens.push(...s.match(/[A-Z][A-Z0-9.-]{1,}|[\u3400-\u9fff]{2,}/g)||[]);
 for(const chinese of s.match(/[\u3400-\u9fff]{2,}/g)||[])for(let i=0;i<chinese.length-1;i++)tokens.push(chinese.slice(i,i+2));
 return unique(tokens.filter(Boolean));
}
function search(query,{limit=6}={}){
 const q=compact(query);if(!q)return [];
 const tokens=queryTokens(query),termCategories=new Set(catalog.terms.filter(t=>[t.name,...t.aliases||[]].some(a=>q.includes(compact(a)))).map(t=>t.category));
 return catalog.entries.map(entry=>{const title=compact(entry.title),aliases=(entry.aliases||[]).map(compact),haystack=compact([entry.title,entry.summary,...entry.conditions||[],...entry.aliases||[]].join(' '));let score=haystack.includes(q)?20:0;for(const token of tokens){if(title.includes(token))score+=5;else if(aliases.some(a=>a===token))score+=4;else if(haystack.includes(token))score++;}if(score&&termCategories.has(entry.category))score+=3;return {...clone(entry),score,resolvedSources:sourceDetails(entry.sourceRefs)};}).filter(e=>e.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,Math.max(0,Math.min(50,Number(limit)||6)));
}
function tankShellName(value){
 const name=norm(value).replace(/\s*[（(][^()（）]*[）)]\s*(?:mm|cm|m)?\s*$/i,'').trim();
 return /槽(?:体|本体)?(?:\s*[-·#]?\s*(?:第\s*)?\d+\s*[#号]?)?$/.test(name);
}
function classify(row){
 const name=norm(row.name),combined=name+' '+norm(row.spec);
 if(row.kind==='requirement'||row.bom?.role==='requirement')return 'requirement';
 if(row.kind==='process'||row.bom?.role==='process')return 'process';
 // The supplied object is the tank shell even when its process uses ultrasound,
 // electrolysis or heating. Its separate generator, heater, pump and lid are not.
 if(F?.isTankBody?F.isTankBody(row):row.bom?.role==='tank'||tankShellName(name))return 'tank';
 if(/(?:槽盖|盖板|配件|附件|支架|固定架|接液盘)$/.test(name))return 'other';
 // A control package can mention every connected machine without becoming one.
 const suppliedName=name.replace(/[（(][\s\S]*$/,'').replace(/[:：]+$/,'').trim();
 if(/(?:控制系统|通讯控制|通信控制|供电.*控制|监测及控制|检测及控制|行车控制|移送车控制)$/.test(suppliedName))return 'electrical';
 const ordered=['filter','rectifier','heater','cooling','busbar','pump','hoist','electrical','ultrasonic','exhaust','structure','pipe'];
 for(const category of ordered)if(catalog.terms.some(t=>t.category===category&&[t.name,...t.aliases||[]].some(a=>compact(name).includes(compact(a)))))return category;
 for(const category of ordered)if(catalog.terms.some(t=>t.category===category&&[t.name,...t.aliases||[]].some(a=>compact(combined).includes(compact(a)))))return category;
 if(catalog.terms.some(t=>t.category==='process'&&t.aliases.some(a=>compact(combined).includes(compact(a)))))return row.kind==='process'||number(row.offeredUnitPrice??row.unitPrice??row.override??row.basePrice??row.price)===null?'process':'other';
 return 'other';
}
function canonicalMaterial(value){
 const s=compact(value).replace(/SUS\s*/g,'SUS');
 if(/进口PP/.test(s))return 'IMPORT_PP';if(/^(?:PP-S|PPS)$/.test(s))return 'PPS';
 const steel=s.match(/^(?:SUS)?(304|316)(L)?(?:不锈钢|镜面|拉丝|抛光|板材|板|钢|#|2B|BA)*$/i);if(steel)return 'SUS'+steel[1]+(steel[2]||'');
 if(/^(?:304|316)L?$/.test(s))return 'SUS'+s;
 if(/^(?:TI|钛)$/.test(s))return 'TI';return s;
}
function unit(value){const s=compact(value);return ({'千克':'kg','公斤':'kg','KG':'kg','米':'m','M':'m','毫米':'mm','MM':'mm','平方米':'m2','M²':'m2','M2':'m2','吨':'t','T':'t'})[s]||s;}
function chamberNumber(value){
 const s=norm(value),numeric=number(s);if(numeric!==null)return numeric;
 const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
 if(s==='十')return 10;if(s.includes('十')){const [a,b]=s.split('十');if((!a||digits[a]!==undefined)&&(!b||digits[b]!==undefined))return (a?digits[a]:1)*10+(b?digits[b]:0);}
 return digits[s]??null;
}
function extract(row,category){
 const text=PF.text(row.name)+' '+PF.text(row.spec),p={},conflicts=[],sets={};
 const put=(k,v)=>{if(v===null||v===undefined||v==='')return;(sets[k]??=[]).push(v);};
 const parsed=F?.parameters?F.parameters(PF.text(row.spec),{triples:category==='tank',scope:category==='tank'?'tank':undefined}):{params:{},issues:[]};
 for(const key of ['length','width','height','thickness','diameter'])if(parsed.params[key]!==undefined&&(category==='tank'||key!=='thickness'||/板厚|壁厚|厚度/.test(text)))put(key,parsed.params[key]);conflicts.push(...parsed.issues);
 for(const [key,value]of Object.entries(row.geometry||{}))if(['length','width','height','thickness'].includes(key)&&number(value)!==null)put(key,Number(value));
 const materialText=category==='tank'?PF.text(row.name)+' '+PF.text(parsed.primaryText??row.spec):text;
 const materials=[...materialText.matchAll(/(?<![A-Z])(?:进口\s*PP|SUS(?:\s*(?:304|316)L?)?|PP-S|PPS|PP|PVDF|PTFE|PVC|FRP|SS41|Q235|Q355|TI)(?![A-Z0-9])|钛/gi)].map(m=>canonicalMaterial(m[0]));
 if(row.geometry?.material)materials.push(canonicalMaterial(row.geometry.material));if(row.material)materials.push(canonicalMaterial(row.material));
 for(const m of materials)put('material',m);
 for(const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(T\s*\/\s*H|吨\s*\/\s*时|m[³3]\s*\/\s*h|立方(?:米)?\s*\/\s*时|L\s*\/\s*min|升\s*\/\s*分钟)/gi)){put('flow',Number(m[1]));put('flowUnit',/^(?:T|吨)/i.test(m[2])?'t/h':/^(?:L|升)/i.test(m[2])?'l/min':'m3/h');}
 for(const [key,re]of [['voltage',/(\d+(?:\.\d+)?)\s*V(?![A-Z])/gi],['current',/(\d+(?:\.\d+)?)\s*A(?![A-Z])/gi],['diameter',/(?:管径|外径|直径|DN|[ΦφØ])\s*[:：]?\s*(\d+(?:\.\d+)?)/gi],['head',/扬程\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:m|米)/gi]])for(const m of text.matchAll(re))put(key,Number(m[1]));
 // A workbook header may carry the unit ("总功率KW:8"), while a price
 // book writes it after the value ("8000W"). Keep one canonical unit.
 for(const m of text.matchAll(/(\d+(?:\.\d+)?)[ \t]*(KW|W|千瓦|瓦)(?![A-Z])/gi))put('power',Number(m[1])*(/^(?:W|瓦)$/i.test(m[2])?.001:1));
 for(const m of text.matchAll(/(?:总[ \t]*)?(?:功率[ \t]*)?[（(\[]?[ \t]*(KW|W|千瓦|瓦)[ \t]*[）)\]]?[ \t]*[:：=][ \t]*(\d+(?:\.\d+)?)(?![\d.])(?![ \t]*[A-Z])/gi))put('power',Number(m[2])*(/^(?:W|瓦)$/i.test(m[1])?.001:1));
 for(const m of text.matchAll(/(\d+(?:\.\d+)?)[ \t]*(KHZ|HZ|千赫兹|赫兹)(?![A-Z])/gi))put('frequency',Number(m[1])*(/^(?:KHZ|千赫兹)$/i.test(m[2])?1000:1));
 for(const m of text.matchAll(/(?:频率[ \t]*)?[（(\[]?[ \t]*(KHZ|HZ|千赫兹|赫兹)[ \t]*[）)\]]?[ \t]*[:：=][ \t]*(\d+(?:\.\d+)?)(?![\d.])[ \t]*(K)?(?![ \t]*[A-Z])/gi))put('frequency',Number(m[2])*(m[3]||/^(?:KHZ|千赫兹)$/i.test(m[1])?1000:1));
 for(const [key,symbol]of [['voltage','V'],['current','A']])for(const m of text.matchAll(new RegExp('(?:电压|电流|输出)?[ \\t]*[（(\\[]?[ \\t]*'+symbol+'[ \\t]*[）)\\]]?[ \\t]*[:：=][ \\t]*(\\d+(?:\\.\\d+)?)(?![\\d.])(?![ \\t]*[A-Z])','gi')))put(key,Number(m[1]));
 for(const m of text.matchAll(/V\s*\/\s*A\s*[:：]\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/gi)){put('voltage',Number(m[1]));put('current',Number(m[2]));}
 const technology=text.match(/IGBT|SCR|可控硅|高频|脉冲|PWM/gi);if(technology)technology.forEach(t=>put('technology',compact(t)));
 const finish=text.match(/镜面|拉丝|抛光/g);if(finish)finish.forEach(value=>put('surfaceFinish',value));
 const cooling=text.match(/风冷|水冷/g);if(cooling)cooling.forEach(t=>put('cooling',t));
 if(category==='ultrasonic'){
  for(const m of text.matchAll(/(\d+(?:\.\d+)?)\s*K\s*\/\s*\d+(?:\.\d+)?\s*KW/gi))put('frequency',Number(m[1])*1000);
  for(const m of text.matchAll(/(\d+)[ \t]*(?:个|只|枚)?[ \t]*(?:振子|换能器)/g))put('transducerCount',Number(m[1]));
  for(const m of text.matchAll(/(?:振子|换能器)(?:数量|数)?[ \t]*[:：=][ \t]*(\d+)/g))put('transducerCount',Number(m[1]));
 }
 if(category==='tank'){
  const addChambers=value=>{if(value===null||value===undefined||value==='')return;const count=chamberNumber(value);if(!Number.isInteger(count)||count<1){conflicts.push('联槽节数应为正整数');return;}put('linkedChambers',count);put('chambers',count);};
  addChambers(row.bom?.chamberCount);addChambers(row.geometry?.chambers);
  for(const m of text.matchAll(/([一二两三四五六七八九十\d]+)[ \t]*[联连]/g))addChambers(m[1]);
  if(/单槽|独立槽/.test(text)||/^单[^\n联连]{0,20}(?:槽|位)(?:体)?$/.test(norm(row.name)))addChambers(1);
 }
 for(const [k,values]of Object.entries(sets)){const distinct=unique(values);if(distinct.length===1)p[k]=distinct[0];else conflicts.push((LABELS[k]||k)+'出现多个值：'+distinct.join('、'));}
 const layers=clone(parsed.layers||[]);for(const layer of layers.filter(layer=>layer.role!=='body'))for(const issue of layer.issues||[])conflicts.push('结构层 '+layer.text+'：'+issue);
 return {parameters:p,conflicts:unique(conflicts),primaryText:parsed.primaryText??norm(row.spec),layers,hasScopedLayers:!!parsed.hasScopedLayers};
}
function describeRow(row){
 const category=classify(row),parsed=extract(row,category),parameters=parsed.parameters;
 const required=REQUIRED[category]||[],missingFields=required.filter(k=>parameters[k]===undefined);
 if(parameters.material==='SUS')missingFields.push('materialGrade');
 if(!norm(row.unit)&&!['process','requirement'].includes(category))missingFields.push('unit');
 const results=search(norm(row.name)+' '+norm(row.spec),{limit:6});
 const tasks=missingFields.map(field=>({type:'missing_parameter',field,title:'补充'+(LABELS[field]||field),action:'从原配置/图纸或对应型号资料取得'+(LABELS[field]||field),sourceRefs:results.flatMap(e=>e.sourceRefs||[]).filter((v,i,a)=>a.findIndex(x=>x.sourceId===v.sourceId&&x.location===v.location)===i)}));
 for(const conflict of parsed.conflicts)tasks.push({type:'conflicting_parameter',title:conflict,action:'核对对应原始单元格或图纸，选定本行供货部件的参数'});
 if(category==='tank'&&SPECIAL.test(norm(row.name)+' '+norm(row.spec)))tasks.push({type:'special_structure',title:'特殊结构单独核价',action:'列明联槽/保温/内衬等结构，采用对应历史规格或分项成本依据'});
 if(category==='requirement'||category==='process'||category==='other')tasks.push({type:'identify_supply',title:category==='other'?'识别新增部件':'明确工艺要求对应的供货项',action:'检索原厂/行业资料，补设备名称、规格、数量与包含范围；保留原文'});
 return {category,parameters,primaryText:parsed.primaryText,layers:parsed.layers,hasScopedLayers:parsed.hasScopedLayers,missingFields:unique(missingFields),issues:parsed.conflicts,ruleRefs:results.map(e=>e.id),sourceRefs:results.flatMap(e=>e.sourceRefs||[]).filter((v,i,a)=>a.findIndex(x=>x.sourceId===v.sourceId&&x.location===v.location)===i),tasks};
}
function nameIdentity(row,category){
 if(category==='ultrasonic'){
  const n=compact(row.name),contents=norm(row.spec)+' '+norm(row.supplyScope??row.scope);
  if(/^(?:超声波|超声)?(?:投入式)?(?:振板|震板|换能器)$/.test(n))return 'ultrasonic:plate';
  if(/发生器|GENERATOR/.test(n))return /振板|振子|换能器/.test(contents)&&!/(?:不含|不配|不包括)[^；;。\n]{0,10}(?:振板|振子|换能器)/.test(contents)?'ultrasonic':'ultrasonic:generator';
 }
 const n=compact(row.name);const term=catalog.terms.find(t=>t.category===category&&[t.name,...t.aliases||[]].map(compact).includes(n));
 if(term)return term.id;
 const cleaned=PF.qualifiers(row.name).replace(/\|/g,''),decorated=catalog.terms.find(t=>t.category===category&&[t.name,...t.aliases||[]].map(compact).includes(compact(cleaned)));
 if(decorated)return decorated.id;
 // A process qualifier or rated output does not rename the rectifier itself;
 // its communication/control package remains a different supplied component.
 if(category==='rectifier'&&/(?:整流机|整流器|RECTIFIER)/.test(n)&&!/(?:控制|通讯|通信|配电|配线|电源线)/.test(n))return 'rectifier';
 return n;
}
function scope(row){const value=row.supplyScope??row.scope??'';return recorded(value)?compact(value):'';}
function recorded(value){return value!==null&&value!==undefined&&norm(value)!==''&&!/^(?:unknown|unspecified|未注明|不详|未知|待确认|待核对)$/i.test(norm(value));}
function businessKnown(context,key){if(!recorded(context?.[key]))return false;if(key==='taxMode')return /^(?:included|excluded)$/.test(context[key]);if(key==='taxRate')return businessKnown(context,'taxMode');return true;}
function businessContext(row,metadata={}){const input=row.priceContext||{};return {currency:compact(input.currency||row.currency||metadata.currency||'CNY'),taxMode:norm(input.taxMode||row.taxMode||metadata.taxMode),taxRate:number(input.taxRate??row.taxRate??metadata.taxRate),enterpriseId:norm(input.enterpriseId||row.enterpriseId||metadata.enterpriseId)};}
function effectiveContext(row,quote){
 const defaults=quote?{currency:quote.currency,taxMode:quote.taxMode,taxRate:quote.taxRate,...quote.pricingDefaults}:{};
 const own=businessContext(row),resolved=businessContext(row,defaults),inheritedFields=[];
 for(const key of ['taxMode','enterpriseId'])if(!recorded(own[key])&&recorded(defaults[key]))resolved[key]=norm(defaults[key]);
 for(const key of ['taxMode','taxRate','enterpriseId'])if(!recorded(own[key])&&recorded(resolved[key]))inheritedFields.push(key);
 const ownScope=scope(row),defaultScope=quote?norm(defaults.scopeDefault||'按本报价部件分项供货'):'';
 if(!ownScope&&defaultScope)inheritedFields.push('scope');
 return {...resolved,scope:ownScope||compact(defaultScope),scopeText:norm(row.supplyScope??row.scope??'')||defaultScope,inheritedFields};
}
function isFinishedEquipment(row){const category=classify(row);return EQUIPMENT.has(category)||(['accessory','shared'].includes(row.bom?.role)&&!['tank','requirement','process'].includes(category)&&!F?.candidate?.(row));}
function buildPriceIndex(rows,sourceMetadata={}){
 if(!Array.isArray(rows))throw new Error('价格索引需要明细数组');
 const metadata=clone(sourceMetadata),sourceId=norm(metadata.id||metadata.sourceId||'imported-history'),records=[],rejected=[],seen=new Set();
 rows.forEach((row,index)=>{
  const detail=describeRow(row),unitPrice=number(row.offeredUnitPrice??row.unitPrice??row.override??row.basePrice??row.price);
  const reason=detail.category==='requirement'||detail.category==='process'?'工艺要求不作价格行':!norm(row.name)?'缺少名称':unitPrice===null?'没有有效单价':!norm(row.unit)?'缺少计量单位':'';
  if(reason){rejected.push({rowId:row.id||null,rowIndex:index,reason});return;}
  const sourceRef={sourceId,location:row.source||[metadata.filename||metadata.file,metadata.sheet,row.sourceRow?'第'+row.sourceRow+'行':'明细'+(index+1)].filter(Boolean).join(' / '),sourceRow:row.sourceRow||null,sourceRanges:clone(row.bom?.sourceRanges||[])};
  const record={id:sourceId+':'+(row.sourceRow||index+1)+':'+index,name:norm(row.name),spec:norm(row.spec),brand:compact(row.brand),unit:unit(row.unit),scope:scope(row),category:detail.category,bomRole:row.bom?.role||null,bomChamberCount:row.bom?.chamberCount??row.geometry?.chambers??null,parameters:detail.parameters,primaryText:detail.primaryText,layers:detail.layers,hasScopedLayers:detail.hasScopedLayers,issues:detail.issues,missingFields:detail.missingFields,nameIdentity:nameIdentity(row,detail.category),price:unitPrice,quantity:number(row.quantity),priceNature:norm(metadata.priceNature||'historical_quote'),date:norm(metadata.date||metadata.quoteDate||''),businessContext:businessContext(row,metadata),sourceRefs:[sourceRef]};
  const key=JSON.stringify([sourceRef.location,record.name,record.spec,record.brand,record.unit,record.scope,record.price]);if(seen.has(key))return;seen.add(key);records.push(record);
 });
 return {version:VERSION,source:{...metadata,id:sourceId,priceNature:norm(metadata.priceNature||'historical_quote')},records,rejected};
}
function normalizePriceIndex(index){
 const records=Array.isArray(index)?index:index?.records||[];
 const normalized=records.map(record=>{
  // Older stored indexes classified process-named shells as purchased devices.
  // Re-read only those shells; keep the stored index, IDs and price evidence intact.
  const count=record.bomChamberCount??record.parameters?.linkedChambers??record.parameters?.chambers;
  const row=record.bomRole||count!==undefined?{...record,bom:{role:record.bomRole,chamberCount:count}}:record,category=classify(row);
  if(record.category!=='tank'&&category!=='tank'){
   if(!EQUIPMENT.has(category))return record;
   const parsed=extract(row,category),parameters={...record.parameters,...parsed.parameters},oldRequired=REQUIRED[record.category]||[];
   return {...record,category,parameters,nameIdentity:nameIdentity(row,category),issues:unique([...(record.issues||[]),...parsed.conflicts]),missingFields:unique([...(record.missingFields||[]).filter(field=>!oldRequired.includes(field)),...(REQUIRED[category]||[]).filter(field=>parameters[field]===undefined),...(parameters.material==='SUS'?['materialGrade']:[])])};
  }
  const parsed=extract(row,category),oldRequired=REQUIRED[record.category]||[],missingFields=(REQUIRED[category]||[]).filter(field=>parsed.parameters[field]===undefined);
  const resolvedScoped=parsed.hasScopedLayers&&!parsed.conflicts.length;
  const staleIssue=issue=>resolvedScoped&&Object.keys(parsed.parameters).some(field=>issue===(F?.LABELS?.[field]||LABELS[field])+'有多个值，请确认'||issue.startsWith((LABELS[field]||field)+'出现多个值：'));
  return {...record,category,parameters:parsed.parameters,primaryText:parsed.primaryText,layers:parsed.layers,hasScopedLayers:parsed.hasScopedLayers,
   issues:unique([...(record.issues||[]).filter(issue=>!staleIssue(issue)),...parsed.conflicts]),
   missingFields:unique([...(record.missingFields||[]).filter(field=>!oldRequired.includes(field)),...missingFields]),
   nameIdentity:nameIdentity(row,category)};
 });
 return Array.isArray(index)?normalized:{...index,records:normalized};
}
function sameValue(a,b){return typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<1e-9:a===b;}
function candidateDistance(candidate){let distance=0;for(const [key,value]of Object.entries(candidate.matchedParameters||{}))if(value!==undefined)distance-=.01;for(const [key,value]of Object.entries(candidate.record.parameters||{})){const current=candidate.currentParameters?.[key];if(current===undefined)continue;if(!sameValue(current,value))distance+=typeof current==='number'&&typeof value==='number'?Math.abs(current-value)/Math.max(Math.abs(current),Math.abs(value),1):1;}return distance;}
function assess(row,detail,record,options={}){
 const differences=[],missing=[],context=effectiveContext(row,options.quote),parameters=detail.parameters,recordScope=recorded(record.scope)?compact(record.scope):'';
 if(unit(row.unit)!==record.unit)differences.push('计量单位不同：'+(row.unit||'空')+' / '+record.unit);
 if(compact(row.brand)!==record.brand)differences.push('品牌不同或有一方未注明');
 if(scope(row)!==recordScope){if(scope(row)&&recordScope)differences.push('供货范围不同');else missing.push('scope');}
 if(nameIdentity(row,detail.category)!==record.nameIdentity)missing.push('name');
 for(const key of unique([...Object.keys(parameters),...Object.keys(record.parameters)])){if(parameters[key]===undefined||record.parameters[key]===undefined)missing.push(key);else if(!sameValue(parameters[key],record.parameters[key]))differences.push((LABELS[key]||key)+'不同：'+parameters[key]+' / '+record.parameters[key]);}
 for(const key of ['currency','taxMode','taxRate','enterpriseId']){const a=context[key],b=record.businessContext?.[key],hasA=businessKnown(context,key),hasB=businessKnown(record.businessContext,key),label=LABELS[key];if(hasA&&hasB&&a!==b)differences.push(label+'不同');else if(hasA!==hasB||options.quote&&key==='taxMode'&&!hasB)missing.push(key);}
 missing.push(...detail.missingFields,...record.missingFields);
 if(detail.issues.length||record.issues.length)missing.push('conflictingParameters');
 const exactSpec=compact(row.spec)===compact(record.spec)&&!!norm(row.spec);
 // Equal dimensions do not make a lid/lining/control inclusion interchangeable.
 if(!exactSpec)missing.push('spec');
 if(!norm(row.spec)&&!Object.keys(parameters).length)missing.push('spec');
 const exact=!differences.length&&!missing.length;
 const sameComponent=nameIdentity(row,detail.category)===record.nameIdentity&&detail.category===record.category;
 const blockingDifferences=[],warnings=[],matchedParameters={},technicalMissing=[];
 const packageUnits=sameComponent&&detail.category==='ultrasonic'&&new Set([unit(row.unit),record.unit]).size===2&&[unit(row.unit),record.unit].every(value=>['组','套'].includes(value));
 if(record.priceNature!=='historical_quote')blockingDifferences.push('该记录是成本或其他参考价格，不能直接作为本企业报价');
 if(!sameComponent)blockingDifferences.push('部件名称或类别不同');
 if(unit(row.unit)&&record.unit&&unit(row.unit)!==record.unit){if(packageUnits)warnings.push('本行按'+row.unit+'、历史按'+record.unit+'；发生器和振板的组/套供货范围待确认，保留本行数量');else blockingDifferences.push('计量单位不同：'+row.unit+' / '+record.unit);}
 if(compact(row.brand)&&record.brand&&compact(row.brand)!==record.brand)blockingDifferences.push('品牌不同：'+row.brand+' / '+record.brand);
 if(scope(row)&&recordScope&&scope(row)!==recordScope)blockingDifferences.push('供货范围不同');
 for(const key of unique([...Object.keys(parameters),...Object.keys(record.parameters||{})])){
  if(parameters[key]!==undefined&&record.parameters?.[key]!==undefined){
   if(!sameValue(parameters[key],record.parameters[key]))blockingDifferences.push((LABELS[key]||key)+'不同：'+parameters[key]+' / '+record.parameters[key]);
   else matchedParameters[key]=parameters[key];
  }
 }
 for(const key of ['currency','taxMode','taxRate','enterpriseId']){
  const a=context[key],b=record.businessContext?.[key],hasA=businessKnown(context,key),hasB=businessKnown(record.businessContext,key);
  if(hasA&&hasB&&a!==b)blockingDifferences.push((LABELS[key]||key)+'不同：'+a+' / '+b);
  else if(hasA!==hasB||key==='taxMode'&&!hasB)warnings.push((LABELS[key]||key)+'有一方未注明，采用前确认原价口径');
 }
 if(detail.issues.length||record.issues?.length)blockingDifferences.push('原始参数存在冲突，请先核对');
 if(record.learnedCase&&record.quantities?.length&&number(row.quantity)!==null&&!record.quantities.includes(number(row.quantity)))warnings.push('本单数量 '+row.quantity+' 与历史数量 '+record.quantities.join('、')+' 不同，确认批量价格条件');
 if(record.learnedCase&&record.saleTerms&&compact(record.saleTerms)!==compact(options.quote?.businessTerms||''))warnings.push('历史税运、安装或付款条件需核对：'+record.saleTerms.slice(0,180));
 const technicalFields=unique([...(REQUIRED[detail.category]||[]),...detail.missingFields,...record.missingFields||[]].filter(field=>!['unit','scope','spec','name','taxMode','taxRate','enterpriseId','currency'].includes(field)));
 if(detail.category==='ultrasonic'&&(parameters.transducerCount!==undefined||record.parameters?.transducerCount!==undefined))technicalFields.push('transducerCount');
 for(const field of unique(technicalFields)){
  const currentMissing=parameters[field]===undefined&&(field!=='materialGrade'||parameters.material==='SUS');
  const historyMissing=record.parameters?.[field]===undefined&&(field!=='materialGrade'||record.parameters?.material==='SUS');
  if(currentMissing)technicalMissing.push('本行'+(LABELS[field]||field)+'未记载'+(field==='transducerCount'&&record.parameters?.transducerCount!==undefined?'；历史'+record.parameters.transducerCount+'个振子范围未核':''));
  if(historyMissing)technicalMissing.push('历史'+(LABELS[field]||field)+'未记载');
 }
 if(!recordScope)warnings.push('原记录未注明供货范围；按本报价分项范围确认采用');
 if(!exactSpec)warnings.push('规格原文不同，请核对未量化的配置和包含项');
 for(const key of unique(missing).filter(key=>!['scope','spec','name','taxMode','taxRate','enterpriseId','currency','conflictingParameters'].includes(key)))warnings.push((LABELS[key]||key)+'有一方未注明');
 if(!compact(row.brand)&&record.brand||compact(row.brand)&&!record.brand)warnings.push('品牌有一方未注明');
 const pendingTechnical=!!technicalMissing.length,canAdopt=record.priceNature==='historical_quote'&&sameComponent&&!blockingDifferences.length&&!pendingTechnical&&(EQUIPMENT.has(detail.category)||exact||record.learnedCase&&exactSpec);
 const featureMatch=PF.compare(PF.features(row,detail,nameIdentity(row,detail.category)),PF.features({...record,supplyScope:record.scope},{parameters:record.parameters,category:record.category,missingFields:record.missingFields,issues:record.issues},record.nameIdentity));
 const canRecommend=!canAdopt&&sameComponent&&featureMatch.tier==='similar'&&record.priceNature==='historical_quote'&&!featureMatch.hardConflicts.length&&!blockingDifferences.some(v=>/币种|税价|税率|企业价格|参数存在冲突/.test(v));
 return {record,differences:unique(differences),missingFields:unique(missing),exact,exactSpec,sameComponent,blockingDifferences:unique(blockingDifferences),warnings:unique(warnings),technicalMissing:unique(technicalMissing),pendingTechnical,canAdopt,canRecommend,confidence:featureMatch.score,matchTier:canAdopt?'compatible':featureMatch.tier,needsConfirmation:sameComponent&&!blockingDifferences.length&&!!(warnings.length||pendingTechnical),effectiveContext:context,matchedParameters,currentParameters:parameters};
}
const compiledIndexes=new WeakSet(),categoryIndexes=new WeakMap();
function compilePriceIndex(index){const result=normalizePriceIndex(index);compiledIndexes.add(result);const groups=new Map();for(const r of Array.isArray(result)?result:result.records){if(!groups.has(r.category))groups.set(r.category,[]);groups.get(r.category).push(r);}categoryIndexes.set(result,groups);return result;}
function matchPrice(row,index,options={}){
 const detail=describeRow(row),base={price:null,priceStatus:'no_match',priceNature:'historical_quote',sourceRefs:[],reasons:[],missingFields:detail.missingFields,candidates:[],tasks:[]};
 if(detail.category==='requirement'||detail.category==='process')return {...base,priceStatus:'needs_conditions',reasons:['先把工艺要求拆为有明确规格和范围的供货项'],tasks:detail.tasks};
 const prepared=compiledIndexes.has(index)?index:normalizePriceIndex(index),records=categoryIndexes.has(prepared)?categoryIndexes.get(prepared).get(detail.category)||[]:Array.isArray(prepared)?prepared:prepared.records;
 const identity=nameIdentity(row,detail.category);
 const candidates=records.filter(r=>r.category===detail.category&&(r.nameIdentity===identity||detail.category!=='other')).map(r=>assess(row,detail,r,options)).sort((a,b)=>Number(b.record.nameIdentity===identity)-Number(a.record.nameIdentity===identity)||Number(b.canAdopt)-Number(a.canAdopt)||a.blockingDifferences.length-b.blockingDifferences.length||candidateDistance(a)-candidateDistance(b)||a.differences.length-b.differences.length||a.missingFields.length-b.missingFields.length);
 const exact=candidates.filter(c=>c.exact),allowed=exact.filter(c=>c.record.priceNature==='historical_quote');
 const summarise=c=>({id:c.record.id,name:c.record.name,spec:c.record.spec,brand:c.record.brand,unit:c.record.unit,category:c.record.category,parameters:clone(c.record.parameters||{}),price:c.record.price,priceNature:c.record.priceNature,date:c.record.date,sourceRefs:c.record.sourceRefs,differences:c.differences,missingFields:c.missingFields,blockingDifferences:c.blockingDifferences,warnings:c.warnings,technicalMissing:c.technicalMissing,pendingTechnical:c.pendingTechnical,sameComponent:c.sameComponent,exactSpec:c.exactSpec,canAdopt:c.canAdopt,canRecommend:c.canRecommend,confidence:c.confidence,matchTier:c.matchTier,needsConfirmation:c.needsConfirmation,businessContext:clone(c.record.businessContext||{}),effectiveContext:c.effectiveContext,record:clone(c.record),adoptionBasis:{sameComponent:c.sameComponent,matchedParameters:c.matchedParameters,currentParameters:clone(detail.parameters),historicalParameters:clone(c.record.parameters||{}),currentScope:c.effectiveContext.scopeText,historicalScope:c.record.scope||'',historicalBusinessContext:clone(c.record.businessContext||{})}});
 if(allowed.length){const prices=unique(allowed.map(c=>c.record.price));if(prices.length>1)return {...base,priceStatus:'conflict',reasons:['相同规格有多个不同价格，选择价格有效日期或确认采用记录'],sourceRefs:allowed.flatMap(c=>c.record.sourceRefs),missingFields:[],candidates:allowed.map(summarise),tasks:[{type:'price_conflict',title:'选择适用价格记录',action:'核对来源日期、税运安装及批量条件，再确认采用的单价'}]};const chosen=allowed[0].record;return {...base,price:prices[0],priceStatus:chosen.priceNature==='confirmed_supplier_quote'?'exact_supplier':'exact_history',priceNature:chosen.priceNature,missingFields:[],reasons:['名称、规格、关键参数、单位、品牌及已记载供货条件一致',chosen.priceNature==='historical_quote'?'采用同规格历史报价参考，保留原始来源':'对应规格的已确认供应商报价'],sourceRefs:allowed.flatMap(c=>c.record.sourceRefs),candidates:allowed.map(summarise)};}
 if(exact.length)return {...base,priceStatus:'reference_only',priceNature:exact[0].record.priceNature,missingFields:[],reasons:['该记录属于'+exact[0].record.priceNature+'，按其价格性质保留参考，不自动作为本企业售价'],sourceRefs:exact.flatMap(c=>c.record.sourceRefs),candidates:exact.map(summarise)};
 if(!candidates.length)return {...base,reasons:['价格库暂无该部件的对应记录'],tasks:[...detail.tasks,{type:'price_source',title:'补充对应规格价格',action:'查询内部部件库、供应商有效报价或同规格历史报价'}]};
 // Prefer the same supplied object over unrelated incomplete records whose
 // missing parameters happen to conceal their differences. This does not adopt it.
 const viable=candidates.filter(c=>!c.differences.length),adoptable=candidates.filter(c=>c.canAdopt),best=candidates.slice(0,5),missingFields=unique([...detail.missingFields,...best.flatMap(c=>c.missingFields)]);
 return {...base,priceStatus:viable.length?'needs_conditions':'no_match',canAdopt:!!adoptable.length,needsConfirmation:adoptable.some(c=>c.needsConfirmation),missingFields,reasons:adoptable.length?['同部件的已知关键参数无冲突，可核对提示后逐项确认采用']:viable.length?['找到候选价格，先核对规格和供货条件']:['候选价格的关键条件不同，未自动采用'],sourceRefs:best.flatMap(c=>c.record.sourceRefs),candidates:candidates.map(summarise),tasks:[...detail.tasks,...missingFields.filter(k=>!detail.missingFields.includes(k)).map(field=>({type:'price_condition',field,title:'核对'+(LABELS[field]||field),action:'对照候选原行补全或确认差异，保留本项目原始要求'})),...best.flatMap(c=>c.differences.map(reason=>({type:'price_difference',title:reason,action:'保持本项目参数，另找对应规格价格或取得变更确认'})))]};
}
const api={VERSION,load,search,describeRow,buildPriceIndex,normalizePriceIndex,compilePriceIndex,matchPrice,effectiveContext,isFinishedEquipment,priceFeatures:(row,context='')=>{const d=describeRow(row);return PF.features(row,d,nameIdentity(row,d.category),context);},getCatalog:()=>clone(catalog)};
Object.defineProperty(api,'catalog',{get:()=>clone(catalog)});
if(typeof module!=='undefined'&&module.exports){load(require('../knowledge/catalog.json'));module.exports=api;}
root.Knowledge=api;
})(typeof window!=='undefined'?window:globalThis);
