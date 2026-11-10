"""Fill original quotation shells; retain their OOXML, art and fixed terms.

Sources: versioned customer templates + existing prepared business quotation.
Consumer: existing Excel download. This module never computes a unit price.
Unknown/empty profiles fail explicitly; an empty quote never exports old rows.
"""
import copy
import io
import json
import math
import posixpath
import re
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as E

ROOT = Path(__file__).parent
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
XD = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
VERSION = '2026-11-09.reference-excel.2'
MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
def tag(name): return '{'+S+'}'+name
def profiles(): return json.loads((ROOT/'web/assets/customer-templates/profiles.json').read_text('utf-8'))

def select_profile(quote, kind='business'):
    candidates=[p for p in profiles() if p['kind']==kind]
    explicit=quote.get('exportTemplateId')
    if explicit=='custom' and kind=='business': return None
    if explicit:
        found=next((p for p in candidates if p['id']==explicit),None)
        if found:return found
        if kind=='business' and explicit not in {p['id'] for p in profiles()}:raise ValueError('报价原稿格式不存在，请重新选择')
    origins=[quote.get('origin',{}),*(r.get('entryEvidence',{}).get('origin',{}) for r in quote.get('rows',[])),*(quote.get('sources') or [])]
    votes=Counter()
    for o in origins:
        for p in candidates:
            if o.get('sha256')==p.get('sha256') or o.get('filename')==p.get('sourceName'):votes[p['id']]+=1
    return max(candidates,key=lambda p:votes[p['id']]) if votes else next((p for p in candidates if p.get('default')),candidates[0])

def serialize(root, original=None):
    namespaces={}
    if original:
        for _,pair in E.iterparse(io.BytesIO(original),events=['start-ns']):namespaces[pair[0]]=pair[1]
    namespace=root.tag.split('}')[0][1:]
    for prefix,url in namespaces.items():
        if prefix and not re.fullmatch(r'ns\d+',prefix):E.register_namespace(prefix,url)
    E.register_namespace('',namespace);E.register_namespace('r',R)
    out=E.tostring(root,encoding='unicode')
    end=out.index('>');head=out[:end]
    for prefix,url in namespaces.items():
        if prefix and ('xmlns:'+prefix+'=') not in head:head+=' xmlns:'+prefix+'="'+url+'"'
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+head+out[end:]).encode('utf-8')

def colnum(name):
    value=0
    for c in name:value=value*26+ord(c)-64
    return value
def letter(n):
    out=''
    while n:n,k=divmod(n-1,26);out=chr(65+k)+out
    return out
def shift_ref(ref, delta):return re.sub(r'(\$?[A-Z]+\$?)(\d+)',lambda m:m[1]+str(int(m[2])+delta),ref)
def date_text(value):
    m=re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})',str(value or ''))
    return f'{m[1]}年{int(m[2])}月{int(m[3])}日' if m else str(value or '')

