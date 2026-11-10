(function(root){
'use strict';
const F=typeof module!=='undefined'&&module.exports?require('./formulas.js'):root.QuoteFormulas;
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null,round=n=>Math.round((n+Number.EPSILON)*100)/100;
function evaluate(row){
 const bill=row.engineeringBill||{},p={...row.geometry,...F.parameters(row.spec).params},steps=[],issues=[];let sum=0,ready=0;
 for(const [i,item]of (bill.items||[]).entries()){
  const label=item.name||'组成'+(i+1),get=key=>number(item.bindings?.[key]?p[item.bindings[key]]:item[key]),count=get('count'),rate=get('rate');let quantity=null,unit='件';
  if(item.method==='plate'){const L=get('length'),W=get('width'),T=get('thickness'),rho=get('density');if([L,W,T,rho,count].every(n=>n!==null))quantity=L*W*T*rho/1e9*count;unit='kg';}
  if(item.method==='section'||item.method==='pipe'){const L=get('length'),kg=get('kgPerM');if([L,kg,count].every(n=>n!==null))quantity=L/1000*kg*count;unit='kg';}
  if(item.method==='area'){const L=get('length'),W=get('width');if([L,W,count].every(n=>n!==null))quantity=L*W/1e6*count;unit='㎡';}
  if(item.method==='unit'||item.method==='labour'){quantity=count;unit=item.method==='labour'?'小时':item.unit||'件';}
  const loss=number(item.loss??0);if(loss===null||loss>100)issues.push(label+'损耗比例无效');
  let amount=null;if(quantity!==null&&rate!==null&&loss!==null&&loss<=100){quantity*=1+loss/100;amount=round(quantity*rate);sum=round(sum+amount);ready++;}else issues.push(label+'缺'+(quantity===null?'工程量条件':'')+(quantity===null&&rate===null?'及':'')+(rate===null?'单价依据':''));
  steps.push({name:label,method:item.method,quantity:quantity===null?null:Math.round(quantity*1e6)/1e6,unit,rate,amount,source:item.source||''});
 }
 if(!steps.length)issues.push('尚未填写工程组成');
 const policy=bill.salePolicy||{},percent=number(policy.percent??0);let price=ready?sum:null;
 if(!['purchase_cost','enterprise_quote'].includes(bill.priceKind))issues.push('请选择工程组成的价格口径');
 if(bill.priceKind==='purchase_cost'){
  if(percent===null||percent>1000||policy.method==='margin'&&percent>=100){price=null;issues.push('成本转售价比例无效');}
  else price=price===null?null:round(policy.method==='margin'?sum/(1-percent/100):sum*(1+percent/100));
 }
 return {basePrice:price,price,subtotal:sum,steps,issues,missing:issues,status:price===null?'missing':'priced',partial:issues.length>0,version:'engineering.1'};
}
root.QuoteEngineering={evaluate};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteEngineering;
})(typeof window!=='undefined'?window:globalThis);
