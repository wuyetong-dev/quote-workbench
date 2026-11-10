"""Render the same editable quotation view consumed by Excel and the preview."""
import io
from xml.sax.saxutils import escape


def render(model, font):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, TableStyle
    cfg = model['exportConfig']; cols = [c for c in cfg['columns'] if c.get('visible', True)]
    keys = [c['key'] for c in cols]; count = len(cols); description = keys.index('description'); amount = keys.index('amount')
    output = io.BytesIO(); page = landscape(A4) if cfg['workbook']['page']['orientation'] == 'landscape' else A4
    doc = SimpleDocTemplate(output, pagesize=page, leftMargin=26, rightMargin=26, topMargin=28, bottomMargin=28, title=model['title'] + '报价单')
    size = cfg['styles']['base']['font']['size']; base = ParagraphStyle('quotation', fontName=font, fontSize=size, leading=size+4, wordWrap='CJK')
    styles = {a: ParagraphStyle(a, parent=base, alignment=v) for a, v in [('left', TA_LEFT), ('center', TA_CENTER), ('right', TA_RIGHT)]}
    title = ParagraphStyle('title', parent=base, fontSize=16, leading=22, alignment=TA_CENTER)
    p = lambda value, align='left': Paragraph(escape(str(value if value is not None else '')).replace('\n', '<br/>'), styles[align])
    money = lambda value: '' if value is None else f'{value:,.2f}'
    widths = [(page[0]-52)*c['width']/sum(c['width'] for c in cols) for c in cols]
    story = [Paragraph(escape(model['supplier']), title), Paragraph(escape(model['title'] + '报价单'), title), Spacer(1, 10), p('购方：'+model['customer']+'　日期：'+model['date']), Spacer(1, 10)]
    sections = model.get('sections') or [{'title': '', 'chapters': model['chapters']}]
    for section in sections:
        if len(sections) > 1:
            story.extend([Spacer(1, 12), Paragraph(escape(section['title']), title), Spacer(1, 8)])
        data = [[p(c['label'], 'center') for c in cols]]
        commands = [('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5), ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#'+cfg['styles']['columnHeader']['fill']))]
        if cfg['styles']['base']['border']['edges'] != 'none':
            commands.append(('GRID', (0, 0), (-1, -1), .4, colors.HexColor('#'+cfg['styles']['base']['border']['color'])))
        def total(label, value):
            row = ['']*count; start = 1 if amount == 0 else 0; end = count-1 if amount == 0 else amount-1
            row[start] = p(label); row[amount] = p(money(value), 'right'); index = len(data); data.append(row)
            if end > start:
                commands.append(('SPAN', (start, index), (end, index)))
            commands.append(('BACKGROUND', (0, index), (-1, index), colors.HexColor('#'+cfg['styles']['subtotal']['fill'])))
        for chapter in section['chapters']:
            index = len(data); data.append([p(chapter['chapterTitle'])]+['']*(count-1)); commands.append(('SPAN', (0, index), (-1, index)))
            groups = {}
            for item in chapter['rows']:
                desc = item['description']
                if 'name' in keys and desc.startswith(item['name']+'\n'):
                    desc = desc[len(item['name'])+1:]
                pending = [p(desc)]; fragments = []
                while pending:
                    part = pending.pop(0)
                    if part.wrap(widths[description]-10, 100000)[1] > doc.height-80:
                        pieces = part.split(widths[description]-10, doc.height-80)
                        if len(pieces) < 2:
                            raise ValueError('配置说明无法分页，请检查内容')
                        pending[0:0] = pieces
                    else:
                        fragments.append(part)
                for fragment_index, fragment in enumerate(fragments):
                    values = []
                    for col in cols:
                        key = col['key']; value = item.get(key, '') if fragment_index == 0 else ''
                        if key == 'description':
                            values.append(fragment); continue
                        if key in ('unitPrice', 'amount'):
                            if item.get('billing') == 'included' and fragment_index == 0:
                                value = '已含' if key == 'unitPrice' else '不另计'
                            elif value is None and fragment_index == 0 and item.get('type') != 'note':
                                value = '待填价' if key == 'unitPrice' else '未计入'
                            else:
                                value = money(value) if value != '' else ''
                        if key == 'code' and cfg['hierarchy'].get('mergeParentCode', True):
                            value = item.get('groupCode', item.get('code', '')) if item.get('rootId', item['id']) == item['id'] and fragment_index == 0 else ''
                        values.append(p(value, col['align']))
                    index = len(data); data.append(values); key = item.get('rootId', item['id']); group = groups.setdefault(key, [index, index]); group[1] = index
            if 'code' in keys and cfg['hierarchy'].get('mergeParentCode', True):
                code = keys.index('code')
                for start, end in groups.values():
                    height = sum(max(cell.wrap(widths[i]-10, 100000)[1] if isinstance(cell, Paragraph) else 0 for i, cell in enumerate(row))+10 for row in data[start:end+1])
                    if end > start and height < doc.height-70:
                        commands.append(('SPAN', (code, start), (code, end)))
            total('本章小计', chapter['subtotal'])
        if len(sections) > 1:
            total('本生产线已计价合计（整单优惠及税额另列）', section['subtotal'])
        table = LongTable(data, colWidths=widths, repeatRows=1)
        table.setStyle(TableStyle(commands)); story.extend([table, Spacer(1, 12)])
    story.extend(p(t['label']+'　'+money(t['value']), 'right') for t in model['totals'] if not t.get('hidden'))
    story.extend([Spacer(1, 8), p('大写金额：'+model['amountInWords'])])
    for note in [model.get('notes', ''), *model.get('pricingNotes', []), *model.get('deliveryNotes', [])]:
        if note:
            story.extend([Spacer(1, 6), p(note)])
    story.extend([Spacer(1, 16), p('购方签署：________________　供方签署：________________')])
    def footer(canvas, document):
        canvas.setFont(font, 8); canvas.drawRightString(page[0]-26, 15, '第'+str(document.page)+'页')
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
