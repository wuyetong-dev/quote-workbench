(function(root){
'use strict';
async function excel(result){
 const model=result.businessContent;
 if(model?.exportConfig)return configuredExcel(result);
 if(!model?.chapters||model.columns?.length!==6)throw Error('报价服务尚未更新，请关闭原服务窗口后重新启动工作台，再导出');
 const book=new root.ExcelJS.Workbook(),cover=book.addWorksheet('合计'),sheet=book.addWorksheet('报价明细');
 book.creator='报价工作台';book.calcProperties.fullCalcOnLoad=true;
 const edge={style:'thin',color:{argb:'FF888888'}},border={top:edge,bottom:edge,left:edge,right:edge};
 function wrapped(value,width){const lines=[];for(const source of String(value??'').replace(/\r\n?/g,'\n').split('\n')){let line='',used=0;for(const char of source){const size=char.charCodeAt(0)>255?2:1;if(line&&used+size>width){lines.push(line);line='';used=0;}line+=char;used+=size;}lines.push(line);}return lines;}
 function style(row,{fill,bold=false}={}){for(let col=1;col<=6;col++){const cell=row.getCell(col);cell.font={name:'宋体',size:11,bold,color:{argb:'FF172333'}};cell.alignment={vertical:'middle',horizontal:col>=5?'right':col===1||col===3||col===4?'center':'left',wrapText:true};cell.border=border;if(fill)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}};}row.height=26;return row;}
 function wide(target,text,{bold=false,size=11}={}){const lines=wrapped(text,116);for(let offset=0;offset<lines.length;offset+=24){const part=lines.slice(offset,offset+24),row=target.addRow([part.join('\n')]);target.mergeCells(row.number,1,row.number,6);row.getCell(1).font={name:'宋体',size,bold};row.getCell(1).alignment={vertical:'middle',wrapText:true};row.height=Math.max(25,part.length*(size+4)+10);}}
 function merged(target,label,amount){const row=style(target.addRow([label,null,null,null,null,amount]),{fill:'FFE8EDF2',bold:true});target.mergeCells(row.number,1,row.number,5);row.getCell(6).numFmt='0.00';return row;}
 for(const target of [cover,sheet]){target.columns=model.excelWidths.map(width=>({width}));target.pageSetup={paperSize:9,orientation:'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.3,right:.3,top:.45,bottom:.45,header:.15,footer:.2}};target.headerFooter={oddFooter:'第 &P 页 / 共 &N 页'};}
 wide(sheet,model.supplier,{bold:true,size:16});wide(sheet,(model.title||'项目')+'报价单',{bold:true,size:15});
 wide(sheet,'购方：'+(model.customer||'')+'　日期：'+(model.date||''));
 wide(sheet,`供货 ${model.selectedCount} 项　已价 ${model.pricedCount} 项　待价 ${model.pendingCount} 项`);
 const header=style(sheet.addRow(model.columns),{fill:'FFE8EDF2',bold:true});sheet.pageSetup.printTitlesRow=`1:${header.number}`;sheet.views=[{state:'frozen',ySplit:header.number}];
 const chapterTotals=[],coverChapters=[];
 for(const chapter of model.chapters){
  if(!chapter.rows.length)continue;
  wide(sheet,chapter.chapterTitle,{bold:true});
  const amountCells=[];
  for(const item of chapter.rows){
   const lines=wrapped(item.description,64);
   // Keep quantity and money on the first fragment of a long configuration.
   for(let offset=0;offset<lines.length;offset+=24){
    const first=offset===0,part=lines.slice(offset,offset+24);
    const row=style(sheet.addRow([first?String(item.code||''):null,part.join('\n'),first?item.quantity??null:null,first?String(item.unit||''):null,first?item.unitPrice??null:null,first?item.amount??null:null]));
    row.getCell(2).alignment={vertical:'middle',horizontal:'left',wrapText:true,indent:Math.min(item.depth||0,4)};
    row.getCell(3).numFmt='0.###############';row.getCell(5).numFmt='0.00';row.getCell(6).numFmt='0.00';row.height=Math.max(28,part.length*15+10);
    if(first&&item.amount!=null){row.getCell(6).value={formula:`ROUND(C${row.number}*E${row.number},2)`,result:item.amount};amountCells.push('F'+row.number);}
   }
  }
  const total=merged(sheet,`本章小计（供货${chapter.count}项；待价${chapter.missing}项）`,{formula:amountCells.length?'SUM('+amountCells.join(',')+')':'0',result:chapter.subtotal});
  chapterTotals.push('F'+total.number);coverChapters.push({label:chapter.chapterTitle,cell:'F'+total.number,value:chapter.subtotal});
 }
 let subtotalCell,taxCell,grossCell,discountCell;const totalCells=[];
 for(const item of model.totals){
  const formula=item.kind==='gross'?(chapterTotals.length?'SUM('+chapterTotals.join(',')+')':'0'):item.kind==='discount'?String(item.value):item.kind==='subtotal'?(grossCell?grossCell+'+'+discountCell:chapterTotals.length?'SUM('+chapterTotals.join(',')+')':'0'):item.kind==='tax'?`ROUND(${subtotalCell}*${Number(result.quote.taxRate||0)}/100,2)`:`${subtotalCell}+${taxCell}`;
  const row=merged(sheet,item.label,{formula,result:item.value});if(item.hidden)row.hidden=true;if(item.kind==='subtotal')subtotalCell='F'+row.number;if(item.kind==='tax')taxCell='F'+row.number;if(item.kind==='gross')grossCell='F'+row.number;if(item.kind==='discount')discountCell='F'+row.number;
  totalCells.push({label:item.label,cell:'F'+row.number,value:item.value});
 }
 wide(sheet,(model.completeness.canFinalize?'合计大写：':'已计价部分大写：')+model.amountInWords,{bold:true});
 for(const note of [...(model.pricingNotes||[]),...(model.deliveryNotes||[])])wide(sheet,note);
 wide(cover,model.supplier,{bold:true,size:16});wide(cover,(model.title||'项目')+'报价汇总',{bold:true,size:15});
 wide(cover,'购方：'+(model.customer||''));wide(cover,'供方：'+model.supplier);wide(cover,'日期：'+(model.date||''));
 for(const item of [...coverChapters,...totalCells])merged(cover,item.label,{formula:`'报价明细'!${item.cell}`,result:item.value});
 wide(cover,(model.completeness.canFinalize?'合计大写：':'已计价部分大写：')+model.amountInWords,{bold:true});
 if(model.notes){wide(cover,'备注与商务条款：',{bold:true});wide(cover,model.notes);}
 for(const note of model.deliveryNotes||[])wide(cover,note);
 wide(cover,'购方签署：________________　供方签署：________________');wide(cover,'日期：________________　日期：________________');
 wide(cover,model.supplierAddress+'　电话：'+model.supplierPhone);
 for(const target of [cover,sheet])target.pageSetup.printArea='A1:F'+target.rowCount;
 const CFB=root.XLSX.CFB,zip=CFB.read(new Uint8Array(await book.xlsx.writeBuffer({useSharedStrings:false})),{type:'array'});
 root.QuoteExporter.inlineStrings(zip,CFB);
 return new Blob([CFB.write(zip,{type:'array',fileType:'zip',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function configuredExcel(result){
 const model=result.businessContent,cfg=model.exportConfig,columns=cfg.columns.filter(c=>c.visible!==false),keys=columns.map(c=>c.key),count=columns.length;
 const book=new root.ExcelJS.Workbook(),summaryName=cfg.workbook.sheets.find(s=>s.id==='summary')?.name||'合计',detailName=cfg.workbook.sheets.find(s=>s.id==='details')?.fallbackName||'报价明细';
 const sections=model.sections?.length>1?model.sections:[{title:detailName,chapters:model.chapters}],names=new Set([summaryName]);
 const cover=book.addWorksheet(summaryName);
 const sheets=sections.map((section,index)=>{let name=(sections.length>1?section.title:detailName).replace(/[\\/*?:\[\]]/g,' ').slice(0,31)||'生产线';const stem=name;let n=1;while(names.has(name))name=stem.slice(0,26)+'-'+(++n);names.add(name);return book.addWorksheet(name);});
 let sheet=sheets[0];book.creator='报价工作台';book.calcProperties.fullCalcOnLoad=true;book.views=[{activeTab:0,firstSheet:0}];
 const base=cfg.styles.base,amountIndex=keys.indexOf('amount')+1,quantityIndex=keys.indexOf('quantity')+1,priceIndex=keys.indexOf('unitPrice')+1,descriptionIndex=keys.indexOf('description')+1;
 const border=base.border.edges==='none'?{}:Object.fromEntries(['top','bottom','left','right'].map(edge=>[edge,{style:base.border.style,color:{argb:'FF'+base.border.color}}]));
 function style(row,type='detail'){const rule=cfg.styles[type]||{};for(let n=1;n<=count;n++){const cell=row.getCell(n),col=columns[n-1];cell.font={...base.font,...rule.font};cell.alignment={vertical:'middle',horizontal:col.align,wrapText:true};cell.border=border;if(rule.fill)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF'+rule.fill}};if(col.format)cell.numFmt=col.format;}row.height=28;return row;}
 function wrapped(value,width){const lines=[];for(const source of String(value??'').split(/\r?\n/)){let line='',used=0;for(const char of source){const size=char.charCodeAt(0)>255?2:1;if(line&&used+size>width){lines.push(line);line='';used=0;}line+=char;used+=size;}lines.push(line);}return lines;}
 function wide(target,text,type='detail'){for(const chunk of split(wrapped(text,columns.reduce((n,c)=>n+c.width,0)-8),24)){const row=style(target.addRow([chunk.join('\n')]),type);target.mergeCells(row.number,1,row.number,count);row.getCell(1).alignment={vertical:'middle',horizontal:type==='title'?'center':'left',wrapText:true};row.height=Math.max(28,chunk.length*(base.font.size+5)+10);} }
 function split(lines,size){const chunks=[];for(let n=0;n<lines.length;n+=size)chunks.push(lines.slice(n,n+size));return chunks;}
 function total(target,label,value){const row=style(target.addRow([]),'subtotal'),start=amountIndex===1?2:1,end=amountIndex===1?count:amountIndex-1;if(end>start)target.mergeCells(row.number,start,row.number,end);row.getCell(start).value=label;row.getCell(start).alignment={horizontal:'left',wrapText:true,vertical:'middle'};row.getCell(amountIndex).value=value;row.getCell(amountIndex).numFmt='#,##0.00';return row.getCell(amountIndex).address;}
 const orientation=cfg.workbook.page.orientation;
 for(const target of [cover,...sheets]){target.columns=columns.map(c=>({width:c.width}));target.pageSetup={paperSize:9,orientation,fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.3,right:.3,top:.45,bottom:.45,header:.15,footer:.2}};target.headerFooter={oddFooter:'第 &P 页 / 共 &N 页'};}
 const summary=[],chapterAddresses=[];
 for(let sectionIndex=0;sectionIndex<sections.length;sectionIndex++){
 sheet=sheets[sectionIndex];const section=sections[sectionIndex],sectionAddresses=[];
 wide(sheet,model.supplier,'title');wide(sheet,cfg.workbook.title.text.replaceAll('{quote.title}',model.title||'项目'),'title');wide(sheet,'购方：'+(model.customer||'')+'　日期：'+(model.date||''));
 const header=style(sheet.addRow(columns.map(c=>c.label)),'columnHeader');sheet.views=[{state:'frozen',ySplit:header.number}];if(cfg.workbook.page.repeatColumnHeader)sheet.pageSetup.printTitlesRow='1:'+header.number;
 if(sections.length>1)wide(sheet,section.title,'title');
 for(const chapter of section.chapters){wide(sheet,chapter.chapterTitle,'chapter');const amounts=[],groups=new Map(),codeIndex=keys.indexOf('code')+1;
  for(const item of chapter.rows){const description=keys.includes('name')&&item.description.startsWith(item.name+'\n')?item.description.slice(item.name.length+1):item.description;const chunks=split(wrapped(description,Math.max(10,columns[descriptionIndex-1].width-4-item.depth*cfg.hierarchy.indent.perLevel*2)),24);for(let n=0;n<chunks.length;n++){const first=n===0,values=columns.map(col=>col.key==='description'?chunks[n].join('\n'):first?(item.billing==='included'&&col.key==='unitPrice'?'\u5df2\u542b':item.billing==='included'&&col.key==='amount'?'\u4e0d\u53e6\u8ba1':item[col.key]??null):null);if(codeIndex&&cfg.hierarchy.mergeParentCode!==false)values[codeIndex-1]=first&&item.id===item.rootId?item.groupCode:null;const row=style(sheet.addRow(values));if(first)row.getCell(codeIndex||descriptionIndex).numFmt=codeIndex?'@':undefined;row.getCell(descriptionIndex).alignment={horizontal:'left',vertical:'middle',wrapText:true,indent:Math.min(item.depth*cfg.hierarchy.indent.perLevel,cfg.hierarchy.indent.maxLevel)};row.height=Math.max(28,chunks[n].length*(base.font.size+4)+10);if(first&&item.amount==null&&item.billing!=='included'&&item.type!=='note'){row.getCell(priceIndex).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF1D6'}};row.getCell(priceIndex).note=item.reason||'\u672c\u9879\u672a\u8ba1\u4ef7\uff0c\u4e0d\u542b\u5728\u5c0f\u8ba1\u4e2d';}if(first&&item.amount!=null){const amount=row.getCell(amountIndex),q=row.getCell(quantityIndex),p=row.getCell(priceIndex);amount.value={formula:`ROUND(${q.address}*${p.address},2)`,result:item.amount};amounts.push(amount.address);}if(codeIndex&&cfg.hierarchy.mergeParentCode!==false){const key=item.rootId||item.id,g=groups.get(key)||{start:row.number,end:row.number};g.end=row.number;groups.set(key,g);}}}
  if(codeIndex&&cfg.hierarchy.mergeParentCode!==false)for(const g of groups.values())if(g.end>g.start)sheet.mergeCells(g.start,codeIndex,g.end,codeIndex);
  const address=total(sheet,cfg.chapters.subtotal.label,{formula:amounts.length?'SUM('+amounts.join(',')+')':'0',result:chapter.subtotal});const ref="'"+sheet.name.replaceAll("'","''")+"'!"+address;chapterAddresses.push(ref);sectionAddresses.push(address);summary.push({label:(sections.length>1?section.title+' · ':'')+chapter.chapterTitle,address,ref,value:chapter.subtotal});
 }
 if(sections.length>1){total(sheet,'本生产线已计价合计（整单优惠、税额见汇总）',{formula:sectionAddresses.length?'SUM('+sectionAddresses.join(',')+')':'0',result:section.subtotal});}
 else {
 let subtotalAddress,taxAddress,grossAddress,discountAddress;
 for(const item of model.totals){const formula=item.kind==='gross'?(sectionAddresses.length?'SUM('+sectionAddresses.join(',')+')':'0'):item.kind==='discount'?String(item.value):item.kind==='subtotal'?(grossAddress?grossAddress+'+'+discountAddress:sectionAddresses.length?'SUM('+sectionAddresses.join(',')+')':'0'):item.kind==='tax'?`ROUND(${subtotalAddress}*${Number(result.quote.taxRate||0)}/100,2)`:`${subtotalAddress}+${taxAddress}`;const address=total(sheet,item.label,{formula,result:item.value});if(item.hidden)sheet.getRow(sheet.getCell(address).row).hidden=true;if(item.kind==='subtotal')subtotalAddress=address;if(item.kind==='tax')taxAddress=address;if(item.kind==='gross')grossAddress=address;if(item.kind==='discount')discountAddress=address;summary.push({label:item.label,address,ref:"'"+sheet.name.replaceAll("'","''")+"'!"+address,value:item.value,hidden:item.hidden});}
 }
 if(sections.length===1)wide(sheet,(model.completeness.canFinalize?'合计大写：':'已计价部分大写：')+model.amountInWords,'subtotal');
 const scopeNotes=sections.length===1?(model.pricingNotes||[]):section.chapters.flatMap(ch=>ch.rows.filter(r=>r.pricingNotes?.length).map(r=>r.code+' '+r.name+'：'+r.pricingNotes.join('；')));for(const note of [...scopeNotes,...(model.deliveryNotes||[])])wide(sheet,note);
 }
 wide(cover,model.supplier,'title');wide(cover,(model.title||'项目')+'报价汇总','title');wide(cover,'购方：'+(model.customer||'')+'　日期：'+(model.date||''));
 for(const item of summary){const address=total(cover,item.label,{formula:item.ref,result:item.value});if(item.hidden)cover.getRow(cover.getCell(address).row).hidden=true;}
 if(sections.length>1){let net,tax,gross,discount;for(const item of model.totals){const formula=item.kind==='gross'?'SUM('+chapterAddresses.join(',')+')':item.kind==='discount'?String(item.value):item.kind==='subtotal'?gross?gross+'+'+discount:'SUM('+chapterAddresses.join(',')+')':item.kind==='tax'?`ROUND(${net}*${Number(result.quote.taxRate||0)}/100,2)`:net+'+'+tax;const address=total(cover,item.label,{formula,result:item.value});if(item.hidden)cover.getRow(cover.getCell(address).row).hidden=true;if(item.kind==='gross')gross=address;if(item.kind==='discount')discount=address;if(item.kind==='subtotal')net=address;if(item.kind==='tax')tax=address;}}
 wide(cover,'大写金额：'+model.amountInWords,'subtotal');if(model.notes)wide(cover,model.notes);for(const note of model.deliveryNotes||[])wide(cover,note);wide(cover,'购方签署：________________　供方签署：________________');
 for(const target of [cover,...sheets])target.pageSetup.printArea='A1:'+target.getCell(target.rowCount,count).address;
 const CFB=root.XLSX.CFB,zip=CFB.read(new Uint8Array(await book.xlsx.writeBuffer({useSharedStrings:false})),{type:'array'});root.QuoteExporter.inlineStrings(zip,CFB);
 return new Blob([CFB.write(zip,{type:'array',fileType:'zip',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
root.QuoteBusinessExporter={excel};if(typeof module!=='undefined'&&module.exports)module.exports=root.QuoteBusinessExporter;
})(typeof window!=='undefined'?window:globalThis);