class Shell:
    def __init__(self, profile):
        self.profile=profile
        with zipfile.ZipFile(ROOT/'web/assets'/profile['asset']) as z:self.parts={n:z.read(n) for n in z.namelist() if not n.endswith('/')}
        self.wb=E.fromstring(self.parts['xl/workbook.xml']);self.rels=E.fromstring(self.parts['xl/_rels/workbook.xml.rels']);self.types=E.fromstring(self.parts['[Content_Types].xml'])
        self.strings=list(E.fromstring(self.parts['xl/sharedStrings.xml'])) if 'xl/sharedStrings.xml'in self.parts else []
        self.styles=E.fromstring(self.parts['xl/styles.xml']);self.style_cache={}
        rels={r.attrib['Id']:r.attrib['Target'] for r in self.rels}
        self.sources={s.attrib['name']:posixpath.normpath(rels[s.attrib['{'+R+'}id']].lstrip('/') if rels[s.attrib['{'+R+'}id']].startswith('/') else 'xl/'+rels[s.attrib['{'+R+'}id']]) for s in self.wb.find(tag('sheets'))}
        self.outputs=[];self.audit=[]
    def text(self,c):
        if c is None:return ''
        if c.attrib.get('t')=='s':return ''.join(self.strings[int(c.find(tag('v')).text)].itertext())
        if c.attrib.get('t')=='inlineStr':return ''.join(c.find(tag('is')).itertext())
        v=c.find(tag('v'));return v.text if v is not None else ''
    def style(self, source, column, plain=False, **align):
        c=source.find(tag('c')+"[@r='"+column+source.attrib['r']+"']") if source is not None else None
        old=int(c.attrib.get('s','0')) if c is not None else 0
        key=(old,plain,tuple(sorted(align.items())))
        if key not in self.style_cache:
            xfs=self.styles.find(tag('cellXfs'));xf=copy.deepcopy(xfs[old]);a=xf.find(tag('alignment'))
            if plain:xf.attrib.update(borderId='0',fillId='0',numFmtId='0',applyBorder='1',applyFill='1',applyNumberFormat='1')
            if a is None:a=E.SubElement(xf,tag('alignment'))
            a.attrib.update({'vertical':'center','wrapText':'1',**{k:str(v) for k,v in align.items()}});xf.attrib['applyAlignment']='1'
            xfs.append(xf);xfs.attrib['count']=str(len(xfs));self.style_cache[key]=len(xfs)-1
        return self.style_cache[key]
    def cell(self,row,column,value=None,style=None,formula=None):
        address=column+row.attrib['r'];old=row.find(tag('c')+"[@r='"+address+"']")
        if old is not None:row.remove(old)
        c=E.SubElement(row,tag('c'),r=address)
        if style is not None:c.attrib['s']=str(style)
        elif old is not None and 's'in old.attrib:c.attrib['s']=old.attrib['s']
        if formula is not None:E.SubElement(c,tag('f')).text=formula
        if isinstance(value,(int,float)) and not isinstance(value,bool):E.SubElement(c,tag('v')).text=str(value)
        elif value is not None:
            c.attrib['t']='inlineStr';E.SubElement(E.SubElement(c,tag('is')),tag('t'),{'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text=str(value)
        return c
    def sheet(self,source,name):
        path=self.sources[source];doc=E.fromstring(self.parts[path]);oldrows={int(r.attrib['r']):copy.deepcopy(r) for r in doc.find(tag('sheetData'))}
        oldmerges=[c.attrib['ref'] for c in doc.findall(tag('mergeCells')+'/'+tag('mergeCell'))]
        for row in list(doc.find(tag('sheetData'))):doc.find(tag('sheetData')).remove(row)
        merges=doc.find(tag('mergeCells'))
        if merges is not None:doc.remove(merges)
        for key in ['rowBreaks','colBreaks','autoFilter']:
            for node in doc.findall(tag(key)):doc.remove(node)
        out={'name':name,'doc':doc,'source':path,'rows':oldrows,'merges':oldmerges,'newmerges':[],'at':1,'relocs':[]}
        self.outputs.append(out);return out
    def append(self,out,source=None,values=None,height=None):
        at=out['at'];r=copy.deepcopy(out['rows'][source]) if source in out['rows'] else E.Element(tag('row'))
        delta=at-int(r.attrib.get('r',at));r.attrib['r']=str(at);r.attrib.pop('spans',None)
        for c in list(r):
            c.attrib['r']=shift_ref(c.attrib['r'],delta)
            f=c.find(tag('f'))
            if f is not None:
                # Copied fixed shells never retain source financial formulas.
                r.remove(c);continue
        if height is not None:r.attrib.update(ht=str(min(409,height)),customHeight='1')
        if values is not None:
            for c in list(r):r.remove(c)
            # Empty cells still carry the original grid, including the outer
            # edge of blank remarks and merged specifications/notes.
            for c in out['rows'].get(source,[]):
                column=re.match(r'[A-Z]+',c.attrib['r'])[0]
                if colnum(column)<=colnum(out['lastcol']):self.cell(r,column,None,self.style(out['rows'][source],column))
            for column,value in values.items():self.cell(r,column,value,self.style(out['rows'].get(source),column))
        out['doc'].find(tag('sheetData')).append(r);out['at']+=1;return r
    def fixed(self,out,start,end):
        target=out['at'];delta=target-start
        for n in range(start,end+1):self.append(out,n)
        for ref in out['merges']:
            nums=list(map(int,re.findall(r'\d+',ref)))
            if min(nums)>=start and max(nums)<=end:out['newmerges'].append(shift_ref(ref,delta))
        out['relocs'].append((start,end,delta))
    def merge(self,out,start,c1,end,c2):
        if (start,c1)!=(end,c2):out['newmerges'].append(f'{c1}{start}:{c2}{end}')
    def wide(self,out,text,source=3,width=90):
        if out.get('plainNotes'):width=min(width,82)
        for chunk,lines in chunks(text,width):
            r=self.append(out,source,{'A':chunk},max(22,lines*15+8))
            if out.get('plainNotes'):
                for c in list(r):
                    column=re.match(r'[A-Z]+',c.attrib['r'])[0]
                    self.cell(r,column,chunk if column=='A' else None,self.style(out['rows'].get(source),column,plain=True,horizontal='left'))
            self.merge(out,int(r.attrib['r']),'A',int(r.attrib['r']),out['lastcol'])
    def finish(self):
        sheets=self.wb.find(tag('sheets'));sheets.clear()
        for r in list(self.rels):
            if r.attrib['Type'].endswith(('/worksheet','/calcChain','/sharedStrings')):self.rels.remove(r)
        for key in list(self.parts):
            if re.fullmatch(r'xl/worksheets/(?:_rels/)?sheet\d+\.xml(?:\.rels)?',key) or key in ('xl/calcChain.xml','xl/sharedStrings.xml'):del self.parts[key]
        for node in list(self.types):
            if node.attrib.get('PartName','').startswith('/xl/worksheets/') or node.attrib.get('PartName')in('/xl/calcChain.xml','/xl/sharedStrings.xml'):self.types.remove(node)
        oldnames=self.wb.find(tag('definedNames'))
        if oldnames is not None:self.wb.remove(oldnames)
        names=E.Element(tag('definedNames'));self.wb.insert(list(self.wb).index(sheets)+1,names)
        for i,out in enumerate(self.outputs,1):
            doc=out['doc'];data=doc.find(tag('sheetData'))
            properties=doc.find(tag('sheetPr'))
            if properties is None:properties=E.Element(tag('sheetPr'));doc.insert(0,properties)
            print_properties=properties.find(tag('pageSetUpPr'))
            if print_properties is None:print_properties=E.SubElement(properties,tag('pageSetUpPr'))
            print_properties.set('fitToPage','1')
            setup=doc.find(tag('pageSetup'))
            if setup is None:setup=E.SubElement(doc,tag('pageSetup'))
            setup.attrib.update(fitToWidth='1',fitToHeight='0');setup.attrib.pop('scale',None)
            for footer in doc.findall(tag('headerFooter')+'/*'):
                value=footer.text or ''
                q=out.get('quote',{})
                value=re.sub(r'(日期[：:]\s*)\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?',lambda m:m[1]+str(q.get('date','')),value)
                footer.text=re.sub(r'(项目名称[：:]\s*)[^\r\n&]*',lambda m:m[1]+str(q.get('title',out['name'])),value)
            for selection in doc.findall('.//'+tag('selection')):selection.attrib.update(activeCell='A1',sqref='A1')
            for r in data:
                for c in r:
                    if c.attrib.get('t')=='s':
                        si=self.strings[int(c.find(tag('v')).text)];c.remove(c.find(tag('v')));c.attrib['t']='inlineStr';inline=E.SubElement(c,tag('is'))
                        inline.extend(copy.deepcopy(list(si)))
                r[:]=sorted(r,key=lambda c:colnum(re.match(r'[A-Z]+',c.attrib['r'])[0]))
            dim=doc.find(tag('dimension'))
            if dim is not None:dim.attrib['ref']='A1:'+out['lastcol']+str(out['at']-1)
            if out['newmerges']:
                m=E.Element(tag('mergeCells'),count=str(len(out['newmerges'])))
                for ref in out['newmerges']:E.SubElement(m,tag('mergeCell'),ref=ref)
                doc.insert(list(doc).index(data)+1,m)
            escaped=out['name'].replace("'","''")
            E.SubElement(names,tag('definedName'),name='_xlnm.Print_Area',localSheetId=str(i-1)).text=f"'{escaped}'!$A$1:${out['lastcol']}${out['at']-1}"
            if out.get('repeat'):E.SubElement(names,tag('definedName'),name='_xlnm.Print_Titles',localSheetId=str(i-1)).text=f"'{escaped}'!${out['repeat']}:${out['repeat']}"
            path=f'xl/worksheets/sheet{i}.xml';rid='rIdHJ'+str(i)
            E.SubElement(sheets,tag('sheet'),name=out['name'],sheetId=str(i),attrib={'{'+R+'}id':rid})
            E.SubElement(self.rels,'{'+P+'}Relationship',Id=rid,Type=R+'/worksheet',Target='worksheets/sheet'+str(i)+'.xml')
            E.SubElement(self.types,'{'+CT+'}Override',PartName='/'+path,ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml')
            relsource=posixpath.dirname(out['source'])+'/_rels/'+posixpath.basename(out['source'])+'.rels'
            if out.get('relationships') is not None:self.parts[f'xl/worksheets/_rels/sheet{i}.xml.rels']=serialize(out['relationships'])
            elif relsource in self.original_parts:
                relationships=E.fromstring(self.original_parts[relsource])
                for relation in relationships:
                    if not relation.get('Type','').endswith('/drawing'):continue
                    source=posixpath.normpath(posixpath.join(posixpath.dirname(out['source']),relation.get('Target')))
                    if source not in self.original_parts:continue
                    drawing=E.fromstring(self.original_parts[source])
                    for anchor in drawing:
                        for marker in list(anchor):
                            if marker.tag not in ('{'+XD+'}from','{'+XD+'}to'):continue
                            row=marker.find('{'+XD+'}row')
                            if row is None:continue
                            original=int(row.text)+1
                            move=next((delta for start,end,delta in reversed(out['relocs']) if start<=original<=end),0)
                            row.text=str(int(row.text)+move)
                    target=f'xl/drawings/hj-reference-{i}.xml'
                    self.parts[target]=serialize(drawing,self.original_parts[source]);relation.set('Target','../drawings/'+posixpath.basename(target))
                    source_rels=posixpath.dirname(source)+'/_rels/'+posixpath.basename(source)+'.rels'
                    if source_rels in self.original_parts:self.parts['xl/drawings/_rels/'+posixpath.basename(target)+'.rels']=self.original_parts[source_rels]
                    E.SubElement(self.types,'{'+CT+'}Override',PartName='/'+target,ContentType='application/vnd.openxmlformats-officedocument.drawing+xml')
                self.parts[f'xl/worksheets/_rels/sheet{i}.xml.rels']=serialize(relationships)
            order=['sheetPr','dimension','sheetViews','sheetFormatPr','cols','sheetData','sheetCalcPr','sheetProtection','protectedRanges','scenarios','autoFilter','sortState','dataConsolidate','customSheetViews','mergeCells','phoneticPr','conditionalFormatting','dataValidations','hyperlinks','printOptions','pageMargins','pageSetup','headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst']
            doc[:]=sorted(doc,key=lambda n:order.index(n.tag.split('}')[-1]) if n.tag.split('}')[-1] in order else len(order))
            self.parts[path]=serialize(doc,self.original_parts[out['source']])
        calc=self.wb.find(tag('calcPr'))
        if calc is None:calc=E.SubElement(self.wb,tag('calcPr'))
        calc.attrib.update(fullCalcOnLoad='1',forceFullCalc='1')
        self.parts['xl/workbook.xml']=serialize(self.wb,self.parts['xl/workbook.xml']);self.parts['xl/_rels/workbook.xml.rels']=serialize(self.rels)
        self.parts['xl/styles.xml']=serialize(self.styles,self.parts['xl/styles.xml']);self.parts['[Content_Types].xml']=serialize(self.types)
        output=io.BytesIO()
        with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
            for name,value in self.parts.items():z.writestr(name,value)
        return output.getvalue()

def chunks(text,width,maxlines=23):
    """Soft-wrap for measuring only: stored text is never shortened or reflowed."""
    segments=[];current='';used=0;lines=1
    for ch in str(text or ''):
        size=2 if ord(ch)>255 else 1
        new=ch=='\n' or used+size>width
        if new:
            if lines>=maxlines:
                segments.append((current,lines));current='';used=0;lines=1
            else:lines+=1;used=0
        current+=ch
        if ch!='\n':used+=size
    if current or not segments:segments.append((current,lines))
    return segments

def complete_sections(model,quote):
    sections=copy.deepcopy(model.get('sections') or [{'title':model['title'],'chapters':model['chapters']}])
    emitted={r['id'] for s in sections for c in s['chapters'] for r in c['rows']}
    from formula_engine import is_requirement
    for row in quote['rows']:
        excluded=any(re.search(r'单价|金额',str(f.get('label',''))) and re.search(r'不含|自备|另计',str(f.get('value',''))) for f in row.get('fields',[])) and row.get('selected') is False
        if row.get('id') in emitted or not (is_requirement(row) or excluded):continue
        from condition_binding import resolved
        if not excluded and resolved(row,quote['rows']):continue
        if not sections:sections=[{'title':quote['title'],'chapters':[]}]
        ch=next((c for s in sections for c in s['chapters'] if any(r['id'] in {row.get('parentId'),(row.get('bom') or {}).get('parentId')} for r in c['rows'])),None)
        if ch is None:
            if not sections[-1]['chapters']:sections[-1]['chapters'].append({'chapterTitle':'原表要求','rows':[],'subtotal':0})
            ch=sections[-1]['chapters'][-1]
        ch['rows'].append({'id':row['id'],'type':'excluded' if excluded else 'pending','billing':'excluded' if excluded else 'pending','name':row.get('name',''),'spec':row.get('spec',''),'description':row.get('name','')+'\n'+row.get('spec',''),'quantity':row.get('quantity') if excluded else None,'unitPrice':None,'amount':None,'unit':row.get('unit',''),'depth':0,'code':''})
    return sections

def body(shell,out,chapters,quote,layout):
    raw={r['id']:r for r in quote['rows']};mapping=[];chapter_sums=[]
    columns=layout['columns'];last=layout['lastColumn'];out['lastcol']=last
    def text_parts(text,field):
        column=columns[field];number=colnum(column)
        width=next((float(c.get('width','9')) for c in out['doc'].find(tag('cols')) if int(c.get('min'))<=number<=int(c.get('max'))),9)
        source=out['rows'].get(layout['itemStyle']);cell=source.find(tag('c')+"[@r='"+column+source.get('r')+"']") if source is not None else None
        xf=shell.styles.find(tag('cellXfs'))[int(cell.get('s','0')) if cell is not None else 0]
        font=shell.styles.find(tag('fonts'))[int(xf.get('fontId','0'))];size=font.find(tag('sz'));size=float(size.get('val','11')) if size is not None else 11
        return chunks(text,max(6,int(((width*7+5)*.75-8)/(size*.56))))
    for ch in chapters:
        shell.wide(out,ch['chapterTitle'],layout['chapterStyle'],layout.get('width',90))
        amounts=[];groups={}
        for item in ch['rows']:
            r=raw.get(item['id'],{});name=str(r.get('name',item.get('name','')));spec=str(r.get('spec',item.get('spec','')) or '')
            for requirement in r.get('engineeringRequirements',[]):
                text=str(requirement.get('text') or '').strip()
                if text and text not in spec:spec+=('\n' if spec else '')+text
            if item.get('type')=='note':spec=item.get('description','');name=''
            if r.get('quoteRemark'):spec+=('\n' if spec else '')+str(r['quoteRemark'])
            if item.get('layoutNote'):spec+='\n'+item['layoutNote']
            if item.get('type')=='pending':spec+='\n供货范围待确认，未计入金额'
            brand=str(r.get('brand') or '')
            if 'brand' not in columns and brand:spec+='\n品牌：'+brand
            if columns.get('name')==columns.get('spec'):spec=name+('\n'+spec if spec else '')
            fragments=chunks(spec,layout.get('specWidth',60));names=text_parts(name,'name') if columns.get('name')!=columns.get('spec') else [('',1)];brands=text_parts(brand,'brand') if 'brand' in columns else [('',1)]
            count=max(len(fragments),len(names),len(brands));start=out['at']
            for part in range(count):
                text,nlines=fragments[part] if part<len(fragments) else ('',1)
                name_text,name_lines=names[part] if part<len(names) else ('',1);brand_text,brand_lines=brands[part] if part<len(brands) else ('',1)
                nlines=max(nlines,name_lines,brand_lines)
                row=shell.append(out,layout['itemStyle'],{},max(24,nlines*layout.get('leading',15)+10));n=int(row.attrib['r'])
                values={'code':item.get('groupCode') or item.get('code',''),'name':name_text,'spec':text,'brand':brand_text,'quantity':item.get('quantity'),'unit':item.get('unit',''),'unitPrice':item.get('unitPrice'),'amount':item.get('amount')}
                included=item.get('billing')=='included'
                if item.get('billing')=='excluded':values.update(unitPrice='不含',amount='不计入')
                elif included:values.update(unitPrice='已含',amount='不另计')
                elif item.get('amount') is None and item.get('type') not in ('pending','note'):values['unitPrice']='待核价'
                for field,column in columns.items():
                    if column==columns.get('spec') and field=='name':continue
                    value=values[field] if part==0 or field in ('spec','name','brand') else None
                    formula=f"ROUND({columns['quantity']}{n}*{columns['unitPrice']}{n},2)" if field=='amount' and part==0 and item.get('amount') is not None else None
                    shell.cell(row,column,value,shell.style(out['rows'].get(layout['itemStyle']),column,horizontal='left' if field in ('name','spec','brand') else 'center' if field in ('code','unit') else 'right'),formula)
                for a,b in layout.get('specMerges',[]):shell.merge(out,n,a,n,b)
                if part==0 and item.get('amount') is not None:amounts.append(columns['amount']+str(n))
            end=out['at']-1;key=item.get('rootId') or item['id']
            group=groups.setdefault(key,[start,end]);group[1]=end
            if layout.get('mergeCodes') and start!=group[0]:
                shell.cell(out['doc'].find(tag('sheetData'))[-count],columns['code'],None)
            shell.audit.append({'id':item['id'],'sheet':out['name'],'start':start,'end':end,'name':name,'spec':spec,'amount':item.get('amount'),'type':item.get('type','item')})
        if layout.get('mergeCodes'):
            for start,end in groups.values():shell.merge(out,start,columns['code'],end,columns['code'])
        row=shell.append(out,layout['totalStyle'],{},26);n=int(row.attrib['r']);value=float(ch.get('subtotal') or 0)
        shell.cell(row,'A',ch['chapterTitle']+'小计',shell.style(out['rows'].get(layout['totalStyle']),'A'))
        shell.merge(out,n,'A',n,letter(colnum(columns['amount'])-1))
        address=columns['amount']+str(n);shell.cell(row,columns['amount'],value,shell.style(out['rows'].get(layout['itemStyle']),columns['amount']), 'SUM('+','.join(amounts)+')' if amounts else '0')
        chapter_sums.append((ch['chapterTitle'],address,value))
    return chapter_sums

def strip_template_notes(text):
    # Historical imports copied these fixed cells into editable notes. Remove
    # only exact text duplicates; preserve every changed/project-specific word.
    fixed=[]
    for p in profiles():
        if p['layout']=='contract':continue
        book=Shell(p);doc=E.fromstring(book.parts[next(iter(book.sources.values()))])
        minimum=382 if p['layout']=='scheme' else 18
        fixed.extend(book.text(c) for r in doc.find(tag('sheetData')) if int(r.attrib['r'])>=minimum for c in r if len(book.text(c).strip())>4)
    fixed.extend(json.loads((ROOT/'web/assets/export-layout.json').read_text('utf-8')).get('contractFixedNotes',[]))
    for value in sorted(fixed,key=len,reverse=True):
        positions=[i for i,c in enumerate(text) if not c.isspace()];compact=''.join(text[i] for i in positions);needle=re.sub(r'\s+','',value)
        if needle and needle in compact:
            at=compact.index(needle);text=text[:positions[at]]+text[positions[at+len(needle)-1]+1:]
    return '\n'.join(line for line in text.strip().splitlines() if line.strip() and line.strip() not in ('备注：','备注:'))

def notes(shell,out,model,style):
    for text in [strip_template_notes(model.get('notes','')),*(model.get('pricingNotes') or []),*(model.get('deliveryNotes') or [])]:
        if text:shell.wide(out,text,style)

def render(result,profile=None):
    quote=result['quote'];profile=profile or select_profile(quote)
    if not profile:raise ValueError('自定义版式请使用现有排版导出')
    model=result['businessContent'];sections=complete_sections(model,quote)
    if not any(c['rows'] for s in sections for c in s['chapters']):raise ValueError('没有可导出的本单明细')
    shell=Shell(profile);shell.original_parts=dict(shell.parts)
    if profile['layout']=='contract':return contract(shell,result,sections,profile)
    if profile['layout']=='scheme':
        cfg=profile['detail'];out=shell.sheet(cfg['sheet'],'报价单');out['quote']=quote;out['repeat']=12;out['lastcol']=cfg['lastColumn'];shell.fixed(out,1,12)
        rows=out['doc'].find(tag('sheetData'))
        for addr,value in {'A3':'项  目:'+quote.get('title',''),'A4':'客  户:'+quote.get('customer',''),'A6':'日  期:'+date_text(quote.get('date')),'A11':quote.get('title','')+'工艺流程及价格说明'}.items():shell.cell(rows[int(re.search(r'\d+',addr)[0])-1],re.match('[A-Z]+',addr)[0],value)
        sums=[]
        for section in sections:
            if len(sections)>1:shell.wide(out,section['title'],11)
            sums.extend(body(shell,out,section['chapters'],quote,cfg))
        shell.fixed(out,380,380)
        totals(shell,out,model,sums,cfg)
        notes(shell,out,model,382);shell.fixed(out,382,389)
        for r in out['doc'].find(tag('sheetData')):
            if int(r.attrib['r'])>=out['at']-3:
                for c in r:
                    text=shell.text(c)
                    if '签署日期' in text:shell.cell(r,re.match('[A-Z]+',c.attrib['r'])[0],re.sub(r'\d{4}(?=年)',str(quote.get('date',''))[:4],text))
    else:
        cover=shell.sheet(profile['cover']['sheet'],profile['cover']['sheet']);cover['quote']=quote;cover['lastcol']='G';shell.fixed(cover,1,11)
        cr=cover['doc'].find(tag('sheetData'));shell.cell(cr[1],'A',' 购方单位：'+quote.get('customer',''));shell.cell(cr[4],'B',quote.get('customerAddress',''))
        names={'合计'};references=[]
        for i,section in enumerate(sections):
            origins=Counter((r.get('entryEvidence',{}).get('origin',{}).get('sheet')) for r in quote['rows'] if any(r['id']==v['id'] for ch in section['chapters'] for v in ch['rows']))
            cfg=next((c for c in profile['details'] if origins[c['sheet']]),profile['details'][min(i,len(profile['details'])-1)])
            name=re.sub(r'[\\/*?:\[\]]',' ',section['title'])[:31] or '生产线';base=name;n=1
            while name in names:n+=1;name=base[:26]+'-'+str(n)
            names.add(name);out=shell.sheet(cfg['sheet'],name);out['quote']=quote;out['repeat']=2;out['lastcol']=cfg['lastColumn'];shell.fixed(out,1,2);shell.cell(out['doc'].find(tag('sheetData'))[0],'A',section['title']+'工艺流程及报价说明')
            sums=body(shell,out,section['chapters'],quote,cfg)
            shell.fixed(out,cfg['tailHeading'],cfg['tailHeading'])
            for n,(label,address,value) in enumerate(sums,1):
                row=shell.append(out,cfg['tailItem'],{'A':str(n),'B':label,'C':1,'D':'式','E':value,'F':value},24);rn=int(row.attrib['r']);shell.cell(row,'E',value,formula=address);shell.cell(row,'F',value,formula='C'+str(rn)+'*E'+str(rn))
            row=shell.append(out,cfg['tailTotal']);rn=int(row.attrib['r']);shell.cell(row,'E',sum(v for _,_,v in sums),formula='SUM('+','.join(a for _,a,_ in sums)+')' if sums else '0');shell.merge(out,rn,'A',rn,'D');shell.merge(out,rn,'E',rn,'F')
            out['relocs'].append((cfg['tailTotal'],1048576,rn-cfg['tailTotal']))
            notes(shell,out,model,cfg['chapterStyle']);references.append((name,'E'+str(rn),sum(v for _,_,v in sums)))
        for n,(name,address,value) in enumerate(references,1):
            row=shell.append(cover,12,{'A':str(n),'B':name,'C':1,'D':'式','E':value,'F':value},28);rn=int(row.attrib['r']);shell.cell(row,'E',value,formula="'"+name.replace("'","''")+"'!"+address);shell.cell(row,'F',value,formula=f'C{rn}*E{rn}')
        total_start=cover['at'];shell.fixed(cover,14,17)
        rs=cover['doc'].find(tag('sheetData'));by={int(r.attrib['r']):r for r in rs};net=float(result['total']);tax=float(result.get('tax',0));grand=float(result.get('grandTotal',net))
        shell.cell(by[total_start],'F',net,formula='SUM('+','.join('F'+str(12+i) for i in range(len(references)))+')'+('-'+str(result.get('discount',0)) if result.get('discount') else ''))
        shell.cell(by[total_start+1],'B','税额'+str(quote.get('taxRate',0))+'%' if quote.get('taxMode')=='excluded' else '税额（不另计）');shell.cell(by[total_start+1],'E',tax,formula='ROUND(F'+str(total_start)+'*'+str(quote.get('taxRate',0) if quote.get('taxMode')=='excluded' else 0)+'/100,2)');shell.cell(by[total_start+1],'G','')
        shell.cell(by[total_start+2],'F',grand,formula=f'F{total_start}+E{total_start+1}');shell.cell(by[total_start+3],'E',model['amountInWords'])
        notes(shell,cover,model,18);shell.fixed(cover,18,23)
        # The original blank row is the editable order date; never retain the old buyer address.
        for r in cover['doc'].find(tag('sheetData')):
            if int(r.attrib['r'])==cover['at']-5:shell.cell(r,'A','日期：'+date_text(quote.get('date')))
    return shell.finish(),{'profile':profile['id'],'rows':shell.audit}

def totals(shell,out,model,sums,cfg):
    addresses=[a for _,a,_ in sums];net=tax=gross=discount=None
    for item in model['totals']:
        row=shell.append(out,cfg['totalStyle'],{},26);n=int(row.attrib['r']);col=cfg.get('totalAmount',cfg['columns']['amount']);shell.cell(row,'B',item['label']);shell.merge(out,n,'B',n,letter(colnum(col)-1));address=col+str(n)
        if cfg.get('totalAmountEnd'):shell.merge(out,n,col,n,cfg['totalAmountEnd'])
        formula='SUM('+','.join(addresses)+')' if addresses else '0'
        if item['kind']=='discount':formula=str(item['value']);discount=address
        elif item['kind']=='gross':gross=address
        elif item['kind']=='subtotal':formula=gross+'+'+discount if gross else formula;net=address
        elif item['kind']=='tax':formula=str(item['value']);tax=address
        elif item['kind']=='grandTotal':formula=net+'+'+tax
        shell.cell(row,col,item['value'],formula=formula)
        if item.get('hidden'):row.attrib['hidden']='1'
    shell.wide(out,'合计金额大写：'+model['amountInWords'],cfg['totalStyle'])

def contract(shell,result,sections,profile):
    quote=result['quote'];model=result['businessContent'];cfg=profile['detail'];out=shell.sheet(cfg['sheet'],'合同报价单');out['quote']=quote;out['repeat']=5;out['plainNotes']=True;out['lastcol']='G'
    doc=out['doc'];cols=doc.find(tag('cols'));cols.clear()
    for i,points in enumerate([58,79,169,36,40,49,61],1):E.SubElement(cols,tag('col'),min=str(i),max=str(i),width=str((points/.75-5)/7),customWidth='1')
    setup=doc.find(tag('pageSetup'));setup.attrib.update(paperSize='9',scale='100',fitToWidth='1',fitToHeight='0');setup.attrib.pop('orientation',None)
    margins=doc.find(tag('pageMargins'));margins.attrib.update(left=str(50/72),right=str(53/72),top=str(48/72),bottom=str(48/72))
    for node in list(doc.findall(tag('drawing'))):doc.remove(node)
    shell.append(out,None,{},80)
    for value in ['日　期：'+date_text(quote.get('date')),'客户名称：'+quote.get('customer',''),'报价人：'+str(quote.get('quoteContact') or '')]:shell.wide(out,value,15)
    row=shell.append(out,12,{},28)
    for column,label in zip('ABCDEFG',['序号','产品名称','规格mm','数量','单位','单价\n(元)','金额\n(元)']):shell.cell(row,column,label,shell.style(out['rows'][12],'B',horizontal='center'))
    sums=[]
    for section in sections:
        if len(sections)>1:shell.wide(out,section['title'],13)
        sums.extend(body(shell,out,section['chapters'],quote,cfg))
    totals(shell,out,model,sums,cfg);notes(shell,out,model,15)
    fixed=json.loads((ROOT/'web/assets/export-layout.json').read_text('utf-8'))['contractFixedNotes']
    for line in fixed:shell.wide(out,line,15,100)
    footer_row=out['at'];shell.append(out,None,{},101)
    drawing=E.Element('{'+XD+'}wsDr');rels=E.Element('{'+P+'}Relationships')
    for i,(asset,rownum,height) in enumerate([(profile['header'],1,80),(profile['footer'],footer_row,101)],1):
        anchor=E.SubElement(drawing,'{'+XD+'}oneCellAnchor');origin=E.SubElement(anchor,'{'+XD+'}from')
        for key,val in [('col',0),('colOff',0),('row',rownum-1),('rowOff',0)]:E.SubElement(origin,'{'+XD+'}'+key).text=str(val)
        E.SubElement(anchor,'{'+XD+'}ext',cx=str(492*12700),cy=str(height*12700));pic=E.SubElement(anchor,'{'+XD+'}pic');nv=E.SubElement(pic,'{'+XD+'}nvPicPr')
        E.SubElement(nv,'{'+XD+'}cNvPr',id=str(i),name='原稿固定表头' if i==1 else '原稿固定签章');E.SubElement(nv,'{'+XD+'}cNvPicPr')
        fill=E.SubElement(pic,'{'+XD+'}blipFill');E.SubElement(fill,'{'+A+'}blip',attrib={'{'+R+'}embed':'rIdArt'+str(i)});stretch=E.SubElement(fill,'{'+A+'}stretch');E.SubElement(stretch,'{'+A+'}fillRect')
        sp=E.SubElement(pic,'{'+XD+'}spPr');geometry=E.SubElement(sp,'{'+A+'}prstGeom',prst='rect');E.SubElement(geometry,'{'+A+'}avLst');E.SubElement(anchor,'{'+XD+'}clientData')
        filename='hj-contract-'+str(i)+'.png';shell.parts['xl/media/'+filename]=(ROOT/'web/assets'/asset).read_bytes()
        E.SubElement(rels,'{'+P+'}Relationship',Id='rIdArt'+str(i),Type=R+'/image',Target='../media/'+filename)
    shell.parts['xl/drawings/hj-contract.xml']=serialize(drawing);shell.parts['xl/drawings/_rels/hj-contract.xml.rels']=serialize(rels)
    out['relationships']=E.Element('{'+P+'}Relationships');E.SubElement(out['relationships'],'{'+P+'}Relationship',Id='rIdFixedArt',Type=R+'/drawing',Target='../drawings/hj-contract.xml')
    E.SubElement(doc,tag('drawing'),attrib={'{'+R+'}id':'rIdFixedArt'})
    E.SubElement(shell.types,'{'+CT+'}Override',PartName='/xl/drawings/hj-contract.xml',ContentType='application/vnd.openxmlformats-officedocument.drawing+xml')
    if not any(n.attrib.get('Extension')=='png' for n in shell.types):E.SubElement(shell.types,'{'+CT+'}Default',Extension='png',ContentType='image/png')
    return shell.finish(),{'profile':profile['id'],'rows':shell.audit}
