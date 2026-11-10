(function(root){
'use strict';
const node=typeof module!=='undefined'&&module.exports,M=node?require('./model.js'):root.QuoteModel,R=node?require('./quote-repair.js'):root.QuoteRepair,K=node?require('./knowledge.js'):root.Knowledge;
const clone=v=>JSON.parse(JSON.stringify(v,M.quoteReplacer)),norm=v=>String(v||'').normalize('NFKC').trim();
function basis(row,type){return JSON.stringify(type==='quantity'?[row.quantity,(row.bom?.stationMembers||[]).map(m=>[m.stationNumber,m.sourceRow])]:[row.name,row.spec,row.unit,row.brand||'',row.basePrice]);}
function pending(q){return (q.rows||[]).flatMap(row=>Object.entries(row.automaticSuggestions||{}).filter(([type,s])=>s.status==='pending'&&s.basis===basis(row,type)).map(([type,s])=>({rowId:row.id,type,group:s.group,message:s.message,value:s.value})));}
function run(q){
 const before=M.calculate(q),B=node?require('./condition-binding.js'):root.QuoteConditionBinding,Q=node?require('./quantity.js'):root.QuoteQuantity,changes=B.apply(q);if(Q)changes.push(...Q.apply(q).changes);let plan=R.plan(q);
 // A station-based quantity is a visible, reversible proposal, never a silent
 // assertion about procurement. It may be calculated in a process quote.
 for(const g of plan.groups.filter(g=>g.type==='quantity'))for(const i of g.items){const row=q.rows.find(r=>r.id===i.id);if(row.quantity!=null||row.quantityEdited)continue;row.quantity=i.quantity;row.bom.quantityBasis='自动推算，待本单确认：独立工位 '+i.stations.join('、')+' 各1个';row.automaticSuggestions={...row.automaticSuggestions,quantity:{status:'pending',group:'quantity:'+g.source,value:i.quantity,message:'独立工位各供货1个（不代表联槽节数）',basis:basis(row,'quantity')}};changes.push({rowId:row.id,type:'quantity'});}
 M.autoPrice(q);plan=R.plan(q);
 for(const g of plan.groups.filter(g=>g.type==='price')){
  const precise=g.offers.filter(o=>o.record?.learnedCase&&o.exactSpec&&o.canAdopt),exactPrices=[...new Set(g.offers.filter(o=>o.exactSpec).map(o=>o.price))];
  if(precise.length&&exactPrices.length!==1)continue;
  const eligible=precise.length?precise:g.offers.filter(o=>!o.requiresReview),prices=[...new Set(eligible.map(o=>o.price))];if(prices.length!==1)continue;
  const offer=eligible[0];for(const i of g.items){const row=q.rows.find(r=>r.id===i.id);if(row.calculation||row.override!=null||row.basePrice!=null||row.selected===false||M.isRequirement(row)||M.isIncluded(row))continue;
   const quantities=offer.record?.quantities||[offer.record?.quantity],conditionalCase=offer.record?.learnedCase&&offer.exactSpec&&!offer.automaticReady;
   if(conditionalCase&&(row.quantity==null||!quantities.includes(M.number(row.quantity))))continue;
   const W=node?require('./knowledge-workflow.js'):root.KnowledgeWorkflow;
   if(offer.isMemory){row.basePrice=offer.price;if(offer.priceMode==='fixed_sale'){row.override=offer.price;row.priceKind='confirmed_sale';}row.pricing={mode:'manual'};row.priceSource='企业价格记忆';row.priceEvidence={ruleId:offer.ruleId,revision:offer.revision,priceMode:offer.priceMode||'base',source:offer.source,confirmedAt:offer.confirmedAt,confirmed:true,priceNature:'enterprise_quote'};}
   else{W.adoptPrice(row,{bookId:offer.bookId,bookName:offer.bookName,candidates:[{id:offer.candidateId,record:offer.record}]},{candidateId:offer.candidateId,confirmed:true,quote:q});row.priceSource=offer.automaticReady?'条件一致 · 企业历史售价':'自动匹配历史售价 · 待本单确认';row.priceEvidence.automatic=true;row.priceEvidence.confirmedBy=offer.automaticReady?'程序':null;row.automaticSuggestions={...row.automaticSuggestions,price:{status:offer.automaticReady?'confirmed':'pending',group:'price:'+g.label+':'+g.spec,value:offer.price,message:'已知规格适用的历史售价；核对税运及包含范围',basis:basis(row,'price')}};}
   if(conditionalCase){row.priceEvidence.adoption.confirmed=false;row.automaticSuggestions.price.group='historical-case:'+(offer.record.sourceRefs?.[0]?.sourceId||offer.bookId);row.automaticSuggestions.price.message='同规格、同数量的历史售价；本单税运及供货范围需确认';}
   if(offer.record?.learnedCase)row.historyReuseBasis=M.historyBasis(row,q);
   changes.push({rowId:row.id,type:'price'});
  }
 }
 M.autoPrice(q);const after=M.calculate(q);q.automationSummary={at:new Date().toISOString(),changes:changes.length,quantity:changes.filter(c=>c.type==='quantity').length,price:changes.filter(c=>c.type==='price').length,conditions:q.rows.filter(r=>r.conditionBinding&&B.valid(r,q.rows)).length,before:{priced:before.selected-before.missing,total:before.total},after:{priced:after.selected-after.missing,total:after.total}};return {quote:q,changes};
}
function approve(q,group){let count=0;for(const row of q.rows)for(const [type,s]of Object.entries(row.automaticSuggestions||{}))if(s.status==='pending'&&s.group===group&&s.basis===basis(row,type)&&(!row.historyReuseBasis||M.historyTechnicalValid(row,q))){if(row.historyReuseBasis)row.historyReuseBasis=M.historyBasis(row,q);s.status='confirmed';s.confirmedAt=new Date().toISOString();s.confirmedBy='报价员';if(type==='price'&&row.priceEvidence){row.priceEvidence.confirmedBy='报价员';if(row.priceEvidence.adoption)Object.assign(row.priceEvidence.adoption,{confirmed:true,confirmedAt:s.confirmedAt});}row.repairEvidence=[...(row.repairEvidence||[]),{type,value:s.value,confirmedAt:s.confirmedAt,source:row.source}];count++;}return count;}
function scopeGroups(q){const groups=new Map();for(const row of q.rows.filter(r=>M.isRequirement(r)&&!(node?require('./condition-binding.js'):root.QuoteConditionBinding).valid(r,q.rows)&&!r.scopeReview?.confirmedAt&&!r.financialSource)){const label=row.name.split(' · ').slice(1).join(' · ')||row.bom?.deviceFamily||row.name;const key=norm(label);if(!groups.has(key))groups.set(key,{key,label,rows:[]});groups.get(key).rows.push(row);}return [...groups.values()];}
root.QuoteAutomation={run,pending,approve,scopeGroups,basis};if(node)module.exports=root.QuoteAutomation;
})(typeof window!=='undefined'?window:globalThis);
