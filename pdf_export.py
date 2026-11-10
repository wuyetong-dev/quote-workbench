"""Render the shared export plan without repeating the first-page letterhead."""
import io
import re
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from export_layout import CONFIG, PDF, plan


def pdf_bytes(result):
    layout = plan(result)
    buf = io.BytesIO()
    c = Canvas(buf,pagesize=(PDF['width'],PDF['height']))
    c.setTitle(PDF['title'])
    c.setAuthor(CONFIG['company'])
    font, size, leading, padding = 'QuoteSong', PDF['fontSize'], PDF['leading'], PDF['padding']
    left = PDF['left']
    width = PDF['width']-left-PDF['right']

    def text(value,x,top,font_size=size,align='left',bold=False):
        c.setFont(font,font_size)
        # Ascent-based positioning keeps text inside its measured cell padding.
        baseline=PDF['height']-top-pdfmetrics.getAscent(font)*font_size/1000
        if bold:
            c.saveState();c.setLineWidth(.15)
            t=c.beginText();t.setFont(font,font_size);t.setTextOrigin(x,baseline);t.setTextRenderMode(2);t.textOut(str(value));c.drawText(t);c.restoreState()
        elif align=='right':
            c.drawRightString(x,baseline,str(value))
        elif align=='center':
            c.drawCentredString(x,baseline,str(value))
        else:
            c.drawString(x,baseline,str(value))

    def rect(x,top,w,h):
        c.rect(x,PDF['height']-top-h,w,h,stroke=1,fill=0)

    def reference_value(value,x,baseline,date=False):
        # Source PDF uses fill+stroke Song text and explicit glyph advances.
        c.saveState();c.setLineWidth(.295152)
        value=str(value);spacing=[.129 if ord(ch)<128 else .086 for ch in value]
        m=re.fullmatch(r'(\d{4})年(\d{1,2})月(\d{1,2})日',value) if date else None
        if m:
            spacing=[.086,.086,.086,0,.086]+[.086]*(len(m[2])-1)+[.129,.129]+[.086]*(len(m[3])-1)+[.043,0]
        for ch,gap in zip(value,spacing):
            t=c.beginText();t.setFont(font,10.32);t.setTextOrigin(x,PDF['height']-baseline);t.setTextRenderMode(2);t.textOut(ch);c.drawText(t)
            x+=pdfmetrics.stringWidth(ch,font,10.32)+gap
        c.restoreState()

    for page_index, blocks in enumerate(layout['pages']):
        if page_index:
            c.showPage()
        c.setLineWidth(.5)
        for b in blocks:
            y,h=b['y'],b['height']
            if b['type']=='firstHeader':
                # Only variable values are typeset here. The four fixed source
                # strips are composited as original PDF vectors below.
                reference_value(b['date'],104.275,y-50+140.438,date=True)
                for i,line in enumerate(b['customerLines']):
                    reference_value(line,104.06,y-50+158.584+i*leading)
            elif b['type'] in ('columns','item'):
                x=left
                for i,w in enumerate(PDF['columnWidths']):
                    rect(x,y,w,h)
                    cell=[b['cells'][i]] if b['type']=='columns' else b['cells'][i]
                    fs=size if b['type']=='columns' else b['sizes'][i]
                    cy=y+(h-len(cell)*leading)/2
                    for line in cell:
                        align='center' if b['type']=='columns' else 'right' if i>=4 else 'left'
                        tx=x+w/2 if align=='center' else x+w-padding if align=='right' else x+padding
                        text(line,tx,cy,fs,align)
                        cy+=leading
                    x+=w
            elif b['type'] in ('group','subgroup'):
                rect(left,y,width,h)
                for i,line in enumerate(b['lines']):
                    text(line,left+padding,y+padding+i*leading,bold=True)
            elif b['type'] in ('total', 'sectionTotal'):
                split=sum(PDF['columnWidths'][:4])
                rect(left,y,split,h);rect(left+split,y,width-split,h)
                text(b['label'],left+split/2,y+(h-leading)/2,size,'center')
                text(b['value'],left+width-padding,y+(h-leading)/2,size,'right')
            elif b['type']=='note':
                c.line(left,PDF['height']-y,left,PDF['height']-y-h)
                c.line(left+width,PDF['height']-y,left+width,PDF['height']-y-h)
                if b['first'] or b is blocks[0]:
                    c.line(left,PDF['height']-y,left+width,PDF['height']-y)
                if b['last'] or b is blocks[-1]:
                    c.line(left,PDF['height']-y-h,left+width,PDF['height']-y-h)
                text(b['lines'][0],left+padding,y+(padding if b['first'] else 0))
            elif b['type']=='signature':
                pass
    c.save()
    import pymupdf
    assets=Path(__file__).parent/'web/assets'
    header_path=assets/'pdf-header-reference.pdf'
    footer_path=assets/'pdf-footer-reference.pdf'
    # 页眉/页脚叠加件是使用方自备的模板（内含企业抬头），开源版不提供。
    # 缺失时跳过叠加，仅输出文字版报价单。
    if not (header_path.exists() and footer_path.exists()):
        with pymupdf.open(stream=buf.getvalue(),filetype='pdf') as output:
            return output.tobytes(garbage=4,deflate=True)
    with pymupdf.open(stream=buf.getvalue(),filetype='pdf') as output,pymupdf.open(header_path) as header,pymupdf.open(footer_path) as footer:
        for page,blocks in zip(output,layout['pages']):
            for b in blocks:
                if b['type']=='firstHeader':
                    for i,offset in enumerate([0,79,96.4,114.6+b['customerExtra']]):
                        top=b['y']+offset
                        page.show_pdf_page(pymupdf.Rect(left,top,left+width,top+header[i].rect.height),header,i,overlay=False)
                elif b['type']=='signature':
                    page.show_pdf_page(pymupdf.Rect(left,b['y'],left+width,b['y']+b['height']),footer,0,overlay=False)
        return output.tobytes(garbage=4,deflate=True)
