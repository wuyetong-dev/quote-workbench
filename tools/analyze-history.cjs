'use strict';
// Reuse the production parser and matcher. No source file is ever written.
const fs=require('node:fs'),crypto=require('node:crypto');
const X=require('../web/vendor/xlsx.full.min.js'),I=require('../web/importer.js'),K=require('../web/knowledge.js');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const norm=s=>String(s??'').normalize('NFKC').replace(/\s+/g,'').toUpperCase();
function analyze(bytes,filename){
 const digest=hash(bytes),workbook=X.read(bytes,{type:'buffer',cellFormula:true}),books=[],skipped=[];
 for(const sheet of workbook.SheetNames){
  if(/汇总|总报价|封面|目录|合同条款|^合计(?:表)?$/.test(sheet)){skipped.push({sheet,reason:'汇总或条款页仅保留原件，不作设备价格'});continue;}
  let q;try{q=I.parse(bytes,filename,X,{sheets:[sheet]});}catch(e){skipped.push({sheet,reason:e.message});continue;}
  const id='history-'+digest.slice(0,24)+'-'+hash(sheet).slice(0,12),issues=[],s=workbook.Sheets[sheet],ids=new Map(q.rows.map((r,i)=>[r.id,id+'-r'+(r.sourceRow||i)+'-'+i]));
  const recalc={...s};for(const [a,c]of Object.entries(s))if(c?.f)recalc[a]={...c,v:undefined};
  for(const [a,c]of Object.entries(s))if(c?.f){const n=I.formulaValue(recalc,a,X);if(n===null)issues.push({type:'formula',source:sheet+'!'+a,message:'该公式尚不能独立校验，保留原件待核'});else if(typeof c.v==='number'&&Math.abs(n-c.v)>.02)issues.push({type:'formula',source:sheet+'!'+a,message:'公式结果与缓存不一致',cached:c.v,calculated:n});}
  for(const r of q.rows){
   const old=r.id;r.id=ids.get(old);if(r.parentId)r.parentId=ids.get(r.parentId);if(r.bom?.parentId)r.bom.parentId=ids.get(r.bom.parentId);
   // Only explicit original selling prices enter history, not parser formula estimates.
   if(!['原表单价','原表公式'].includes(r.priceSource))r.basePrice=null;
   const amount=(r.fields||[]).find(f=>/^(?:金额|合价|总价)(?:[（(].*)?$/.test(String(f.label).replace(/\s/g,''))),a=amount&&String(amount.value).trim()?Number(String(amount.value).replace(/[,，￥¥元\s]/g,'')):NaN;
   const broken=(r.fields||[]).some(f=>issues.some(i=>i.source===f.range));
   if(broken||Number.isFinite(a)&&r.quantity!=null&&r.basePrice!=null&&Math.abs(a-r.quantity*r.basePrice)>.02){
    issues.push({type:'detail',rowId:r.id,source:r.source,message:'明细量价与金额不一致，暂不学习单价',amount:a,calculated:r.quantity*r.basePrice});
    r.historyBlocked=true;r.historicalPrice=r.basePrice;r.basePrice=null;r.override=null;r.pricing={};
   }
   r.documentId=digest;
  }
  const detailTotal=q.rows.reduce((n,r)=>n+(r.basePrice??0)*(r.quantity??0),0);
  const rows=q.sources[0].rows;
  for(let ri=0;ri<rows.length;ri++){
   const text=rows[ri].filter(v=>typeof v==='string').join(' ').replace(/\s/g,'');
   if(!/(?:未税金额|未税合计|总合计|总计|报价总额|^合计(?:金额)?(?:人民币)?[:：]?$)/.test(text)||/含税|税额|税金|大写/.test(text))continue;
   const values=rows[ri].filter(v=>typeof v==='number'&&v>0),total=values.at(-1);
   if(total!=null&&Math.abs(total-detailTotal)>.02)issues.push({type:'total',source:sheet+'!'+(ri+1),message:'原表汇总与明细合计不同；仅保留可校验的明细单价',original:total,detailTotal});
  }
  q.id=id+'-reference';if(!/^(?:Sheet\d*|工作表\d*|报价明细)$/i.test(sheet))q.title=sheet;q.date='';q.markup=0;
  const allText=rows.map(r=>r.join(' ')).join('\n'),excluded=/不含税|未税|税金另计|税额另计/.test(allText),included=/含税价|含税报价|单价含税|报价[^\n；。]{0,8}含税/.test(allText.replace(/不含税/g,'')),tax=excluded===included?'unknown':excluded?'excluded':'included';
  if(excluded&&included)issues.push({type:'business',source:sheet,message:'原表未税汇总与含税说明矛盾，税价口径待核对'});
  const rate=allText.match(/(?:税率|增值税|税金|税额)[^\d\n]{0,8}(\d+(?:\.\d+)?)\s*%/);
  const dates=[...new Set((allText.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g)||[]).map(v=>v.replace(/[年月/.]/g,'-').replace(/日/g,'').split('-').map((v,i)=>i?v.padStart(2,'0'):v).join('-')).filter(v=>Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v))],date=dates.length===1?dates[0]:'';
  const context={currency:/USD|美元/.test(allText)?'unknown':'CNY',taxMode:tax,taxRate:rate?Number(rate[1]):null,date};
  const saleTerms=rows.map(r=>r.filter(v=>typeof v==='string').join(' ')).filter(t=>/运输|运费|现场安装|报价有效|付款方式|付款条件|含税报价|单价含税|单价不含税/.test(t)).join('\n').slice(0,6000);
  q.origin={sha256:digest,documentId:digest,filename,sheet,kind:'historical_case'};q.historyContext=context;
  for(const r of q.rows){r.historyPriceContext=context;if(r.basePrice!=null)r.priceContext={...context,...r.priceContext};}
  const index=K.buildPriceIndex(q.rows,{id,filename,sheet,sha256:digest,documentId:digest,priceNature:'historical_quote',...context});
  const unique=new Map();for(const record of index.records){const fingerprint=hash(JSON.stringify([record.category,norm(record.name),norm(record.spec),record.unit,record.brand,record.scope,record.businessContext,record.price,record.priceNature,record.date,norm(saleTerms)]));if(unique.has(fingerprint)){const prior=unique.get(fingerprint);prior.sourceRefs.push(...record.sourceRefs);prior.quantities=[...new Set([...prior.quantities,record.quantity].filter(n=>n!=null))];}else unique.set(fingerprint,{...record,id:'fact-'+fingerprint,fingerprint,learnedCase:true,saleTerms,quantities:record.quantity==null?[]:[record.quantity]});}index.records=[...unique.values()];
  books.push({id,name:filename+' / '+sheet,index,reference:q,historyVersion:1,audit:{issues,detailTotal,rows:q.rows.length,priceRecords:index.records.length},learning:{status:'local',caseOnly:true}});
 }
 return {sha256:digest,books,skipped};
}
if(require.main===module){try{const request=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(analyze(fs.readFileSync(request.path),request.filename)));}catch(e){process.stderr.write(e.message);process.exitCode=1;}}
module.exports={analyze};
