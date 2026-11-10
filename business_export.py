"""Business chapter quotations share one model across the PDF and workbook."""
import io
import json
import os
import re
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from xml.sax.saxutils import escape
from formula_engine import is_included

VERSION = '2026-11-07.business-export.3'
CONFIG = json.loads((Path(__file__).parent / 'web/assets/export-layout.json').read_text(encoding='utf-8'))
COLUMNS = CONFIG['business']['columns']
CHAPTERS = [(1, '一、自动龙门行车部分'), (2, '二、机架部分'), (3, '三、电气控制部分'), (4, '四、槽体部分'), (5, '五、周边配置部分')]


def _requirement(row):
    return row.get('kind') in ('requirement', 'process') or (row.get('bom') or {}).get('role') == 'requirement'


def project_notes(quote):
    """Keep customer notes; entry-plan rationale belongs to the workbench."""
    notes=str(quote.get('notes') or '').strip()
    basis=str((quote.get('entryOrigin') or {}).get('basis') or '').strip()
    if basis and (notes==basis or notes.startswith(basis+'\n')):
        notes=notes[len(basis):].strip()
    # Earlier library seeds appended an operator-only template reuse guide to
    # notes. Match that complete instruction form, not historical-price terms
    # or customer-authored comments mentioning a template.
    return '\n'.join(line for line in notes.splitlines() if not re.fullmatch(
        r'\s*本模板(?:源自|来自).*[，,；;]复用时(?:请)?(?:核对|确认).*[。.]?\s*',line)).strip()


def _safe(value):
    text = str(value or '').strip()
    text = re.sub(r'[（(]\s*第\s*\d+\s*行(?:起)?\s*[）)]|第\s*\d+\s*行(?:起)?', '', text)
    text = re.sub(r'[^\s/\\]*\.(?:xlsx?|csv|pdf)\b', '', text, flags=re.I)
    return re.sub(r'\s*[/／]\s*(?:Sheet\s*\d+|工作表\s*\d+)\b', '', text, flags=re.I).strip()


def _spec(value):
    lines = []
    for raw in str(value or '').splitlines():
        if re.search(r'原表功能要求|主槽/|第\s*\d+\s*行|\bSheet\s*\d+\s*!|[A-Z]+\d+:[A-Z]+\d+', raw):
            continue
        line = _safe(raw)
        if line:
            lines.append(line)
    return '\n'.join(lines)


def _number(value):
    if value is None or value == '':
        return None
    try:
        number = Decimal(str(value))
        return float(number) if number.is_finite() and number >= 0 else None
    except (ArithmeticError, ValueError, TypeError):
        return None


