(function(root){
'use strict';
// C01/C02: client-confirmed final rules, 2026-10-08. Weight rules M01/M06–M10
// only produce a selling price when the user supplies a selling rate per kg.
const VERSION='2026-10-08.v1';
const RULES={tank:{label:'标准开口矩形槽',keys:['length','width','height','thickness','material']},plate:{label:'矩形板材按重量计价',keys:['length','width','thickness','density','rate']},bar:{label:'铜排 / 扁条按重量计价',keys:['length','width','thickness','density','rate']},shaft:{label:'圆棒 / 轴按重量计价',keys:['length','diameter','density','rate']},tube:{label:'圆管按重量计价',keys:['length','diameter','thickness','density','rate']},hollow:{label:'矩形管按重量计价',keys:['length','width','height','thickness','density','rate']},section:{label:'型材按米重计价',keys:['length','kgPerM','rate']}};
const LABELS={length:'长（mm）',width:'宽（mm）',height:'高（mm）',thickness:'壁厚 / 板厚（mm）',diameter:'外径（mm）',material:'材质',density:'密度（kg/m³）',rate:'每公斤报价（元/kg）',kgPerM:'米重（kg/m）'};
const MATERIALS={PP:{label:'PP / PPS',density:.92,rate:13.5},IMPORT_PP:{label:'进口 PP',density:.92,rate:25},SUS304:{label:'SUS304',density:7.96,rate:20},SUS316:{label:'SUS316',density:7.96,rate:20}};
const SPECIAL=/油水分离|水浴.*(?:内槽|内胆)|加热内槽|保温|岩棉|外封|外覆|外包|涂层|喷涂|喷塑|涂覆|上涂|夹套|内衬|钢衬|SS41|Q235|双层|内外槽|外槽|连槽|联槽|(?:二|两|三|四|五|六|七|八|九|十|\d+)[联连]|隔板|圆形|圆筒|槽盖|封闭结构|异形/i;
const norm=v=>String(v??'').normalize('NFKC').trim();
const parameterText=v=>norm(v).replace(/\b(SUS\s*(?:304|316)L?|(?:进口\s*)?(?:PP-S|PPS|PP|PVDF|PTFE|PVC|FRP))(?=\d+(?:\.\d+)?\s*(?:T(?![A-Za-z0-9/])|MM(?![A-Za-z0-9/])))/gi,'$1 ');
const num=v=>v!==''&&v!==null&&v!==undefined&&Number.isFinite(Number(v))?Number(v):null;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const basis=r=>JSON.stringify([norm(r.name),norm(r.spec),norm(r.unit),norm(r.brand)]);
const factor=u=>/^(?:m|米)$/i.test(u||'')?1000:/^(?:cm|厘米)$/i.test(u||'')?10:1;
function flatParameters(spec,options={}){
 const s=parameterText(spec).replace(/承重\s*\d+(?:\.\d+)?\s*T/gi,''),p={},issues=[],n='(-?\\d+(?:\\.\\d+)?)',u='(mm|毫米|cm|厘米|m|米)?',sets={};
 function put(k,v){(sets[k]??=[]).push(v);}
 const labelled=[];
 for(const [k,word]of Object.entries({length:'长(?:度)?|(?<![/])\\bL',width:'宽(?:度)?|(?<![/])\\bW',height:'高(?:度)?|(?<![/])\\bH',thickness:'板厚|壁厚|厚度|厚|(?<![/])\\bT',diameter:'外径|直径|[ΦφØ]'})){
  const re=new RegExp('(?:'+word+')\\s*(?:\\(内\\))?\\s*(?:\\((mm|毫米|cm|厘米|m|米)\\)|(mm|毫米|cm|厘米|m|米))?\\s*[:=]?\\s*'+n+'\\s*'+u,'gi');
  for(const m of s.matchAll(re))labelled.push({key:k,value:Number(m[3]),unit:m[4]||m[1]||m[2]});
 }
 const dimensionalUnits=labelled.filter(x=>['length','width','height'].includes(x.key)&&x.unit).map(x=>x.unit),common=dimensionalUnits.length?dimensionalUnits[dimensionalUnits.length-1]:'';
 for(const v of labelled)put(v.key,v.value*factor(v.unit||(['length','width','height'].includes(v.key)?common:'')));
 const triples=options.triples===false?[]:[...s.matchAll(new RegExp(n+'\\s*'+u+'\\s*[×x*]\\s*'+n+'\\s*'+u+'\\s*[×x*]\\s*'+n+'\\s*'+u+'(?:\\s*[×x*]\\s*'+n+'\\s*(?:mm|毫米|T))?','gi'))];
 for(const t of triples){const shared=t[6]||t[4]||t[2];['length','width','height'].forEach((k,i)=>put(k,Number(t[i*2+1])*factor(t[i*2+2]||shared)));if(t[7])put('thickness',Number(t[7]));}
 const thick=[...s.matchAll(new RegExp(n+'\\s*T(?![A-Za-z0-9/])','gi'))];for(const t of thick)put('thickness',Number(t[1]));
 for(const [k,label]of Object.entries({density:'密度(?:\\s*\\(kg/m[³3]\\))?',rate:'每公斤报价|每千克报价',kgPerM:'米重|每米重量'}))for(const m of s.matchAll(new RegExp('(?:'+label+')\\s*[:=]?\\s*'+n,'gi')))put(k,Number(m[1]));
 const materials=[...s.matchAll(/(?<![A-Z])(?:进口\s*PP|SUS\s*304L?|SUS\s*316L?|PP\s*-?\s*S|PPS?|PVDF|PTFE|PVC|FRP|TI)(?![A-Z])/gi)].map(m=>/进口/.test(m[0])?'IMPORT_PP':/304L/i.test(m[0])?'SUS304L':/316L/i.test(m[0])?'SUS316L':/304/.test(m[0])?'SUS304':/316/.test(m[0])?'SUS316':/^PP(?:\s*-?\s*S)?$/i.test(m[0])?'PP':m[0].toUpperCase());
 if(materials.length)sets.material=materials;
 for(const [k,values]of Object.entries(sets)){const distinct=[...new Set(values)];if(distinct.length===1)p[k]=distinct[0];else issues.push(LABELS[k]+'有多个值，请确认');}
 return {params:p,issues};
}
function tankParameters(spec,options={}){
 const raw=norm(spec),segments=[];let previous='body';
 const primary=/(?:主体|主槽|槽体)(?!保温)/,secondary=/外封|外包|外覆|内衬|夹套|内胆|内槽|外槽|保温/;
 const pieces=[];
 for(const match of raw.matchAll(/[^\n;；,，]+/g)){
  const value=match[0],a=value.search(primary),b=value.search(secondary);
  if(a>=0&&b>=0&&a!==b){const cut=Math.max(a,b);pieces.push({text:value.slice(0,cut),start:match.index},{text:value.slice(cut),start:match.index+cut});}
  else pieces.push({text:value,start:match.index});
 }
 for(const piece of pieces){
  const text=piece.text.trim();if(!text)continue;
  let role='body';
  if(/内衬|夹套|钢衬/.test(text))role='lining';
  else if(/内槽|内胆/.test(text))role='inner_shell';
  else if(/外槽|外封|外覆/.test(text))role='outer_shell';
  else if(/保温|岩棉|玻璃棉|聚氨酯|硅酸铝|橡塑/.test(text))role='insulation';
  else if(/外包/.test(text))role='outer_shell';
  else if(previous==='insulation'&&/再用|再以/.test(text)&&/板|固定/.test(text))role='outer_shell';
  else if(/方通|方管|角钢|槽钢|工字钢|加强筋|补强/.test(text))role='reinforcement';
  else if(/防腐|涂层|喷涂|喷塑|涂覆|上涂/.test(text))role='coating';
  const parsed=flatParameters(text,{...options,scope:undefined}),params={...parsed.params};
  const measures=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|T)(?![A-Za-z])/gi)];
  if(params.thickness===undefined&&measures.length===1&&!/长|宽|高|[×x*]/i.test(text)&&(role!=='body'||primary.test(text)))params.thickness=Number(measures[0][1])*factor(/^T$/i.test(measures[0][2])?'mm':measures[0][2]);
  const insulationMaterial=text.match(/岩棉|玻璃棉|聚氨酯|硅酸铝|橡塑|珍珠棉/);if(role==='insulation'&&insulationMaterial)params.material=insulationMaterial[0];
  segments.push({role,text,start:piece.start,end:piece.start+piece.text.length,parameters:params,issues:parsed.issues});previous=role;
 }
 const primaryText=segments.filter(s=>s.role==='body').map(s=>s.text).join('\n'),parsed=flatParameters(primaryText,{...options,scope:undefined});
 const bodyThickness=[...new Set(segments.filter(s=>s.role==='body'&&s.parameters.thickness!==undefined).map(s=>s.parameters.thickness))];
 if(bodyThickness.length===1&&parsed.params.thickness===undefined&&!parsed.issues.some(x=>x.startsWith(LABELS.thickness)))parsed.params.thickness=bodyThickness[0];
 else if(bodyThickness.length>1&&!parsed.issues.some(x=>x.startsWith(LABELS.thickness))){delete parsed.params.thickness;parsed.issues.push(LABELS.thickness+'有多个值，请确认');}
 return {...parsed,primaryText,layers:segments,hasScopedLayers:segments.some(s=>s.role!=='body')};
}
function parameters(spec,options={}){return options.scope==='tank'?tankParameters(spec,options):flatParameters(spec,options);}
function isTankBody(row){
 const name=norm(row.name),n=name.replace(/\s*[（(][^()（）]*[)）]\s*(?:mm|cm|m)?\s*$/i,'').replace(/\s*(?:第)?\d+\s*(?:号|#)?$/,'');
 if(row.kind==='requirement'||row.kind==='process'||row.bom?.role==='requirement')return false;
 if(/不含槽体/.test(norm(row.supplyScope??row.scope))&&row.bom?.role!=='tank')return false;
 if(/泵|风机|滚筒|配件|排水管|洗涤塔|槽盖|盖板|发生器|振板|振子|传感器|接头|管路|管道|支架|机架|钛篮|钛蓝|导电杆|槽外/.test(n))return false;
 if(row.bom?.role==='tank'||/槽(?:体)?$/.test(n))return true;
 const processName=n.replace(/(?:[一二两三四五六七八九十]+|\d+)[联连]/g,'').replace(/槽|位/g,'');
 const process=/^(?:超声波?|水洗|活化|沉锌|退锌|除油|碱蚀|镍磷|半光镍|光镍|酸性|碱性|化学|镀|镍|焦铜|酸铜|电解|保护|钝化|飞巴清洗|回收|[、，,+＋/\s\d])+$/;
 return process.test(processName)&&(/尺寸|\d\s*[*×x]\s*\d/i.test(row.spec||'')||row.unit==='个'||row.geometry&&['length','width','height'].every(k=>num(row.geometry[k])!==null));
}
function candidate(row){
 const s=norm(row.name)+' '+norm(row.spec);
 if(row.kind==='process'||row.kind==='requirement'||row.bom?.role==='requirement'||row.formulaBlocked)return null;
 if(row.kind!=='component'&&(row.fields||[]).some(f=>/^(?:工艺|工艺名称|工序名称|流程)$/.test(norm(f.label))))return null;
 if(isTankBody(row))return !row.bom||['tank','component'].includes(row.bom.role)?'tank':null;
 if(/铜排|铜母排|扁条|扁钢/.test(row.name))return 'bar';
 if(/圆管/.test(row.name))return 'tube';if(/方管|矩形管|方通/.test(row.name))return 'hollow';
 if(/圆棒|圆钢|传动轴|圆轴/.test(row.name))return 'shaft';if(/板材|钢板|铜板/.test(row.name))return 'plate';
 if(/型钢|槽钢|角钢|工字钢/.test(row.name))return 'section';
 return null;
}
function evaluate(rule,params,version=VERSION){
 const missing=[],issues=[],p={...params},def=RULES[rule];
 if(!def||version!==VERSION)return {price:null,missing,issues:['此公式版本不可用，请重新选择公式'],steps:[]};
 for(const k of def.keys){const v=k==='material'?p[k]:num(p[k]);if(v===null||v===undefined||v==='')missing.push(k);else if(k==='material'&&!MATERIALS[v])issues.push('材质不在标准槽公式范围');else if(k!=='material'&&((k==='rate'?v<0:v<=0)||v>1e8))issues.push(LABELS[k]+'超出有效范围');else p[k]=v;}
 if(missing.length||issues.length)return {price:null,missing,issues,steps:[]};
 let price,mass,steps=[];
 if(rule==='tank'){
  const {length:L,width:W,height:H,thickness:T}=p,m=MATERIALS[p.material],ceil=x=>Math.ceil(x/100-1e-12)*100;
  if(T>=Math.min(L,W,H)/2)return {price:null,missing:[],issues:['板厚与槽体尺寸不相符'],steps:[]};
  const plates=[ceil(L*W*m.density*T/1e6*m.rate),ceil(2*L*H*m.density*T/1e6*m.rate),ceil(2*W*H*m.density*T/1e6*m.rate)];
  const plateCost=plates.reduce((a,b)=>a+b,0),surface=(H+W+H)/100+(L+H+H)/100*(L+H+H>500?2:1),tube=surface*100/6,wrap=surface*15*2*1.3;
  price=round(plateCost+tube+wrap+500);steps=[['底板（进百）',plates[0]],['两长边（进百）',plates[1]],['两短边（进百）',plates[2]],['方通',round(tube)],['包槽 ×2×1.3',round(wrap)],['排水费',500]];
 }else{
  const {length:L,width:W,height:H,thickness:T,diameter:D,density:rho,rate:R}=p;
  if(['tube','hollow'].includes(rule)&&2*T>=Math.min(...(rule==='tube'?[D]:[W,H])))return {price:null,missing:[],issues:['壁厚必须小于外径 / 边长的一半'],steps:[]};
  if(rule==='plate'||rule==='bar')mass=L*W*T*rho/1e9;
  if(rule==='shaft')mass=Math.PI/4*D*D*L*rho/1e9;
  if(rule==='tube')mass=Math.PI/4*(D*D-(D-2*T)**2)*L*rho/1e9;
  if(rule==='hollow')mass=(W*H-(W-2*T)*(H-2*T))*L*rho/1e9;
  if(rule==='section')mass=L/1000*p.kgPerM;
  price=round(mass*R);steps=[['单件重量（kg）',Math.round(mass*1e6)/1e6],['每公斤报价',R]];
 }
 if(!Number.isFinite(price)||price>1e12)return {price:null,missing:[],issues:['计算结果超出有效范围'],steps:[]};
 return {price,missing,issues,steps,ruleId:rule==='tank'?(p.material.startsWith('SUS')?'C02_SUS304_TANK_STANDARD':'C01_PPS_TANK_STANDARD'):'M_WEIGHT_'+rule.toUpperCase()};
}
function resolve(row,forceRule){
 const old=row.pricing,rule=forceRule||old?.rule||candidate(row);
 if(!rule)return null;
 const parsed=parameters(row.spec,{triples:rule==='tank',scope:rule==='tank'?'tank':undefined});
 if(rule!=='tank'&&MATERIALS[parsed.params.material]&&!parsed.params.density)parsed.params.density=MATERIALS[parsed.params.material].density*1000;
 const supplied=old?.mode==='formula'?old.supplied||{}:{},p={...parsed.params,...supplied};
 const version=old?.mode==='formula'?old.version:VERSION;
 const result=evaluate(rule,p,version),issues=[...parsed.issues.filter(msg=>!Object.keys(supplied).some(k=>msg.startsWith(LABELS[k]))),...result.issues];
 let blocked=false;const block=message=>{blocked=true;issues.unshift(message);};
 if(row.formulaBlocked)block(row.geometry?.dimensionIssue||row.warning||'原表参数或供货范围需核对');
 if(rule==='tank'&&(SPECIAL.test(row.name+' '+row.spec)||row.unit==='项'))block('特殊结构 / 整套范围，标准槽体公式不适用');
 if(rule==='tank'&&(Number(row.bom?.chamberCount)>1||Number(row.geometry?.chambers)>1))block('联槽结构需单独核价');
 if(rule==='tank'&&row.bom&&row.bom.role!=='tank'&&row.bom.role!=='component')block('配套设备不能套用槽体公式');
 if(row.kind==='requirement')block('供货范围待确认');
 if(rule==='tank'&&/泵|风机|滚筒|配件|排水管|洗涤塔/.test(row.name))block('此部件不在标准槽体公式范围');
 if(row.unit&&/^(?:kg|KG|公斤|千克|吨|t|m|米|m2|m²|平方米|组|批|项)$/.test(norm(row.unit)))block('此公式计算单件价格，请确认计价单位');
 if(row.kind==='process')block('工艺配套须先拆为明确部件');
 if(issues.length)result.price=null;
 return {mode:'formula',rule,version,supplied,params:p,basis:basis(row),...result,issues,blocked};
}
function apply(row,{force=false,rule}={}){
 if(!force&&row.pricing?.mode==='manual')return row;
 if(!force&&row.pricing?.mode!=='formula'&&num(row.basePrice)!==null)return row;
 const resolved=resolve(row,rule);if(!resolved)return row;
 row.pricing=resolved;row.basePrice=resolved.price;row.priceSource=resolved.price===null?(resolved.blocked?'需确认单价':'公式待补条件'):'公式 · '+RULES[resolved.rule].label;
 return row;
}
function edit(row,key,value){
 if(['spec','name','unit','brand','scope','supplyScope'].includes(key)&&norm(row[key])!==norm(value)){
  delete row.historyReuseBasis;delete row.automaticSuggestions?.price;
  if(num(row.basePrice)!==null)row.referencePrice=row.basePrice;
  row.basePrice=null;row.override=null;row.priceSource='规格已变更，重新核价';
  if(row.pricing?.mode==='formula'&&!(key==='name'&&candidate({...row,name:value})!==row.pricing.rule)){
   const oldMaterial=parameters(row.spec).params.material,newMaterial=key==='spec'?parameters(value).params.material:oldMaterial;
   const keep=key==='spec'&&oldMaterial===newMaterial?Object.fromEntries(Object.entries(row.pricing.supplied||{}).filter(([k])=>['density','rate','kgPerM'].includes(k))):{};
   row.pricing={mode:'formula',rule:row.pricing.rule,version:VERSION,supplied:keep};
  }else delete row.pricing;
 }
 row[key]=value;
 if(key==='basePrice'){delete row.historyReuseBasis;delete row.automaticSuggestions?.price;if(num(value)===null){delete row.pricing;row.priceSource='';}else{row.pricing={mode:'manual'};row.priceSource='人工确认';}row.override=null;}
 return apply(row);
}
function pending(row){const p=row.pricing;if(p?.mode!=='formula')return row.kind==='process'?'工艺配套待确认':num(row.basePrice)===null?'无适用公式，请填确认单价':'';if(p.issues.length)return p.issues.join('；');return p.missing.length?'缺 '+p.missing.map(k=>LABELS[k]).join('、'):'';}
// Explain the current pricing boundary without widening a formula's scope or
// inventing technical parameters for a special structure.
function explain(row){
 const p=row.pricing,scopeIssues=[],fields=[];
 const add=(code,title,action)=>scopeIssues.push({code,title,action});
 if(row.kind==='requirement'||row.kind==='process'||row.bom?.role==='requirement')return {status:'requirement',title:'供货范围待确认',action:'核对这条工艺要求由哪些部件承担，以及是否已包含在现有供货项。',fields:['对应供货项及包含范围'],scopeIssues};
 if(num(row.override??row.basePrice)!==null)return {status:'priced',title:num(row.override)!==null?'已采用本次人工细调单价':p?.mode==='formula'?'已按公式计价':'已有确认单价',action:'',fields,scopeIssues};
 if(p?.mode==='assembly'&&p.price===null&&p.stations?.some(s=>s.missing?.length)){const missing=[...new Set(p.stations.flatMap(s=>s.missing||[]))].map(k=>LABELS[k]||k);return {status:'unpriced',title:'槽体主体缺 '+missing.join('、'),action:'补齐这些主体参数后自动计算；保温、外包及其他配套另行填写，不阻止主体计价。',fields:missing,scopeIssues};}
 const rule=p?.mode==='formula'?p.rule:candidate({...row,formulaBlocked:false}),text=norm(row.name)+' '+norm(row.spec);
 const resolved=rule?resolve(row,rule):null;
 if(rule==='tank'){
  if(/保温|岩棉/.test(text))add('insulation','含保温结构，待对应报价依据','核对保温材料、厚度、外封结构及供货包含范围，采用对应结构的报价依据。');
  else if(/外封|外覆|外包/.test(text))add('outer_shell','含独立外封结构，待对应报价依据','核对外封材料、厚度及包含范围，采用对应分层结构的报价依据。');
  if(/涂层|喷涂|喷塑|涂覆|上涂/.test(text))add('coating','含涂层加工，待对应报价依据','核对涂层材料、工艺、面积及包含范围，采用对应加工的报价依据。');
  if(Number(row.bom?.chamberCount)>1||Number(row.geometry?.chambers)>1||/连槽|联槽|(?:二|两|三|四|五|六|七|八|九|十|\d+)[联连]/.test(text))add('linked','联槽结构，待整体计价依据','核对联槽隔板、组合尺寸和计价范围，采用对应联槽结构报价。');
  if(/水浴.*(?:内槽|内胆)|加热内槽|夹套|内衬|钢衬|SS41|Q235|双层|内外槽|外槽/.test(text))add('lining','含内外槽或内衬结构，待分层报价依据','分别核对主体、内衬或外槽的材料与厚度，以及加工和供货范围。');
  if(/槽盖|封闭结构/.test(text))add('cover','含槽盖或封闭结构，待包含范围及报价依据','核对槽盖、密封和相关结构是否包含，采用相应部件或整套报价依据。');
  if(/油水分离/.test(text))add('separator','油水分离结构，待对应规格报价依据','核对分离结构与供货规格；固定参考价仅用于已确认的相同条件。');
  if(/隔板|圆形|圆筒|异形/.test(text))add('shape','特殊形状或隔板，待结构报价依据','核对形状、隔板和加工图，采用对应结构的计价依据。');
 }
 if(row.formulaBlocked)add('source','原表结构或参数需核对',row.geometry?.dimensionIssue||row.geometry?.structureIssue||row.warning||row.geometryIssue||'核对原表各处参数及供货范围，保留原始位置与值。');
 if(resolved?.issues.some(issue=>issue==='材质不在标准槽公式范围'))add('material','已识别材质 '+resolved.params.material+'，待适用计价依据','保留原材质牌号，核对适用的企业公式或对应规格报价。');
 if(resolved?.blocked||scopeIssues.length){
  if(!scopeIssues.length)add('scope','计价范围或单位需核对',resolved.issues.join('；'));
  return {status:'blocked',title:scopeIssues[0].title,action:scopeIssues.map(s=>s.action).join(' '),fields:['适用结构的计价依据'],scopeIssues};
 }
 if(resolved&&resolved.price===null){
  fields.push(...resolved.missing.map(k=>LABELS[k]||k));
  return {status:'missing',title:fields.length?'待补 '+fields.join('、'):'计算参数需核对',action:resolved.issues.length?resolved.issues.join('；'):'补齐列出的计算条件后，自动重新核算。',fields,scopeIssues};
 }
 if(resolved?.price!==null&&resolved?.price!==undefined)return {status:'ready',title:'计算参数已齐',action:'使用已确认的公式计算基础单价。',fields,scopeIssues};
 return {status:'unpriced',title:'待同规格价格依据',action:'核对历史报价或供应商资料中的规格、单位及供货包含范围，再确认本项单价。',fields:['适用规格的价格依据'],scopeIssues};
}
// Keep the complete process requirement as an unresolved companion; a tank
// calculation never silently becomes a quote for its pumps, heaters or controls.
function splitProcess(q){
 const out=[];
 for(const row of q.rows){
  if(row.kind!=='process'){out.push(row);continue;}
  const fields=(row.fields||[]).filter(f=>/槽体|内槽|内净尺寸/.test(f.label)&&!/管理槽|加药斗/.test(f.label.replace(/^.*?\//,''))||/\/ 主槽 \//.test(f.label));
  const primary=fields.filter(f=>!/容积|工位|液位/.test(f.label));
  const spec=primary.map(f=>f.label+'：'+f.value).join('\n'),p=parameters(spec).params;
  if(!p.length||!p.width||!p.height){out.push(row);continue;}
  const structural=(row.fields||[]).filter(f=>/保温|外槽|内衬|隔板|槽盖/.test(f.label)&&!/^无|^\/$|^否$|^×$/.test(f.value));
  const tank={...row,id:row.id+'-tank',name:row.name+' · 槽体',spec:spec+(structural.length?'\n'+structural.map(f=>f.label+'：'+f.value).join('\n'):''),kind:'component',unit:'个',quantity:null,group:row.name,scope:'槽体本身；工艺配套另列',fields:primary,basePrice:null,override:null,parentId:row.id};
  out.push(tank,{...row,name:row.name+' · 工艺配套',scope:'不含已单列槽体；须确认泵、加热、过滤等配套',group:row.name});
 }
 q.rows=out;return q;
}
root.QuoteFormulas={parameterText,VERSION,RULES,LABELS,MATERIALS,parameters,tankParameters,isTankBody,candidate,evaluate,resolve,apply,edit,pending,explain,basis,splitProcess};
if(typeof module!=='undefined')module.exports=root.QuoteFormulas;
})(typeof window!=='undefined'?window:globalThis);
