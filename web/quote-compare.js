/* Read-only comparison. Reference records never change the parsed process. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./formulas.js'):root.QuoteFormulas);if(typeof module==='object'&&module.exports)module.exports=api;else root.QuoteCompare=api;})(typeof globalThis!=='undefined'?globalThis:this,function(F){
'use strict';
const VERSION='2026-11-07.knowledge-compare.2';
const text=v=>String(v??'').normalize('NFKC').replace(/\r/g,'').trim();
const compact=v=>text(v).replace(/\s+/g,'').toUpperCase();
const num=v=>v===null||v===undefined||typeof v==='boolean'||(typeof v==='string'&&!v.trim())?null:Number.isFinite(Number(v))?Number(v):null;
const same=(a,b)=>Math.abs(a-b)<1e-6;
const parentId=r=>r.bom?.role==='shared'||r.bom?.shared?null:r.bom?.parentId||r.parentId||null;
const whole=r=>text(r.name)+'\n'+text(r.spec);
const unit=v=>({只:'个',件:'个','㎡':'平方米',M2:'平方米',平方:'平方米',平米:'平方米',米:'m',M:'m'}[compact(v)]||compact(v));
const chineseNumbers={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
function chamberCount(row){
 const g=num(row.geometry?.chambers??row.bom?.chamberCount);if(g!==null)return g;
 const m=text(row.name).match(/([一二两三四五六七八九十]|\d+)\s*连/);if(m)return chineseNumbers[m[1]]||Number(m[1]);
 const explicitMultiplier=whole(row).match(/[（(]\s*\d+(?:\.\d+)?\s*[*×]\s*(\d+)\s*[）)]/);if(explicitMultiplier)return Number(explicitMultiplier[1]);
 return ['tank','management_tank'].includes(category(row))?1:null;
}
function category(row){
 const n=text(row.name),g=text(row.group);
 if(/电气控制|电控|配电/.test(g)&&/供电|控制|接线|配电|电缆|电线/.test(n+' '+text(row.spec)))return 'line_control';
 const shell=F?.isTankBody?F.isTankBody(row):row.bom?.role==='tank'||/槽(?:体)?$/.test(n)&&!/泵|槽盖|盖板|发生器|振板|管路|配件/.test(n);
 if(shell)return /管理槽/.test(n)?'management_tank':'tank';
 const equipment=row.bom?.role&&row.bom.role!=='tank'?n+' '+text(row.supplyScope??row.scope):n;
 if(/过滤机架|过滤器架/.test(n))return 'filter_support';
 if(/过滤机|过滤器/.test(n))return 'filter';
 if(/整流|电镀电源/.test(n))return 'rectifier';
 if(/超声波系统|超声波发生|超声波振板|超声发生|发生器|换能器|振板/.test(equipment))return 'ultrasonic';
 if(/(?:冷却|制冷)/.test(n)&&/管|装置/.test(n))return 'cooling';
 if((/加温|加热装置|加热.*管|加热采用|加热用/.test(n)||/^加热$/.test(n)&&/SUS\s*\d|不锈钢|钛|加热管|电热管|\d\s*KW/i.test(text(row.spec)))&&!/空气能/.test(n))return 'heating';
 if(/循环管路|循环管道/.test(n))return 'circulation';
 if(/温度传感/.test(n))return 'temperature_sensor';
 if(/液位传感/.test(n))return 'level_sensor';
 if(/交换车/.test(n))return 'transfer_cart';
 if(/钛篮|钛蓝/.test(n))return 'anode_basket';
 if(/导电杆/.test(n))return 'anode_bar';
 if(/抽风|废气/.test(n))return 'exhaust';
 if(/空气能|热泵/.test(n))return 'heat_pump';
 if(/泵/.test(equipment))return 'pump';
 if(/隧道炉|烘干炉/.test(n))return 'oven';
 if(/机架|骨架|龙门行车|电气控制/.test(g))return /电气控制/.test(g)?'line_control':/行车/.test(g)?'gantry':'frame';
 return compact(n.split(/[，,：:（(]/)[0])||'unknown';
}
function materialValue(raw){
 const value=(text(raw).match(/进口\s*PP|SUS\s*316L?|SUS\s*304L?|PVDF|PTFE|PVC|FRP|SS41|Q235|Q355|PP[-－]?S|PPS|PP|(?:\bTI\b)|钛/i)||[])[0]?.replace(/\s+/g,'').toUpperCase().replace('钛','TI')||null;
 return value&&/^进口PP$/.test(value)?'IMPORT_PP':value==='PP-S'||value==='PP－S'?'PPS':value;
}
function scopedTank(row){return F?.parameters?F.parameters(row.spec,{scope:'tank'}):null;}
function material(row,parsed){
 const tank=['tank','management_tank'].includes(category(row)),body=parsed||(tank?scopedTank(row):null);
 return materialValue(text(row.geometry?.material)||(tank?text(row.name)+' '+text(body?.primaryText??row.spec):whole(row)));
}
const factor='(?:\\(\\s*\\d+(?:\\.\\d+)?\\s*\\*\\s*\\d+(?:\\.\\d+)?\\s*\\)|\\d+(?:\\.\\d+)?)';
const dimensionsRE=new RegExp('('+factor+'\\s*\\*\\s*'+factor+'\\s*\\*\\s*'+factor+')');
function dimensions(row,parsed){
 const g=row.geometry;if(g&&[g.length,g.width,g.height].every(v=>num(v)!==null))return {values:[num(g.length),num(g.width),num(g.height)],kind:'chamber',expression:'长'+g.length+' 宽'+g.width+' 高'+g.height};
 const tank=['tank','management_tank'].includes(category(row)),body=parsed||(tank?scopedTank(row):null);
 const raw=(text(row.name)+'\n'+text(body?.primaryText??row.spec)).replace(/[×xX＊]/g,'*'),match=raw.match(dimensionsRE),composite=match&&/[()]/.test(match[1]);
 // Parenthesized chamber expressions belong to the assembly parser. A flat
 // substring such as "3*800*1100" cannot replace "(1200*3)*800*1100".
 if(tank&&!composite&&body){
  const p=body.params;if([p.length,p.width,p.height].every(v=>num(v)!==null))return {values:[p.length,p.width,p.height],kind:'assembly',expression:body.primaryText??text(row.spec)};
  if((body.issues||[]).some(issue=>/长|宽|高/.test(issue)))return null;
 }
 if(!match)return null;
 const chunks=match[1].match(/\([^)]*\)|\d+(?:\.\d+)?/g),values=chunks?.map(c=>c.replace(/[()\s]/g,'').split('*').reduce((p,n)=>p*Number(n),1));
 if(values?.length!==3||values.some(x=>!Number.isFinite(x)))return null;
 // Unit applies to the dimension expression, never to unrelated motor or tube values.
 const tail=raw.slice((match.index||0)+match[1].length,(match.index||0)+match[1].length+16);
 let scale=/^\s*(?:cm|厘米)/i.test(tail)?10:/^\s*(?:m\b|米)/i.test(tail)?1000:1;
 return {values:values.map(x=>x*scale),kind:'assembly',expression:match[1]};
}
function specs(row){
 const s=whole(row),c=category(row),number=(re,mult=1)=>{const m=s.match(re);return m?Number(m[1])*mult:null;};
 const tank=['tank','management_tank'].includes(c),parsed=tank?scopedTank(row):null;
 const thickness=num(row.geometry?.thickness)??(parsed?num(parsed.params.thickness):number(/(?:厚度?|板厚)\s*[:：δ=]?\s*(\d+(?:\.\d+)?)/i)??number(/(\d+(?:\.\d+)?)\s*T\s*(?:PP|PPS|SUS)/i)??number(/槽体\s*(\d+(?:\.\d+)?)\s*T/i));
 const kw=number(/(\d+(?:\.\d+)?)\s*KW\b/i)??number(/(?:总)?功率\s*KW\s*[:：]\s*(\d+(?:\.\d+)?)/i),w=number(/(\d+(?:\.\d+)?)\s*W\b/i);
 return {category:c,material:material(row,parsed),dimensions:dimensions(row,parsed),thickness,chambers:chamberCount(row),layers:(parsed?.layers||[]).filter(layer=>layer.role!=='body'),parameterIssues:parsed?.issues||[],flow:number(/(\d+(?:\.\d+)?)\s*(?:T\s*\/\s*H|吨\s*\/\s*时|M[³3]\s*\/\s*H)/i),powerKw:kw??(w!==null?w/1000:null),voltage:number(/(\d+(?:\.\d+)?)\s*V\b/i),current:number(/(\d+(?:\.\d+)?)\s*A\b/i),frequencyKhz:number(/(\d+(?:\.\d+)?)\s*KHZ/i)??number(/频率\s*HZ\s*[:：]\s*(\d+(?:\.\d+)?)\s*K/i)};
}
function nameKey(row){
 let n=text(row.name).replace(/\(\s*\d[^)]*\)\s*(?:mm|cm|m)?/ig,'').replace(/飞钯/g,'飞巴').replace(/超声波/g,'超声').replace(/水洗\d+/g,'水洗').replace(/[一二两三四五六七八九十\d]+连/g,'').replace(/槽|位|管理|尺寸|\d+(?:\.\d+)?|[*×（）()\s，,、+＋：:]/g,'');
 return n;
}
function processWords(row){
 const n=nameKey(row),words=n.match(/超纯水|纯水|半光镍|光镍|镍磷|酸性|碱性|化学镍|二次沉锌|沉锌|退锌|焦铜|酸铜|氢氟酸|除垢|除油|碱蚀|超声|回收|喷淋|活化|水洗|电解|保护|钝化|飞巴|上料|下料|交换车/g);
 return words?.length?[...new Set(words)].sort():[n];
}
function lexical(a,b){
 const x=processWords(a),y=processWords(b),union=new Set([...x,...y]),intersection=x.filter(t=>y.includes(t));return union.size?intersection.length/union.size:0;
}
function score(a,b){
 if(a._category!==b._category)return -1000;
 const cat=a._category,keysame=nameKey(a)===nameKey(b),sim=lexical(a,b);
 if(['tank','management_tank','transfer_cart'].includes(cat)&&!keysame&&sim<0.5)return -1000;
 if(!['tank','management_tank','transfer_cart','filter','rectifier','ultrasonic','heating','cooling','circulation'].includes(cat)&&!keysame)return -1000;
 let result=keysame?12:7+sim*2;
 const x=a._specs,y=b._specs;
 if(x.chambers!==null&&y.chambers!==null)result+=x.chambers===y.chambers?1:-1;
 if(num(a.quantity)!==null&&num(b.quantity)!==null)result+=num(a.quantity)===num(b.quantity)?1:-0.2;
 for(const field of ['material','thickness','flow','voltage','current'])if(x[field]!==null&&y[field]!==null)result+=x[field]===y[field]?0.7:-0.5;
 if(x.dimensions&&y.dimensions){const xh=x.dimensions.values[2],yh=y.dimensions.values[2];result+=same(xh,yh)?0.5:-0.3;if(a._category==='management_tank'){const sx=x.dimensions.values.slice(0,2).sort((m,n)=>m-n),sy=y.dimensions.values.slice(0,2).sort((m,n)=>m-n);result+=sx.every((v,i)=>same(v,sy[i]))?3:0;}}
 return result;
}
function annotate(rows,isReference){
 let anchor=null,lastGroup=null;
 return rows.map((r,i)=>{
  const categoryValue=category(r),serial=(r.fields||[]).find(f=>/^(?:序号|编号)$/.test(text(f.label)))?.value;
  const v={...r,_index:i,_id:r.id||'row-'+i,_category:categoryValue,_specs:specs(r),_parent:parentId(r)};
  if(isReference&&!v._parent){
   if(r.group!==lastGroup){anchor=null;lastGroup=r.group;}
   const anchorCategory=['tank','transfer_cart'].includes(categoryValue);
   if(anchorCategory&&(serial||r.geometry||/尺寸/.test(text(r.spec))))anchor=v._id;
   else if(serial)anchor=null;
   else if(anchor&&['filter','ultrasonic','heating','cooling','circulation','anode_basket','anode_bar'].includes(categoryValue))v._parent=anchor;
  }
  return v;
 });
}
function alignOrdered(a,b){
 const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0)),actions=Array.from({length:a.length+1},()=>Array(b.length+1).fill(''));
 for(let i=1;i<=a.length;i++){dp[i][0]=-3*i;actions[i][0]='a';}for(let j=1;j<=b.length;j++){dp[0][j]=-3*j;actions[0][j]='b';}
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
  const candidates=[[dp[i-1][j-1]+score(a[i-1],b[j-1]),'m'],[dp[i-1][j]-3,'a'],[dp[i][j-1]-3,'b']];
  candidates.sort((x,y)=>y[0]-x[0]);[dp[i][j],actions[i][j]]=candidates[0];
 }
 const pairs=[];let i=a.length,j=b.length;while(i||j){const ac=actions[i][j];if(ac==='m'){pairs.push([a[i-1],b[j-1]]);i--;j--;}else if(ac==='a')i--;else j--;}
 return pairs.reverse();
}
function snapshot(row){return {index:row._index,id:row._id,name:text(row.name),spec:text(row.spec),brand:text(row.brand),quantity:num(row.quantity),unit:text(row.unit),basePrice:num(row.basePrice),override:num(row.override),kind:row.kind||'component',group:text(row.group),subgroup:text(row.subgroup),source:text(row.source),sourceRow:num(row.sourceRow),sourceRanges:row.bom?.sourceRanges||[],quantityBasis:text(row.bom?.quantityBasis),scope:text(row.scope),parentId:row._parent,parameters:row._specs};}
function compareLayers(source,reference,add){
 const labels={insulation:'保温层',outer_shell:'外封层',inner_shell:'内槽',lining:'内衬',reinforcement:'补强结构',coating:'涂层'},fieldLabels={length:'长度',width:'宽度',height:'高度',thickness:'厚度',diameter:'直径',material:'材质'};
 const group=layers=>{const result=new Map();for(const layer of layers||[]){if(!result.has(layer.role))result.set(layer.role,[]);result.get(layer.role).push(layer);}return result;};
 const a=group(source),b=group(reference);
 for(const role of new Set([...a.keys(),...b.keys()])){
  const left=a.get(role)||[],right=b.get(role)||[],label=labels[role]||'结构层';
  if(!left.length||!right.length){add('structure_'+role+'_unconfirmed','layers.'+role,left.map(v=>v.text),right.map(v=>v.text),'pending',label+'的包含范围待核对','核对原配置与参考是否包含'+label+'，保留两侧说明');continue;}
  if(left.length!==right.length)add('structure_'+role+'_count_unconfirmed','layers.'+role,left.map(v=>v.text),right.map(v=>v.text),'pending',label+'的分项范围不同','按原说明核对各层与各部件的对应关系');
  for(let index=0;index<Math.min(left.length,right.length);index++){
   const x=left[index],y=right[index],xp={...x.parameters},yp={...y.parameters};
   for(const [layer,params]of [[x,xp],[y,yp]]){
    const engineeringMaterial=materialValue(layer.text);if(engineeringMaterial)params.material=engineeringMaterial;
    if((layer.issues||[]).some(issue=>/材质|材料/.test(issue)))delete params.material;
   }
   if((x.issues||[]).length||(y.issues||[]).length)add('structure_'+role+'_conflicting','layers.'+role,x.issues,y.issues,'pending',label+'参数存在冲突','按原始结构说明核对冲突，保留不同取值');
   const required=['insulation','outer_shell','inner_shell','lining'].includes(role)?['thickness','material']:[];
   const keys=new Set([...Object.keys(xp),...Object.keys(yp),...required]);
   for(const field of keys){
    if(!fieldLabels[field])continue;const av=xp[field],bv=yp[field],knownA=av!==null&&av!==undefined&&av!=='',knownB=bv!==null&&bv!==undefined&&bv!=='';
    if(knownA&&knownB){if(typeof av==='number'&&typeof bv==='number'?same(av,bv):av===bv)continue;add('structure_'+role+'_'+field+'_changed','layers.'+role+'.'+field,av,bv,'difference',label+fieldLabels[field]+'不同','核对适用结构及项目修订依据，保留两侧原值');}
    else if(knownA||knownB||required.includes(field))add('structure_'+role+'_'+field+'_unconfirmed','layers.'+role+'.'+field,av??null,bv??null,'pending',label+fieldLabels[field]+'待核对','从结构说明或图纸补齐'+label+fieldLabels[field]+'，不由主体槽壳参数代填');
   }
   if(!keys.size&&compact(x.text)!==compact(y.text))add('structure_'+role+'_details_unconfirmed','layers.'+role,x.text,y.text,'pending',label+'说明待核对','对照两侧结构要求，确认材料、尺寸及包含范围');
  }
 }
}
function pairResult(a,b){
 const issues=[],x=a._specs,y=b._specs,add=(code,field,s,r,severity,message,nextAction)=>issues.push({code,field,sourceValue:s,referenceValue:r,severity,message,nextAction});
 const numeric=(field,av,bv,label)=>{
  if(av!==null&&bv!==null){if(!same(av,bv))add(field+'_changed',field,av,bv,'difference',label+'不同','核对项目设计修订依据，保留两侧原值');}
  else if(av===null&&bv!==null)add(field+'_unconfirmed',field,av,bv,'pending','配置拆料缺'+label,'查原配置/附件，确认'+label+'后补入项目记录');
  else if(av!==null&&bv===null)add('reference_'+field+'_missing',field,av,bv,'pending','参考报价未明确'+label,'核对技术附件，补充同口径'+label);
 };
 numeric('quantity',num(a.quantity),num(b.quantity),'数量');
 if(unit(a.unit)&&unit(b.unit)&&unit(a.unit)!==unit(b.unit))add('unit_changed','unit',a.unit,b.unit,'difference','计量单位不同','确认台、套或组分别包含什么，不按1:1换算');
 if(!unit(a.unit)&&unit(b.unit))add('unit_unconfirmed','unit',a.unit,b.unit,'pending','配置拆料缺计量单位','确认该项实际供货计量单位');
 if(a.brand&&b.brand&&compact(a.brand)!==compact(b.brand))add('brand_changed','brand',a.brand,b.brand,'difference','品牌不同','核对品牌约束和替代审批');
 for(const [field,label]of [['thickness','板厚'],['flow','过滤流量'],['voltage','输出电压'],['current','输出电流'],['frequencyKhz','超声频率']])numeric(field,x[field],y[field],label);
 // Motor power remains a separate parameter, never a basis to scale a quoted equipment price.
 if(['filter','rectifier','ultrasonic'].includes(a._category))numeric('powerKw',x.powerKw,y.powerKw,'功率(kW)');
 if(x.material&&y.material&&x.material!==y.material)add('material_changed','material',x.material,y.material,'difference','材质或牌号不同','核对主体/泵体/配件材质范围后确认，不自动替换');
 if(!x.material&&y.material&&['tank','management_tank','filter','heating','cooling'].includes(a._category))add('material_unconfirmed','material',null,y.material,'pending','配置拆料缺明确材质','查配置或确认材质牌号');
 if(['tank','management_tank'].includes(a._category)){
  if(x.parameterIssues.length||y.parameterIssues.length)add('primary_parameters_conflicting','parameters',x.parameterIssues,y.parameterIssues,'pending','主体槽壳参数存在冲突','核对主体参数作用范围，保留未解决的不同取值');
  compareLayers(x.layers,y.layers,add);
 }
 if(x.dimensions&&y.dimensions){
  const sv=x.dimensions.values,rv=y.dimensions.values,c=x.chambers||1;
  if(x.dimensions.kind==='chamber'&&c>1){
   const footprintMatches=(same(sv[0]*c,rv[0])&&same(sv[1],rv[1]))||(same(sv[1]*c,rv[0])&&same(sv[0],rv[1]));
   add('assembly_axis_unconfirmed','dimensions',x.dimensions,y.dimensions,'pending',footprintMatches?'单工位与联槽整体尺寸可按一轴展开；轴向尚未确认':'单工位与联槽整体尺寸口径不同','确认联槽组合轴向及隔板/外尺寸口径，再比较整体尺寸');
   if(!same(sv[2],rv[2]))add('dimension_changed','height',sv[2],rv[2],'difference','高度不同','核对尺寸修订依据');
   if(!footprintMatches)add('dimension_changed','footprint',sv,rv,'difference','按工位尺寸及联数展开不能对上报价尺寸','核对设计修订或尺寸口径，不能自动扩倍');
  }else{
   const equal=sv.every((v,i)=>same(v,rv[i])),rotated=same(sv[0],rv[1])&&same(sv[1],rv[0])&&same(sv[2],rv[2]);
   if(!equal&&!rotated)add('dimension_changed','dimensions',sv,rv,'difference','几何尺寸不同','核对图纸、报价修订和轴向，保留源尺寸');
   else if(rotated&&!equal)add('dimension_orientation','dimensions',sv,rv,'info','长宽顺序互换','按图纸确认长宽轴向；本比较仅记录相同矩形外形');
  }
 }else if(['tank','management_tank'].includes(a._category))add('dimensions_unconfirmed','dimensions',x.dimensions,y.dimensions,'pending','一侧缺完整尺寸','补齐两侧尺寸及单位口径');
 numeric('chambers',x.chambers,y.chambers,'联槽数');
 const pa=num(a.override)??num(a.basePrice),pb=num(b.override)??num(b.basePrice);
 if(pa!==null&&pb!==null&&!same(pa,pb))add('price_changed','price',pa,pb,'price','单价不同','对照公式/历史价与本项目范围，生成单独调价建议');
 else if(pa===null&&pb!==null)add('price_missing','price',null,pb,'price','配置拆料尚无已采用单价','检索同规格价格或按确认公式计算；本对照不自动采用参考价');
 const differences=issues.filter(r=>r.severity==='difference'),pending=issues.filter(r=>r.severity==='pending');
 return {processIndex:a._index,referenceIndex:b._index,processId:a._id,referenceId:b._id,category:a._category,status:differences.length?'参数有差异':pending.length?'条件待确认':'关键参数已对照',issues,process:snapshot(a),reference:snapshot(b),priceEvidence:{processPrice:pa,processSource:a.priceSource||a.pricing?.mode||'',referencePrice:pb,referenceSource:b.priceSource||'原表报价',referencePriceKind:'历史报价',applied:false,reason:'用于对照，未作为工艺解析或自动覆盖的输入'}};
}
function compareRows(processRows,referenceRows,options={}){
 if(!Array.isArray(processRows)||!Array.isArray(referenceRows))throw new TypeError('compareRows requires processRows and referenceRows arrays');
 const p=annotate(processRows,false),q=annotate(referenceRows,true),supplies=p.filter(r=>r.kind!=='requirement'),refs=q.filter(r=>r.kind!=='requirement'),usedP=new Set(),usedQ=new Set(),matches=[];
 const take=(a,b)=>{if(usedP.has(a._index)||usedQ.has(b._index))throw new Error('comparison attempted duplicate row consumption');usedP.add(a._index);usedQ.add(b._index);matches.push([a,b]);};
 const rootTanks=supplies.filter(r=>r._category==='tank'&&!r._parent&&!r.bom?.shared),refTanks=refs.filter(r=>r._category==='tank'&&!r._parent);
 for(const [a,b]of alignOrdered(rootTanks,refTanks))take(a,b);
 const parentMap=new Map(matches.map(([a,b])=>[a._id,b._id]));
 // Child records are compared only inside their independently matched parent scope.
 for(const a of supplies.filter(r=>r._parent&&!usedP.has(r._index))){
  const targetParent=parentMap.get(a._parent);if(!targetParent)continue;
  const candidates=refs.filter(b=>!usedQ.has(b._index)&&b._parent===targetParent).map(b=>({b,value:score(a,b)})).filter(t=>t.value>0).sort((x,y)=>y.value-x.value||x.b._index-y.b._index);
  if(candidates.length)take(a,candidates[0].b);
 }
 // Independently shared equipment is not restricted by its first source station's parent ID.
 for(const a of supplies.filter(r=>!r._parent&&!usedP.has(r._index)&&!(r._category==='tank'&&!r.bom?.shared))){
  const related=new Set((a.bom?.relatedParentIds||[]).map(id=>parentMap.get(id)).filter(Boolean));
  const candidates=refs.filter(b=>!usedQ.has(b._index)&&(!b._parent||related.has(b._parent))).map(b=>({b,value:score(a,b)+(related.has(b._parent)?20:0)})).filter(t=>t.value>0&&a._category===t.b._category).sort((x,y)=>y.value-x.value||x.b._index-y.b._index);
  if(candidates.length)take(a,candidates[0].b);
 }
 const pairs=matches.map(([a,b])=>pairResult(a,b)).sort((a,b)=>a.processIndex-b.processIndex);
 const processOnly=supplies.filter(r=>!usedP.has(r._index)).map(r=>({row:snapshot(r),status:'配置已拆出，参考报价无已建立对应',nextAction:r._parent?'核对该配套是否被包入主项、移到整线系统或在参考报价遗漏':'查报价命名/供货范围；保留源项，不自动删除'}));
 const referenceOnly=refs.filter(r=>!usedQ.has(r._index)).map(r=>({row:snapshot(r),status:'参考报价有项目，工艺拆料尚未覆盖',category:['gantry','frame','line_control'].includes(r._category)?'整线设计未覆盖':'未建立拆料对应',nextAction:['gantry','frame','line_control'].includes(r._category)?'查布置、节拍、结构及控制方案，取得选型/工程量依据':'查工艺要求和供货范围，确认是新增设计、包含项还是拆料缺项'}));
 const requirements=p.filter(r=>r.kind==='requirement').map(r=>({row:snapshot(r),status:'工艺要求，未转成独立供货',nextAction:'核对所属设备或整线系统是否包含；仅在数量、规格和供货范围确认后转供货行'}));
 const count=predicate=>pairs.filter(predicate).length,summary={processSupplyRows:supplies.length,referenceRows:refs.length,pairedRows:pairs.length,consistentRows:count(p=>p.status==='关键参数已对照'),specificationDifferences:count(p=>p.issues.some(i=>i.severity==='difference'&&!['quantity','unit'].includes(i.field))),quantityDifferences:count(p=>p.issues.some(i=>i.code==='quantity_changed')),unitDifferences:count(p=>p.issues.some(i=>i.code==='unit_changed')),pendingConditions:count(p=>p.issues.some(i=>i.severity==='pending')),priceDifferences:count(p=>p.issues.some(i=>i.code==='price_changed')),missingPriceRows:supplies.filter(r=>(num(r.override)??num(r.basePrice))===null).length,processOnlyRows:processOnly.length,referenceOnlyRows:referenceOnly.length,requirements:requirements.length};
 return {version:VERSION,mode:'independent-benchmark',summary,pairs,processOnly,referenceOnly,requirements,method:{pairing:'主槽按工艺顺序作序列匹配；子件限定已匹配父项；共享设备优先对照已映射服务工位，独立整线设备另比；每侧记录只占用一次',counts:'pairedRows仅表示建立对应候选，不等于规格正确率或报价完整率',comparedFields:['名称/类别','数量','计量单位','父项范围','主体材质/尺寸/板厚','保温/外封/内衬的材料、厚度与包含范围','联槽数','过滤流量','电压/电流','功率','频率','单价及来源'],pricePolicy:'参考报价仅用于差异与价格证据；本函数不修改任何一侧记录',scope:'只比较传入的报价行，未读取其他工作表'},metadata:options.metadata||{}};
}
return {VERSION,compareRows,category,specs,dimensions};
});
