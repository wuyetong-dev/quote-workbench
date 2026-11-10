(function(root){
'use strict';
function inlineStrings(zip,CFB){
 const decode=value=>new TextDecoder().decode(value),encode=value=>new TextEncoder().encode(value),shared=CFB.find(zip,'/xl/sharedStrings.xml');
 if(!shared)return zip;
 const strings=[...decode(shared.content).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(found=>found[1]);
 for(let index=0;index<zip.FullPaths.length;index++)if(/\/xl\/worksheets\/sheet\d+\.xml$/.test(zip.FullPaths[index])){
  const entry=zip.FileIndex[index],xml=decode(entry.content).replace(/<c\b([^>]*\bt="s"[^>]*)>([\s\S]*?)<\/c>/g,(_,attributes,value)=>{
   const number=value.match(/<v>(\d+)<\/v>/)?.[1],text=number!==undefined?strings[Number(number)]:undefined;
   if(text===undefined)throw Error('Excel文字索引无效，请重新生成报价');
   return '<c'+attributes.replace(/\bt="s"/,'t="inlineStr"')+'>'+value.replace(/<v>\d+<\/v>/,'<is>'+text+'</is>')+'</c>';
  });entry.content=encode(xml);entry.size=entry.content.length;
 }
 return zip;
}
async function excel(result){
 const referenceBuffer=await(await fetch('/assets/excel-reference.xlsx')).arrayBuffer(),originalBook=new ExcelJS.Workbook();await originalBook.xlsx.load(referenceBuffer);
 const original=originalBook.worksheets[0],book=new ExcelJS.Workbook(),sheet=book.addWorksheet('报价单'),model=result.exportContent,cfg=model.config;
 book.creator=cfg.company;book.calcProperties.fullCalcOnLoad=true;
 const copy=v=>JSON.parse(JSON.stringify(v));
 sheet.pageSetup={...copy(original.pageSetup),paperSize:9,orientation:'portrait',scale:86,fitToPage:false};
 delete sheet.pageSetup.printTitlesRow;delete sheet.pageSetup.printTitlesColumn;sheet.headerFooter={};
 sheet.properties=copy(original.properties);
 cfg.excelWidths.forEach((w,i)=>{sheet.getColumn(i+1).width=w;sheet.getColumn(i+1).style=copy(original.getColumn(i+1).style);});
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 const columnPoints=cfg.excelWidths.map(w=>(w*7+5)*.75),fullWidth=columnPoints.reduce((a,b)=>a+b,0),scale=.86;
 const leading=12.6/scale,padding=8/scale,capacity=(841.85-(sheet.pageSetup.margins.top+sheet.pageSetup.margins.bottom)*72)/scale;
 function wrap(value,width,font=12){ctx.font=`${font*96/72}px SimSun`;const limit=(width-5)*96/72,lines=[];for(const line of String(value??'').replace(/\r\n?/g,'\n').split('\n')){let text='';for(const token of line.match(/[A-Za-z0-9_.,/%+\-]+|[^A-Za-z0-9_.,/%+\-]/g)||[]){if(text&&ctx.measureText(text+token).width>limit){lines.push(text);text='';}for(const c of token){if(text&&ctx.measureText(text+c).width>limit){lines.push(text);text='';}text+=c;}}lines.push(text);}return lines;}
 const border={style:'thin',color:{argb:'FF000000'}},allBorder={top:border,bottom:border,left:border,right:border};
 function styleRow(n,source=15){for(let i=1;i<=10;i++){const c=sheet.getCell(n,i);c.style=copy(original.getCell(source,i).style);c.font={name:'宋体',size:12,color:{argb:'FF000000'}};c.alignment={vertical:'middle',horizontal:'left',wrapText:true};c.border=allBorder;}}
 function sourceRow(target,source){sheet.getRow(target).height=original.getRow(source).height;for(let col=1;col<=10;col++){const src=original.getCell(source,col),dst=sheet.getCell(target,col);dst.style=copy(src.style);if(!src.isMerged||src.master.address===src.address)dst.value=copy(src.value);}}
 for(let n=1;n<=10;n++)sourceRow(n,n);
 for(const merge of original.model.merges){const row=Number(merge.match(/\d+/)[0]);if(row<=10)sheet.mergeCells(merge);}
 const q=result.quote;
 sheet.getCell('A2').value=cfg.title;sheet.getCell('A3').value='项  目:'+q.title;sheet.getCell('A4').value='客  户:'+q.customer;sheet.getCell('A5').value='制造商:'+cfg.company;sheet.getCell('A6').value='日  期:'+model.date;
 for(const n of [3,4]){const c=sheet.getCell(n,1),count=wrap(c.value,fullWidth,c.font.size).length;if(count>1){c.alignment={...c.alignment,wrapText:true};sheet.getRow(n).height=Math.max(sheet.getRow(n).height,count*c.font.size*1.3+6);}if(sheet.getRow(n).height>409)throw Error('项目或客户名称过长，无法放入Excel抬头，请缩短抬头信息');}
 for(const image of original.getImages()){const data=originalBook.getImage(image.imageId),id=book.addImage({buffer:data.buffer,base64:data.base64,extension:data.extension});sheet.addImage(id,{tl:copy(image.range.tl.model),br:copy(image.range.br.model),editAs:image.range.editAs});}
 sheet.getRow(10).addPageBreak();
 let at=11;
 sheet.mergeCells(at,1,at,10);sheet.getCell(at,1).style=copy(original.getCell(11,1).style);sheet.getCell(at,1).value=q.title+'工艺流程及价格说明';sheet.getCell(at,1).alignment={horizontal:'center',vertical:'middle',wrapText:true};sheet.getRow(at).height=Math.max(39,wrap(sheet.getCell(at,1).value,fullWidth,24).length*29+6);at++;
 styleRow(at,12);sheet.mergeCells(at,3,at,5);[1,2,3,6,7,8,9,10].forEach((col,i)=>{const c=sheet.getCell(at,col);c.value=cfg.columns[i];c.font={name:'宋体',size:14};c.alignment={horizontal:'center',vertical:'middle',wrapText:true};});sheet.getRow(at).height=30;at++;
 let used=sheet.getRow(11).height+sheet.getRow(12).height;
 const detailStart=at,blocks=[],rawRows=new Map(model.sections.flatMap(s=>s.rows).map(r=>[r.sequence,r]));
 for(const b of result.layout.blocks){
  if(b.type==='group'||b.type==='subgroup')blocks.push({type:b.type,text:b.lines.join('\n'),height:Math.max(26,b.height/scale)});
  if(b.type==='sectionTotal')blocks.push({type:'sectionTotal',label:b.label,value:b.numberValue??Number(b.value),height:Math.max(27,wrap(b.label,columnPoints.slice(1,5).reduce((a,v)=>a+v,0),12).length*leading+padding)});
  if(b.type==='item'){
   const r=rawRows.get(b.sequence),cells=b.cells,max=Math.max(...cells.map(x=>x.length)),take=26;
   for(let offset=0;offset<max;offset+=take){const chunk=cells.map(v=>v.slice(offset,offset+take));blocks.push({type:'item',row:r,cells:chunk,first:offset===0,height:Math.max(27,Math.max(...chunk.map(v=>v.length))*leading+padding)});}
  }
 }
 const detailEndIndex=blocks.length-1;
 for(const total of model.totals)blocks.push({type:'total',...total,height:27});
 const sourceNotes=String(model.notes).split('\n');let inRemarks=true,firstRemark=true,firstBusiness=true;
 for(let i=0;i<sourceNotes.length;i++){
  let line=sourceNotes[i];
  if(i===0&&/^备注[:：]/.test(line))line=line.replace(/^备注[:：]/,'');
  if(/^\s*(?:[一二三四五六七八九十]+[、.．]\s*)?(?:付款方式|交货期|设备保养期|设备保修期|本次未计入报价)/.test(line))inRemarks=false;
  const spanWidth=inRemarks?fullWidth-columnPoints[0]:fullWidth;
  for(const text of wrap(line,spanWidth,12)){
   blocks.push({type:'note',text,remarks:inRemarks,businessStart:!inRemarks&&firstBusiness,label:inRemarks&&firstRemark?'备注：':'',heading:/^\s*[一二三四五六七八九十]+[、.．]/.test(text),height:Math.max(18,leading+3)});
   if(inRemarks)firstRemark=false;
   else firstBusiness=false;
  }
 }
 const signatureHeight=[387,388,389].reduce((sum,n)=>sum+original.getRow(n).height,0);blocks.push({type:'signature',height:signatureHeight});
 const tailHeight=blocks.slice(detailEndIndex+1).reduce((sum,b)=>sum+b.height,0);
 let subtotalCell,taxCell,detailLast,grossCell,discountCell;const detailAmountCells=[],chapterAmountCells=[];
 function breakBefore(){sheet.getRow(at-1).addPageBreak();used=0;}
 function ensure(h){if(used+h>capacity+.01)breakBefore();}
 function fullRow(text,height,bold=false){const n=at++;styleRow(n,bold?13:384);sheet.mergeCells(n,1,n,10);sheet.getCell(n,1).value=text;sheet.getCell(n,1).font={name:'宋体',size:12,bold};sheet.getCell(n,1).alignment={vertical:'middle',horizontal:'left',wrapText:true};sheet.getRow(n).height=height;used+=height;return n;}
 for(let index=0;index<blocks.length;index++){
  const b=blocks[index];let need=b.height;
  if(b.type==='group'){
   const end=blocks.findIndex((v,i)=>i>index&&v.type==='group'),section=blocks.slice(index,end<0?detailEndIndex+1:end),h=section.reduce((a,v)=>a+v.height,0);
   if(detailLast&&h<=capacity&&used+h>capacity)breakBefore();
  }
  if(b.type==='group'||b.type==='subgroup'){let j=index+1;while(j<blocks.length&&['group','subgroup'].includes(blocks[j].type)){need+=blocks[j].height;j++;}if(j<blocks.length)need+=blocks[j].height;}
  if(index===detailEndIndex){if(need+tailHeight<=capacity)need+=tailHeight;else{let j=index+1;while(blocks[j]?.type==='total'){need+=blocks[j].height;j++;}if(blocks[j]?.type==='note')need+=blocks[j].height;}}
  if(b.type==='total'){let j=index+1;while(blocks[j]?.type==='total'){need+=blocks[j].height;j++;}if(blocks[j]?.type==='note')need+=blocks[j].height;}
  if(b.type==='note'){
   const remaining=blocks.slice(index).filter(x=>x.type==='note');if(remaining.length<=3)need=remaining.reduce((a,v)=>a+v.height,0)+signatureHeight;
   else if(b.heading)need+=blocks[index+1]?.height||0;
  }
  ensure(need);
  if(b.type==='group'||b.type==='subgroup'){fullRow(b.text,b.height,true);continue;}
  if(b.type==='item'){
   const n=at++,r=b.row;styleRow(n);sheet.mergeCells(n,3,n,5);
   const hasAmount=b.first&&r.amount!==null&&r.amount!==undefined;
   const values=[b.first?String(r.displaySequence??r.sequence):null,String(b.cells[1].join('\n')),b.cells[2].join('\n'),null,null,String(b.cells[3].join('\n')),b.first?r.quantity:null,b.first?String(r.unit||''):null,b.first?r.unitPrice:null,hasAmount?{formula:`ROUND(G${n}*I${n},2)`,result:r.amount}:null];
   for(let col=1;col<=10;col++){const c=sheet.getCell(n,col);if(col===4||col===5)continue;c.value=values[col-1]||values[col-1]===0?values[col-1]:null;c.alignment={vertical:'middle',horizontal:col>=7?'right':col===1?'center':'left',wrapText:col<7,shrinkToFit:col>=7};if(col===9||col===10)c.numFmt=Number.isInteger(col===9?r.unitPrice:r.amount)?'0':'0.00';}
   if(hasAmount){detailAmountCells.push('J'+n);chapterAmountCells.push('J'+n);}sheet.getRow(n).height=b.height;used+=b.height;detailLast=n;continue;
  }
  if(b.type==='total'||b.type==='sectionTotal'){
   const n=at++;styleRow(n,381);sheet.mergeCells(n,2,n,5);sheet.mergeCells(n,7,n,10);sheet.getCell(n,2).value=b.label;sheet.getCell(n,2).alignment={horizontal:'center',vertical:'middle',wrapText:true};
   const cells=b.type==='sectionTotal'?chapterAmountCells:detailAmountCells;
   const formula=b.kind==='discount'?String(b.value):b.kind==='subtotal'&&grossCell?grossCell+'+'+discountCell:b.type==='sectionTotal'||b.kind==='subtotal'||b.kind==='gross'?(b.type==='total'&&!model.business?`SUM(J${detailStart}:J${detailLast})`:cells.length?'SUM('+cells.join(',')+')':'0'):b.kind==='tax'?`ROUND(${subtotalCell}*${Number(q.taxRate)}/100,2)`:`${subtotalCell}+${taxCell}`;
   const c=sheet.getCell(n,7);c.value={formula,result:b.value};c.numFmt=Number.isInteger(b.value)?'0':'0.00';c.alignment={horizontal:'right',vertical:'middle'};if(b.kind==='subtotal')subtotalCell=c.address;if(b.kind==='tax')taxCell=c.address;if(b.kind==='gross')grossCell=c.address;if(b.kind==='discount')discountCell=c.address;if(b.type==='sectionTotal')chapterAmountCells.length=0;sheet.getRow(n).height=b.height;used+=b.height;continue;
  }
  if(b.type==='note'){
   const n=at++;styleRow(n,384);for(let col=1;col<=10;col++)sheet.getCell(n,col).border={...(col===1?{left:border}:{}),...(col===10?{right:border}:{})};
   if(b.remarks){sheet.mergeCells(n,2,n,10);sheet.getCell(n,1).value=b.label||null;sheet.getCell(n,2).value=b.text||null;sheet.getCell(n,1).alignment={vertical:'top',wrapText:false};sheet.getCell(n,2).border={right:border};}else{sheet.mergeCells(n,1,n,10);sheet.getCell(n,1).value=b.text||null;sheet.getCell(n,1).border={left:copy(original.getCell(386,1).border.left),right:copy(original.getCell(386,10).border.right),...(b.businessStart?{top:copy(original.getCell(384,1).border.top)}:{})};}
   const c=sheet.getCell(n,b.remarks?2:1);c.alignment={horizontal:'left',vertical:'middle',wrapText:false};if(blocks[index+1]?.type==='signature')for(let col=1;col<=10;col++)sheet.getCell(n,col).border={...sheet.getCell(n,col).border,bottom:copy(original.getCell(386,col).border.bottom)};sheet.getRow(n).height=b.height;used+=b.height;continue;
  }
  if(b.type==='signature'){
   // Copy the original three unmerged handwriting rows immediately after terms.
   for(const source of [387,388,389]){const n=at++;sourceRow(n,source);if(source===389)for(const col of [1,5]){const c=sheet.getCell(n,col);c.value=String(c.value).replace(/\d{4}(?=年)/,String(q.date).slice(0,4));}used+=sheet.getRow(n).height;}
  }
 }
 sheet.pageSetup.printArea='A1:J'+(at-1);sheet.views=[{state:'frozen',ySplit:12}];
 // Excel measures character-width columns using the workbook Normal font.
 // ExcelJS writes Calibri 11 as its default even after importing a template;
 // retain the reference Normal font so physical widths and image anchors match.
 const CFB=XLSX.CFB,decode=v=>new TextDecoder().decode(v),encode=v=>new TextEncoder().encode(v),referenceZip=CFB.read(new Uint8Array(referenceBuffer),{type:'array'}),zip=CFB.read(new Uint8Array(await book.xlsx.writeBuffer({useSharedStrings:false})),{type:'array'});
 const sourceStyles=decode(CFB.find(referenceZip,'/xl/styles.xml').content),font0=sourceStyles.match(/<fonts[^>]*>\s*(<font>[\s\S]*?<\/font>)/)[1],styles=decode(CFB.find(zip,'/xl/styles.xml').content).replace(/(<fonts[^>]*>\s*)<font>[\s\S]*?<\/font>/,(_,prefix)=>prefix+font0);
 const styleEntry=CFB.find(zip,'/xl/styles.xml');styleEntry.content=encode(styles);styleEntry.size=styleEntry.content.length;
 const replacePart=(path,content)=>{let entry=CFB.find(zip,'/'+path);if(!entry)entry=CFB.utils.cfb_add(zip,'/'+path,content);entry.content=content;entry.size=content.length;};
 // Keep drawing cropping, hidden state and original media. ExcelJS's image
 // model omits these, which otherwise changes the printed company logo.
 for(let i=0;i<referenceZip.FullPaths.length;i++){const path=referenceZip.FullPaths[i].replace(/^[^/]+\//,'');if(/^xl\/(?:drawings|media)\//.test(path)&&referenceZip.FileIndex[i].type===2)replacePart(path,referenceZip.FileIndex[i].content);}
 const sourceSheet=decode(CFB.find(referenceZip,'/xl/worksheets/sheet1.xml').content),sourceRows=new Map([...sourceSheet.matchAll(/<row\b[^>]*>/g)].map(m=>[Number(m[0].match(/\br="(\d+)"/)[1]),m[0]]));
 const sheetEntry=CFB.find(zip,'/xl/worksheets/sheet1.xml'),sheetXml=decode(sheetEntry.content).replace(/<row\b[^>]*>/g,tag=>{const n=Number(tag.match(/\br="(\d+)"/)[1]);return n<=10&&!/\bcustomHeight=/.test(sourceRows.get(n))?tag.replace(/\s+customHeight="[^"]*"/,''):tag;});
 replacePart('xl/worksheets/sheet1.xml',encode(sheetXml));
 inlineStrings(zip,CFB);
 return new Blob([CFB.write(zip,{type:'array',fileType:'zip',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
root.QuoteExporter={excel,download,inlineStrings};
})(window);
