(function(root){
'use strict';
// A small, versioned calculation contract. It deliberately accepts arithmetic
// trees, never JavaScript, spreadsheet code, property access or function names.
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const A=typeof module!=='undefined'&&module.exports?require('./assembly-pricing.js'):root.QuoteAssemblyPricing;
const VERSION='2026-11-07.calculation.1',KINDS={purchase_cost:'采购成本',estimate:'估算参考',enterprise_quote:'企业报价',confirmed_sale:'确认售价'};
const SELL=new Set(['enterprise_quote','confirmed_sale']),norm=v=>String(v??'').normalize('NFKC').trim();
const num=v=>typeof v==='boolean'||v===null||v===undefined||norm(v)===''||!Number.isFinite(Number(v))?null:Number(v);
function basis(r){return JSON.stringify([norm(r.name),norm(r.spec),norm(r.unit),norm(r.brand),r.geometry||null,{chamberCount:r.bom?.chamberCount??null,stationMembers:r.bom?.stationMembers||[],supplyStatus:r.bom?.supplyStatus||''},norm(r.supplyScope??r.scope)]);}
function same(a,b){return JSON.stringify(canonical(a))===JSON.stringify(canonical(b));}
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
function rational(v){const s=String(v),m=s.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);if(!m||s.length>80)throw Error('计算参数不是有效数字');let n=BigInt(m[2]+(m[3]||''))*(m[1]?-1n:1n),d=10n**BigInt((m[3]||'').length),e=Number(m[4]||0);if(Math.abs(e)>30)throw Error('计算参数超出范围');if(e>0)n*=10n**BigInt(e);else d*=10n**BigInt(-e);return [n,d];}
const add=(a,b)=>[a[0]*b[1]+b[0]*a[1],a[1]*b[1]],sub=(a,b)=>[a[0]*b[1]-b[0]*a[1],a[1]*b[1]],mul=(a,b)=>[a[0]*b[0],a[1]*b[1]];
function div(a,b){if(!b[0])throw Error('计算分母不能为零');const s=b[0]<0n?-1n:1n;return [a[0]*b[1]*s,a[1]*b[0]*s];}
function rounded(a,scale=100n){const sign=a[0]<0n?-1n:1n,n=a[0]*sign;return [((n*scale*2n+a[1])/(2n*a[1]))*sign,scale];}
const asNumber=a=>Number(a[0])/Number(a[1]);
function compile(expression,parameters=[]){
 const source=norm(expression).replace(/×/g,'*').replace(/÷/g,'/');if(!source||source.length>2048)throw Error('请填写长度合适的计算表达式');
 const aliases=new Map();for(const p of parameters){for(const label of [p.id,p.label, String(p.label||'').replace(/[（(].*$/,'').trim()].filter(Boolean)){if(aliases.has(label)&&aliases.get(label)!==p.id)throw Error('公式参数名称重复');aliases.set(label,p.id);}}
 const tokens=[];let position=0;while(position<source.length){if(/\s/.test(source[position])){position++;continue;}const rest=source.slice(position),n=rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/),word=rest.match(/^[\p{L}_][\p{L}\p{N}_]*/u);if(n){tokens.push({type:'number',value:Number(n[0])});position+=n[0].length;}else if(word){tokens.push({type:'word',value:word[0]});position+=word[0].length;}else if('+-*/(),'.includes(source[position]))tokens.push({type:source[position++]});else throw Error('表达式含不支持的字符');if(tokens.length>256)throw Error('公式过长，请分成独立计算项');}
 let index=0;const precedence={'+':1,'-':1,'*':2,'/':2},ops={'+':'add','-':'sub','*':'mul','/':'div'},functions={min:'min',max:'max',round:'round',ceil:'ceil',最小值:'min',最大值:'max',四舍五入:'round',向上取整:'ceil'};
 function parse(minimum=0,depth=0){if(depth>16)throw Error('公式嵌套过深');let node,token=tokens[index++];if(!token)throw Error('表达式缺少计算项');if(token.type==='number')node=token.value;else if(token.type==='+'||token.type==='-'){const value=parse(3,depth+1);node=token.type==='-'?{op:'sub',args:[0,value]}:value;}else if(token.type==='('){node=parse(0,depth+1);if(tokens[index++]?.type!==')')throw Error('表达式括号不配对');}else if(token.type==='word'){
  if(tokens[index]?.type==='('){const op=functions[token.value];if(!op)throw Error('仅支持最小值、最大值、四舍五入和向上取整');index++;const args=[parse(0,depth+1)];while(tokens[index]?.type===','){index++;args.push(parse(0,depth+1));}if(tokens[index++]?.type!==')')throw Error('表达式括号不配对');node={op,args};}
  else{if(!aliases.has(token.value))throw Error('未定义参数 '+token.value);node={param:aliases.get(token.value)};}
 }else throw Error('表达式计算项无效');while(index<tokens.length&&(precedence[tokens[index].type]||0)>minimum){const operator=tokens[index++].type;node={op:ops[operator],args:[node,parse(precedence[operator],depth+1)]};}return node;}
 const compiled=parse();if(index!==tokens.length)throw Error('表达式含多余内容');return compiled;
}
function arithmetic(expression,parameters){let count=0;function run(node,depth=0){if(++count>128||depth>16)throw Error('公式过长，请分成独立计算项');if(typeof node==='number'||typeof node==='string'&&/^-?\d+(?:\.\d+)?$/.test(node))return rational(node);if(!node||typeof node!=='object'||Array.isArray(node))throw Error('公式节点无效');if(Object.keys(node).length===1&&typeof node.param==='string'){if(!Object.hasOwn(parameters,node.param))throw Error('缺少参数 '+node.param);return rational(parameters[node.param]);}const args=node.args;if(Object.keys(node).some(k=>!['op','args'].includes(k))||!Array.isArray(args)||!args.length||args.length>32)throw Error('公式运算无效');const vs=args.map(n=>run(n,depth+1));let result;
 if(node.op==='add')result=vs.reduce(add,[0n,1n]);else if(node.op==='mul')result=vs.reduce(mul,[1n,1n]);else if(node.op==='sub'&&vs.length===2)result=sub(...vs);else if(node.op==='div'&&vs.length===2)result=div(...vs);else if(['min','max'].includes(node.op))result=vs.reduce((a,b)=>(a[0]*b[1]<b[0]*a[1])===(node.op==='min')?a:b);else if(node.op==='round'&&vs.length===1)result=rounded(vs[0]);else if(node.op==='ceil'&&vs.length===1)result=[vs[0][0]/vs[0][1]+(vs[0][0]>0n&&vs[0][0]%vs[0][1]?1n:0n),1n];else throw Error('不支持的公式运算');if(result.some(n=>n.toString().length>512)||Math.abs(asNumber(result))>1e15)throw Error('计算中间值超出范围');return result;}return run(expression);}
function money(v){return asNumber(rounded(Array.isArray(v)?v:rational(v)));}
const allowedField=/^(?:quantity|geometry\.(?:length|width|height|thickness|diameter|density|chambers))$/;
function parameterValues(c,rule,row){const values={},missing=[],issues=[],seen=new Set(),definitions=rule.parameters||[];if(!Array.isArray(definitions)||definitions.length>64)throw Error('公式参数定义无效');for(const p of definitions){if(!p||!/^[_A-Za-z][_A-Za-z0-9]{0,39}$/.test(p.id)||['__proto__','constructor','prototype'].includes(p.id)||seen.has(p.id))throw Error('公式参数定义无效');seen.add(p.id);const input=c.parameters?.[p.id],bound=input&&typeof input==='object';let raw=input;if(bound){if(input.field){if(!allowedField.test(input.field))throw Error('参数绑定字段无效');raw=input.field.split('.').reduce((v,k)=>v?.[k],row);}else raw=input.value;if(input.unit!==undefined&&p.unit!==undefined&&input.unit!==p.unit)issues.push((p.label||p.id)+'单位应为 '+p.unit);}const value=num(raw);if(value===null)missing.push(p.label||p.id);else if(value<(p.min??0)||value>(p.max??1e9))issues.push((p.label||p.id)+'超出范围');else values[p.id]=value;}return {values,missing,issues};}
function blank(method,kind){return {version:VERSION,method,priceKind:kind||'enterprise_quote',basePrice:null,value:null,status:'missing',missing:[],issues:[],steps:[]};}
function evaluate(row,quote={}){
 if(row.engineeringBill){const engine=typeof module!=='undefined'&&module.exports?require('./engineering.js'):root.QuoteEngineering;return {...blank('engineering','enterprise_quote'),...engine.evaluate(row),method:'engineering',priceKind:'enterprise_quote'};}
 const c=row.calculation;if(!c)return legacy(row,quote);const out=blank(c.method,c.priceKind);
 try{
  if(c.version!==VERSION)throw Error('计价规则版本不可用');if(!Object.hasOwn(KINDS,c.priceKind))throw Error('请选择价格口径');
  let matches;try{matches=same(JSON.parse(c.basis),JSON.parse(basis(row)));}catch{matches=false;}if(!matches)return {...out,status:'stale',issues:['规格或供货范围已改变，原计价条件待重新确认']};
  if(c.confirmed!==true||!norm(c.confirmedBy))return {...out,status:'unconfirmed',issues:['此计价方法尚未确认']};
  let result;
  if(c.method==='fixed'){const n=num(c.unitPrice);if(n===null||n<0)out.missing.push('确认单价');else result=rational(n);}
  else if(c.method==='rule'){
   const candidates=(quote.calculationRules||[]).filter(r=>r.id===c.ruleId&&r.version===c.ruleVersion);
   if(candidates.length!==1)throw Error('找不到唯一的当前公式版本');const rule=candidates[0];
   if(rule.approved!==true||!norm(rule.approvedBy))throw Error('企业公式尚未由负责人确认');
   let approved;try{approved=JSON.parse(c.ruleBasis);}catch{throw Error('公式依据缺失');}
   if(!same(approved,rule))return {...out,status:'stale',issues:['公式内容或审批状态已改变，请重新确认']};
   if(rule.priceKind!==c.priceKind)throw Error('公式输出的价格口径不一致');
   const p=parameterValues(c,rule,row);out.missing=p.missing;out.issues=p.issues;
   if(!out.missing.length&&!out.issues.length){result=arithmetic(rule.expression,p.values);out.steps=Object.entries(p.values).map(([name,value])=>({name,value}));}
  }else if(c.method==='components'){
   const parts=c.components;if(!Array.isArray(parts)||!parts.length||parts.length>200)throw Error('请填写成套计价组成');let sum=[0n,1n];const kinds=new Set();
   for(const [i,p] of parts.entries()){const label=norm(p.name)||'组成'+(i+1),quantity=num(p.quantity),price=num(p.unitPrice);if(quantity===null||quantity<0)out.missing.push(label+'用量');if(price===null||price<0)out.missing.push(label+'单价');if(p.confirmed!==true||!Object.hasOwn(KINDS,p.priceKind))out.issues.push(label+'价格依据待确认');kinds.add(p.priceKind);if(quantity!==null&&price!==null&&quantity>=0&&price>=0){const value=mul(rational(quantity),rational(price));sum=add(sum,value);out.steps.push({name:label,value:money(value),priceKind:p.priceKind});}}
   if(kinds.has('purchase_cost')){
    if(kinds.size!==1)out.issues.push('采购成本与售价不能直接混加');
    const policy=c.salePolicy;
    if(SELL.has(c.priceKind)){if(policy?.confirmed!==true||!norm(policy.confirmedBy)||!['markup','margin'].includes(policy.method))out.issues.push('成本转报价需确认成本加成或毛利口径');else{const rate=num(policy.percent);if(rate===null||rate<0||rate>1000||policy.method==='margin'&&rate>=100)out.issues.push('成本报价比例无效');else sum=policy.method==='margin'?div(sum,sub([1n,1n],div(rational(rate),[100n,1n]))):mul(sum,add([1n,1n],div(rational(rate),[100n,1n])));}}
   }else if([...kinds].some(k=>!SELL.has(k))&&SELL.has(c.priceKind))out.issues.push('估算参考不能直接作为确认售价');
   if(!out.missing.length&&!out.issues.length)result=sum;
  }else throw Error('请选择适用的计价方法');
  if(result){const value=money(result);if(!Number.isFinite(value)||value<0||value>1e12)throw Error('计算结果超出有效范围');out.value=value;out.basePrice=SELL.has(c.priceKind)?value:null;out.status=out.basePrice===null?'reference':'priced';if(out.basePrice===null)out.issues.push(KINDS[c.priceKind]+'仅作参考，尚未形成确认报价');}
  else if(out.issues.length)out.status='invalid';return out;
 }catch(error){return {...out,status:'invalid',basePrice:null,issues:[error.message]};}
}
function legacy(row,quote){
 const p=row.pricing||{},kind=row.priceKind||'enterprise_quote',out=blank(p.mode||'fixed',kind);let value=num(row.basePrice);
 if(p.mode==='formula'){
  if(p.basis!==F.basis(row))return {...out,status:'stale',issues:['规格已改变，需重新计算']};
  const checked=F.resolve(row,p.rule),r=F.evaluate(p.rule,p.params||{},p.version);
  if(checked?.blocked||p.issues?.length||r.price===null)return {...out,issues:[...(checked?.blocked?checked.issues:[]),...(p.issues||[]),...(r.issues||[])],missing:r.missing||[]};value=r.price;
 }else if(p.mode==='assembly'){
  if(p.basis!==F.basis(row)||p.dependencyBasis&&p.dependencyBasis!==A.dependencyBasis(row))return {...out,status:'stale',issues:['结构或供货条件已改变，需重新计算']};
  if(p.version!==A.VERSION)return {...out,status:'invalid',issues:['组合计价版本不可用']};value=A.proposal(row,p.policy).price;
 }else if(p.mode==='linked_reference'){
  let b;try{b=JSON.parse(p.basis);}catch{return {...out,status:'stale',issues:['历史价依据缺失']};}
  if(p.confirmed!==true||p.status!=='matched'||!row.priceEvidence?.confirmed||['name','spec','unit','quantity'].some(k=>!same(b[k],row[k]))||!same(b.geometry,row.geometry||{}))return {...out,status:'stale',issues:['历史价适用条件已改变，请重新核对']};
 }
 if(value!==null&&value>=0&&value<=1e12){out.value=money(value);out.basePrice=SELL.has(kind)?out.value:null;out.status=out.basePrice===null?'reference':'priced';if(out.basePrice===null)out.issues=[(KINDS[kind]||'此价格')+'尚未确认为企业售价'];}return out;
}
function assign(row,definition,quote={}){const previous={at:new Date().toISOString(),basePrice:row.basePrice,override:row.override,pricing:structuredClone(row.pricing||null),calculation:structuredClone(row.calculation||null),priceSource:row.priceSource,priceEvidence:structuredClone(row.priceEvidence||null)};const c={...structuredClone(definition),version:VERSION,basis:basis(row)};if(c.method==='rule'){const rule=(quote.calculationRules||[]).find(r=>r.id===c.ruleId&&r.version===c.ruleVersion);c.ruleBasis=JSON.stringify(rule||null);}const probe=evaluate({...row,calculation:c},quote);if(['invalid','unconfirmed'].includes(probe.status))throw Error(probe.issues.join('；'));row.calculationHistory=[...(row.calculationHistory||[]),previous];row.calculation=c;row.pricing={mode:'calculation',version:VERSION};row.basePrice=probe.basePrice;row.override=null;row.priceSource=(KINDS[c.priceKind]||'计价')+' · '+({fixed:'确认单价',components:'成套组成',rule:'企业公式'}[c.method]||'');delete row.priceEvidence;return probe;}
function clear(row){if(row.calculation)row.calculationHistory=[...(row.calculationHistory||[]),{at:new Date().toISOString(),calculation:structuredClone(row.calculation),basePrice:row.basePrice,override:row.override}];delete row.calculation;}
function inspect(quote,computedRows){const rows=computedRows||quote.rows||[],issues=[],byId=new Map(rows.map(r=>[r.id,r])),identities=new Map();let supply=0,unpriced=0,requirements=0,unresolvedRequirements=0,included=0,pendingAdditions=0,excluded=0;
 const push=(row,code,message,field)=>issues.push({rowId:row.id||'',code,message,field:field||null});
 for(const row of rows)if(row.decomposition?.reviewState==='pending')push(row,'candidate_review','候选设备的来源或供货范围待确认','scope');
 for(const row of rows){if(row.duplicateReview?.status==='pending')push(row,'duplicate_review','多份资料可能重复描述同一设备，待确认','selected');const seen=new Set([row.id]);let parent=row.parentId||row.bom?.parentId;if(parent&&!byId.has(parent))push(row,'relationship','所属主项已不存在，请重新确定包含范围','parentId');while(parent&&byId.has(parent)){if(seen.has(parent)){push(row,'relationship_cycle','部件包含关系形成循环','parentId');break;}seen.add(parent);const current=byId.get(parent);parent=current.parentId||current.bom?.parentId;}const req=row.kind==='requirement'||row.kind==='process'||row.bom?.role==='requirement',inc=row.bom?.supplyStatus==='included'||row.decomposition?.relationship==='included';if(req){requirements++;if(!(typeof module!=='undefined'&&module.exports?require('./condition-binding.js'):root.QuoteConditionBinding).valid(row,rows)&&!(row.scopeReview?.status==='requirement_only'&&row.scopeReview.confirmedAt)){unresolvedRequirements++;push(row,'scope','待确认供货范围','scope');}continue;}if(inc){included++;const parent=row.parentId||row.bom?.parentId;if(!parent||!byId.has(parent))push(row,'included_parent','包内子项缺少有效主项','parentId');continue;}if(row.selected===false){excluded++;continue;}supply++;
  if(num(row.quantity)===null||num(row.quantity)<0)push(row,'quantity','待填数量','quantity');const p=computedRows?{status:row.priceStatus,basePrice:row.unitPrice===null?null:0,issues:row.priceIssues||[]}:evaluate(row,quote),invalid=p.status==='stale'||row.calculation&&p.status!=='priced';const unit=invalid?null:num(row.override)??p.basePrice;if(unit===null){unpriced++;push(row,p.status==='stale'?'stale_price':'price',p.issues[0]||'待补确认单价','basePrice');}
  const pending=row.pricing?.pendingInclusions||[];for(const message of pending){pendingAdditions++;push(row,'price_scope',message,'pricing');}
  const objectId=row.engineering?.objectId||row.engineeringId||row.bom?.objectId;
  if(objectId){if(identities.has(objectId))push(row,'duplicate','同一工程对象被重复计入报价','selected');else identities.set(objectId,row.id);}
 }
 for(const row of rows){if(row.selected===false||row.kind==='requirement')continue;if(row.engineeringBill){const engine=typeof module!=='undefined'&&module.exports?require('./engineering.js'):root.QuoteEngineering;for(const message of engine.evaluate(row).issues)push(row,'engineering',message,'engineeringBill');}for(const [type,s]of Object.entries(row.automaticSuggestions||{})){const value=type==='quantity'?[row.quantity,(row.bom?.stationMembers||[]).map(m=>[m.stationNumber,m.sourceRow])]:[row.name,row.spec,row.unit,row.brand||'',row.basePrice];if(s.status==='pending'&&s.basis===JSON.stringify(value))push(row,'automatic_'+type,s.message,'automaticSuggestions');}}
 return {version:VERSION,status:issues.length||!supply?'incomplete':'ready',canFinalize:!!supply&&!issues.length,selectedCount:supply,unpricedCount:unpriced,requirementCount:requirements,unresolvedRequirementCount:unresolvedRequirements,includedCount:included,excludedCount:excluded,pendingAdditionCount:pendingAdditions,duplicateCount:issues.filter(i=>['duplicate','duplicate_review'].includes(i.code)).length,issues};
}
root.QuoteCalculation={VERSION,KINDS,basis,evaluate,assign,clear,inspect,compile,arithmetic,money};if(typeof module!=='undefined')module.exports=root.QuoteCalculation;
})(typeof window!=='undefined'?window:globalThis);