def _money(value):
    return float(Decimal(str(value)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


def amount_in_words(value):
    """Render the same rounded CNY amount as the numeric total."""
    cents = int(Decimal(str(value)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) * 100)
    digits = '零壹贰叁肆伍陆柒捌玖'
    def group(number):
        result, zero = '', False
        for index, unit in enumerate(['仟', '佰', '拾', '']):
            digit = number // (10 ** (3-index)) % 10
            if digit:
                result += ('零' if zero and result else '') + digits[digit] + unit
                zero = False
            elif result:
                zero = True
        return result
    integer, fraction = divmod(cents, 100)
    pieces = []
    while integer:
        pieces.append(integer % 10000)
        integer //= 10000
    text, zero = '', False
    for index in range(len(pieces)-1, -1, -1):
        number = pieces[index]
        if not number:
            zero = bool(text)
            continue
        if text and (zero or number < 1000):
            text += '零'
        text += group(number) + ['', '万', '亿', '万亿'][index]
        zero = False
    text = (text or '零') + '元'
    jiao, fen = divmod(fraction, 10)
    if not fraction:
        return '人民币' + text + '整'
    if jiao:
        text += digits[jiao] + '角'
    elif fen:
        text += '零'
    if fen:
        text += digits[fen] + '分'
    return '人民币' + text


def _description(item, brand=''):
    parent = '关联' + '、'.join(item['relatedParentCodes']) if len(item['relatedParentCodes']) > 1 else '属' + (item['parentCode'] or item['parentName']) if item['parentCode'] or item['parentName'] else ''
    return '\n'.join(part for part in [item['name'], '（' + parent + '）' if parent else '', item['spec'], '（品牌：' + _safe(brand) + '）' if brand else ''] if part)


def pricing_notes(source, prepared):
    """Describe the confirmed price scope without changing engineering or money."""
    pricing = source.get('pricing') or {}
    if pricing.get('mode') != 'assembly':
        return []
    has_price = _number(prepared.get('unitPrice')) is not None
    if pricing.get('scope') != 'tank_body' and not has_price:
        return []
    if pricing.get('scope') == 'tank_body' and _number(pricing.get('bodyPrice')) is None and not has_price:
        return []
    adjustments = pricing.get('adjustments') or []
    pending = pricing.get('pendingInclusions') or []
    if not adjustments and not pending:
        return []
    notes = []
    if pricing.get('scope') == 'tank_body' and _number(pricing.get('bodyPrice')) is not None:
        notes.append('槽体主体已计价' if has_price else '槽体主体已计算，报价单价待确认')
    covered = []
    names = {'insulation': '保温', 'outer_shell': '外包 / 外封', 'coating': '涂层加工'}
    for adjustment in adjustments:
        label = _spec(adjustment.get('label') or names.get(adjustment.get('kind'), '')).strip()
        if not label:
            continue
        covered.append(re.sub(r'\s', '', label))
        choice = adjustment.get('choice')
        separate_ready = _number(adjustment.get('fixedPrice')) is not None or (_number(adjustment.get('rate')) is not None and _number(adjustment.get('area')) is not None)
        if choice == 'included':
            notes.append(label + ('已含在本行单价' if has_price else '已选择包含，报价单价待确认'))
        elif choice == 'separate' and separate_ready:
            notes.append(label + ('另计金额已计入本行单价' if has_price else '已选择另计，报价单价待确认'))
        elif choice == 'separate':
            notes.append(label + '另计金额待确认，尚未计入本行单价')
        else:
            notes.append(label + '是否含价或另计待确认，尚未计入本行单价')
    # The explicit adjustment choices supersede an older pending summary.
    for value in pending:
        label = re.sub(r'含\s*/\s*另计待确认\s*$', '', _spec(value)).strip()
        if not label or any(re.sub(r'\s', '', label) == known for known in covered):
            continue
        notes.append(label + '是否含价或另计待确认，尚未计入本行单价')
    return list(dict.fromkeys(notes))


def content(result, export_config=None):
    """Keep selected unpriced supply lines; amounts come only from prepare()."""
    quote = result['quote']
    originals = quote.get('rows', [])
    by_id = {row.get('id'): row for row in originals}
    prepared = {row.get('id'): row for row in [*result.get('rows', result.get('ready', [])), *result.get('omitted', [])]}
    order = (quote.get('businessStructure') or {}).get('order', [])
    ordered = [by_id[row_id] for row_id in dict.fromkeys(order) if row_id in by_id]
    seen = {row.get('id') for row in ordered}
    ordered.extend(row for row in originals if row.get('id') not in seen)
    definitions = [(c['chapterNo'], c['chapterTitle']) for c in (quote.get('decomposition') or {}).get('chapters', [])] or CHAPTERS
    chapters = [{'chapterNo': number, 'chapterTitle': title, 'rows': [], 'subtotal': 0, 'missing': 0, 'count': 0} for number, title in definitions]
    chapter_map = {c['chapterNo']: c for c in chapters}
    counts = {number: 0 for number, _ in definitions}
    for original in ordered:
        included = is_included(original)
        if (original.get('selected') is False and not included) or _requirement(original):
            continue
        row = prepared.get(original.get('id'), {})
        business = original.get('business') or {}
        chapter_no = business.get('chapterNo')
        if chapter_no not in counts:
            chapter_no = definitions[0][0] if quote.get('decomposition') else 4 if (original.get('bom') or {}).get('role') == 'tank' and not (original.get('bom') or {}).get('shared') else 5
        chapter = chapter_map[chapter_no]
        parent_id = business.get('parentId') or original.get('parentId') or (original.get('bom') or {}).get('parentId')
        parent = by_id.get(parent_id, {})
        depth = int(business.get('depth') or bool(parent_id))
        code = business.get('customerCode') or business.get('code') or ''
        if not code and not parent_id:
            counts[chapter_no] += 1
            code = f'{chapter_no}-{counts[chapter_no]:02d}'
        elif not parent_id:
            match = re.fullmatch(rf'{chapter_no}-(\d+)', str(code))
            counts[chapter_no] = max(counts[chapter_no], int(match[1]) if match else counts[chapter_no])
        related_ids = business.get('relatedParentIds') or (original.get('bom') or {}).get('relatedParentIds') or []
        related_codes = list(dict.fromkeys(str((by_id.get(value, {}).get('business') or {}).get('customerCode') or '') for value in related_ids))
        name = _safe(original.get('name')) or _safe(original.get('rawName'))
        if not name:
            raise ValueError('供货明细名称为空，请补全名称后重新导出')
        item = {
            'id': original.get('id'), 'code': str(code or ''), 'name': name,
            'spec': _spec(row.get('spec', original.get('spec', ''))), 'unit': str(original.get('unit') or ''),
            'quantity': _number(row.get('quantity', original.get('quantity'))),
            'unitPrice': _number(row.get('unitPrice')), 'amount': _number(row.get('amount')),
            'depth': depth, 'parentId': parent_id,
            'parentCode': str((parent.get('business') or {}).get('customerCode') or ''),
            'parentName': _safe(parent.get('name')), 'relatedParentCodes': [value for value in related_codes if value],
            'pending': row.get('amount') is None, 'reason': str(row.get('reason') or ''),
            'pricingNotes': pricing_notes(original, row),
            'billing': 'included' if included else 'separate',
        }
        if included:
            item.update(unitPrice=None, amount=None, pending=False, reason='已含在主设备价，不另计')
        from condition_binding import resolved as condition_resolved
        conditions = [r for r in quote.get('rows', []) if (r.get('conditionBinding') or {}).get('parentId') == original.get('id') and condition_resolved(r, quote.get('rows', []))]
        if conditions:
            item['spec'] = '\n'.join([item['spec'], *[str(r['conditionBinding']['basis']) for r in conditions]]).strip()
        item['description'] = _description(item, original.get('brand'))
        if included:
            item['description'] += '\n已含在主设备报价，不另计'
        chapter['rows'].append(item)
        chapter['count'] += 0 if included else 1
        if not included and item['amount'] is None:
            chapter['missing'] += 1
        elif not included:
            chapter['subtotal'] = _money(Decimal(str(chapter['subtotal'])) + Decimal(str(item['amount'])))
    pending = sum(chapter['missing'] for chapter in chapters)
    selected = sum(chapter['count'] for chapter in chapters)
    subtotal = _money(sum(Decimal(str(chapter['subtotal'])) for chapter in chapters))
    totals = [{'label': '含税金额合计' if quote.get('taxMode') == 'included' else '未税金额合计', 'value': subtotal, 'kind': 'subtotal'}]
    if result.get('discount'):
        totals = [dict(label='优惠前合计', value=subtotal, kind='gross'), dict(label='整单优惠', value=-result['discount'], kind='discount'), dict(label='优惠后金额合计', value=result['total'], kind='subtotal')]
        if (quote.get('commercial') or {}).get('showDiscount') is False:
            totals[1]['hidden'] = True
    if quote.get('taxMode') == 'excluded':
        totals.extend([{'label': f"税额{quote.get('taxRate', 0)}%", 'value': result.get('tax', 0), 'kind': 'tax'}, {'label': '合计含税金额', 'value': result.get('grandTotal', subtotal), 'kind': 'grandTotal'}])
    from quotation_validation import delivery_status
    completeness = result.get('completeness') or delivery_status(quote, result)
    if not completeness.get('canFinalize'):
        for total in totals:
            total['label'] = '已计价部分 · ' + total['label']
    scope_notes = [((item['code'] + ' ') if item['code'] else '') + item['name'] + '：' + '；'.join(item['pricingNotes']) + '。'
                   for chapter in chapters for item in chapter['rows'] if item['pricingNotes']]
    delivery_notes = [] if completeness.get('canFinalize') else ['报价草稿：供货范围或计价尚未完成，合计为已计价部分。']
    model = {'version': VERSION, 'title': _safe(quote.get('title')), 'customer': _safe(quote.get('customer')),
            'supplier': str(quote.get('supplier') or CONFIG['company']), 'supplierAddress': CONFIG['address'],
            'supplierPhone': CONFIG['phone'], 'notes': project_notes(quote),
            'amountInWords': amount_in_words(totals[-1]['value']), 'excelWidths': CONFIG['business']['excelWidths'],
            'date': str(quote.get('date') or ''), 'columns': COLUMNS.copy(), 'chapters': chapters,
            'totals': totals, 'selectedCount': selected, 'pricedCount': selected - pending, 'pendingCount': pending, 'pricingNotes': scope_notes,
            'completeness': completeness, 'quoteStatus': 'ready' if completeness.get('canFinalize') else 'incomplete', 'deliveryNotes': delivery_notes}
    if quote.get('exportConfig') is not None:
        export_config = quote['exportConfig']
    if export_config is not None:
        from export_templates import apply
        model = apply(model, result, export_config)
    if quote.get('exportDocument'):
        from quotation_document import apply as apply_document
        model = apply_document(model, quote, quote['exportDocument'])
    return model


def _display(value, money=False):
    if value is None:
        return ''
    number = Decimal(str(value))
    return format(number, '.2f') if money else format(number, 'f').rstrip('0').rstrip('.') if '.' in str(number) else str(number)


def pdf_bytes(result):
    """Customer six-column quotation, using the same content as the workbook."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, LongTable, TableStyle

    font = 'QuoteBusinessSong'
    if font not in pdfmetrics.getRegisteredFontNames():
        path = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / 'simsun.ttc'
        if not path.is_file():
            raise ValueError('系统缺少宋体字体，无法生成中文PDF')
        pdfmetrics.registerFont(TTFont(font, str(path), subfontIndex=0))
    model = result.get('businessContent') or content(result)
    if model.get('exportConfig'):
        from quotation_pdf import render
        return render(model, font)
    output = io.BytesIO()
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=30, leftMargin=30, topMargin=32, bottomMargin=32,
                            title=(model.get('title') or '') + '业务报价单', author='')
    base = ParagraphStyle('business', fontName=font, fontSize=9, leading=12, wordWrap='CJK', spaceAfter=0)
    centered = ParagraphStyle('business-center', parent=base, alignment=TA_CENTER)
    numeric = ParagraphStyle('business-number', parent=base, alignment=TA_RIGHT)
    title = ParagraphStyle('business-title', parent=base, fontSize=16, leading=22, alignment=TA_CENTER, spaceAfter=10)

    def paragraph(value, style=base):
        return Paragraph(escape(str(value or '')).replace('\n', '<br/>'), style)

    story = [paragraph(model['supplier'], title), paragraph((model.get('title') or '项目') + '报价单', title)]
    story.extend([paragraph('客户：' + str(model.get('customer') or '') + '　日期：' + str(model.get('date') or '')),
                  paragraph(f"供货 {model['selectedCount']} 项　已价 {model['pricedCount']} 项　待价 {model['pendingCount']} 项"), Spacer(1, 10)])
    widths = list(CONFIG['business']['pdfWidths'])
    widths[-1] = A4[0] - 60 - sum(widths[:-1])
    data = [[paragraph(value, centered) for value in model['columns']]]
    commands = [('FONTNAME', (0, 0), (-1, -1), font), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('GRID', (0, 0), (-1, -1), .4, colors.HexColor('#777777')),
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e8edf2')),
                ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
                ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]
    for chapter in model['chapters']:
        if not chapter['rows']:
            continue
        index = len(data)
        data.append([paragraph(chapter['chapterTitle']), '', '', '', '', ''])
        commands.extend([('SPAN', (0, index), (-1, index)), ('BACKGROUND', (0, index), (-1, index), colors.HexColor('#eff2f5'))])
        for row in chapter['rows']:
            first_data_index = len(data)
            # Split exceptionally long descriptions before pagination, keeping
            # quantity and money on their first fragment only.
            pending = [paragraph(row['description'])]
            fragments = []
            while pending:
                part = pending.pop(0)
                if part.wrap(widths[1] - 10, 100000)[1] > doc.height - 80:
                    pieces = part.split(widths[1] - 10, doc.height - 80)
                    if len(pieces) < 2:
                        raise ValueError('配置说明无法分页，请检查内容格式')
                    pending[0:0] = pieces
                else:
                    fragments.append(part)
            for fragment_index, fragment in enumerate(fragments):
                first = fragment_index == 0
                data.append([paragraph(row['code'] if first else '', centered), fragment,
                             paragraph(_display(row['quantity']) if first else '', numeric), paragraph(row['unit'] if first else '', centered),
                             paragraph(_display(row['unitPrice'], True) if first else '', numeric), paragraph(_display(row['amount'], True) if first else '', numeric)])
            if row is chapter['rows'][0]:
                first_height = max(cell.wrap(widths[column] - 10, 100000)[1] for column, cell in enumerate(data[first_data_index])) + 8
                if first_height < doc.height - 70:
                    commands.append(('NOSPLIT', (0, first_data_index - 1), (-1, first_data_index)))
        index = len(data)
        label = f"本章小计（供货{chapter['count']}项；待价{chapter['missing']}项）"
        data.append([paragraph(label), '', '', '', '', paragraph(_display(chapter['subtotal'], True), numeric)])
        commands.extend([('SPAN', (0, index), (4, index)), ('BACKGROUND', (0, index), (-1, index), colors.HexColor('#f5f6f7'))])
    for total in model['totals']:
        if total.get('hidden'):
            continue
        index = len(data)
        data.append([paragraph(total['label']), '', '', '', '', paragraph(_display(total['value'], True), numeric)])
        commands.extend([('SPAN', (0, index), (4, index)), ('BACKGROUND', (0, index), (-1, index), colors.HexColor('#e8edf2'))])
    # Carry the final supply line, chapter subtotal and overall totals together.
    # A price-only final page makes the hierarchy impossible to review.
    final_count = sum(not total.get('hidden') for total in model['totals']) + 1
    last_items = next((len(chapter['rows']) for chapter in reversed(model['chapters']) if chapter['rows']), 0)
    if last_items:
        tail_start = max(1, len(data) - final_count - 1)
        tail_height = sum(max(cell.wrap(widths[index] - 10, 100000)[1] if isinstance(cell, Paragraph) else 0 for index, cell in enumerate(row)) + 8 for row in data[tail_start:])
        if tail_height < doc.height - 40:
            commands.append(('NOSPLIT', (0, tail_start), (-1, len(data) - 1)))
    table = LongTable(data, colWidths=widths, repeatRows=1, splitByRow=1, splitInRow=0)
    table.setStyle(TableStyle(commands))
    story.append(table)
    story.extend([Spacer(1, 10), paragraph(('合计大写：' if model['completeness'].get('canFinalize') else '已计价部分大写：') + model['amountInWords'])])
    if model.get('notes'):
        story.extend([Spacer(1, 10), paragraph('备注与商务条款：'), paragraph(model['notes'])])
    if model.get('pricingNotes'):
        story.extend([Spacer(1, 10), paragraph('计价范围说明：')])
        for note in model['pricingNotes']:
            story.append(paragraph(note))
            story.append(Spacer(1, 4))
    for note in model.get('deliveryNotes') or []:
        story.extend([Spacer(1, 4), paragraph(note)])
    story.extend([Spacer(1, 16), paragraph('购方签署：________________　供方签署：________________'),
                  paragraph('日期：________________　日期：________________'),
                  Spacer(1, 8), paragraph(model['supplierAddress'] + '　电话：' + model['supplierPhone'])])

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont(font, 8)
        canvas.drawRightString(A4[0] - 30, 18, '第' + str(document.page) + '页')
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
