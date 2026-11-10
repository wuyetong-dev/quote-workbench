(function(root){
'use strict';
function apply(gross,q){const c=q.commercial||{},value=Number(c.discountValue||0);if(!Number.isFinite(value)||value<0)throw Error('优惠金额或比例无效');if(c.discountType==='percent'&&value>100)throw Error('优惠比例应在0至100%');const discount=Math.round((c.discountType==='percent'?gross*value/100:value)*100)/100;if(discount>gross)throw Error('整单优惠不能超过已计价金额');return {grossTotal:gross,discount,total:Math.round((gross-discount)*100)/100};}
root.QuoteCommercial={apply};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteCommercial;
})(typeof window!=='undefined'?window:globalThis);
