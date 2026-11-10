"""Shared content hierarchy and measured, first-header-only A4 pagination."""
import json
import re
from pathlib import Path
from decimal import Decimal

CONFIG = json.loads((Path(__file__).parent / 'web/assets/export-layout.json').read_text(encoding='utf-8'))
PDF = CONFIG['pdf']


def display_number(value):
    n = Decimal(str(value))
    return format(n, '.2f').rstrip('0').rstrip('.') if n != n.to_integral_value() else str(int(n))


def display_money(value):
    n=Decimal(str(value))
    return str(int(n)) if n==n.to_integral_value() else format(n,'.2f')


def chinese_date(value):
    m = re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})', str(value or ''))
    return f'{m[1]}年{int(m[2])}月{int(m[3])}日' if m else str(value or '')


def contract_notes(q, omitted=None, business=False):
    from business_export import project_notes
    lines = [line for line in project_notes(q).splitlines() if not re.match(r'^\s*(?:购方|供方)(?:代表人签署|签署日期)\s*[:：]', line) and len(re.findall(r'(?:购方|供方)\s*[:：]', line)) < 2]
    if business:
        from business_export import _spec
        lines = [_spec(line) for line in lines]
    notes = '\n'.join(line for line in lines if line).strip()
    if notes and not re.match(r'^(?:备注|注)[：:]', notes):
        notes = '备注：\n' + notes
    if not notes:
        notes = '备注：'
    if omitted:
        notes += '\n本次未计入报价：' + '；'.join(str(row['name']) + '（' + row['reason'] + '）' for row in omitted)
    # Fixed source-contract content survives editable project notes.
    compact = re.sub(r'\s+', '', notes)
    fixed = [line for line in CONFIG.get('contractFixedNotes', []) if re.sub(r'\s+', '', line) not in compact]
    if fixed:
        notes += '\n' + '\n'.join(fixed)
    return notes


def completion(result):
    if result.get('completeness'):
        return result['completeness']
    from quotation_validation import delivery_status
    return delivery_status(result['quote'], result)


def completion_notes(notes, summary):
    if summary['canFinalize']:
        return notes
    return notes + '\n报价草稿：供货范围或计价尚未完成，合计为已计价部分。'


def business_contract_content(result):
    from business_export import content as business_content
    business = business_content(result)
    q = result['quote']
    original = {row.get('id'): row for row in q.get('rows', [])}
    sections, sequence = [], 0
    for chapter in business['chapters']:
        rows = []
        for item in chapter['rows']:
            sequence += 1
            row = dict(original.get(item['id'], {}), **item, sequence=sequence, displaySequence=item['code'], subgroup='')
            relation = '关联' + '、'.join(item['relatedParentCodes']) if len(item['relatedParentCodes']) > 1 else '属' + (item['parentCode'] or item['parentName']) if item['parentCode'] or item['parentName'] else ''
            row['displayName'] = '　' * min(item['depth'], 4) + item['name'] + ('\n' + relation if relation else '')
            row['brand'] = str(row.get('brand') or '').strip() or '未指定'
            rows.append(row)
        section = {'title': chapter['chapterTitle'], 'chapterNo': chapter['chapterNo'], 'rows': rows}
        if rows:
            section['sectionTotal'] = {'label': f"本章小计（供货{chapter['count']}项；待价{chapter['missing']}项）", 'value': chapter['subtotal']}
        sections.append(section)
    notes = contract_notes(q, business=True)
    if business.get('pricingNotes'):
        notes += '\n计价范围说明：\n' + '\n'.join(business['pricingNotes'])
    summary = completion(result)
    return {'config': CONFIG, 'sections': sections, 'totals': business['totals'], 'notes': completion_notes(notes, summary), 'pricingNotes': business['pricingNotes'], 'date': chinese_date(q.get('date')), 'business': True, 'completeness': summary, 'quoteStatus': summary['status']}


def content(result):
    q = result['quote']
    if q.get('businessStructure'):
        return business_contract_content(result)
    # Recover chapter labels for existing snapshots imported before hierarchy
    # support. Only a default sheet-name group is replaced, never a custom group.
    source_groups = {}
    source_subgroups = {}
    sheet_names = set()
    for s in q.get('sources', []):
        sheet_names.add(s.get('sheet', ''))
        current = ''
        subgroup = ''
        for index, values in enumerate(s.get('rows', []), 1):
            chapter=False
            for v in values:
                label = str(v or '').strip()
                if re.match(r'^[一二三四五六七八九十百]+[、.．]', label) and len(label) < 100:
                    rest=next((str(v).strip() for v in values if str(v or '').strip() and str(v).strip()!=label and not re.fullmatch(r'\d+(?:\.\d+)?',str(v).strip())), '')
                    current = label+rest if re.fullmatch(r'[一二三四五六七八九十百]+[、.．]+',label) else label
                    subgroup = ''
                    chapter = True
                    break
            non=[str(v).strip() for v in values if str(v or '').strip()]
            if current and not chapter and len(non)==1 and any(m['s']['r']==index-1 and m['e']['r']==index-1 and m['e']['c']-m['s']['c']>=3 for m in s.get('merges',[])):
                subgroup=non[0]
            source_groups[(s.get('filename'), s.get('sheet'), index)] = current
            source_subgroups[(s.get('filename'), s.get('sheet'), index)] = subgroup
    summary = completion(result)
    originals = list(result['rows'])
    if not summary['canFinalize']:
        from formula_engine import is_requirement, is_included
        # A draft keeps selected unfinished supplies visible, with empty price
        # cells. Excluded items and requirements remain in the scope notes.
        originals.extend(row for row in result.get('omitted', []) if row.get('selected') is not False and not is_requirement(row) and not is_included(row))
        positions = {row.get('id'): index for index, row in enumerate(q.get('rows', [])) if row.get('id')}
        unnamed_positions = {(row.get('name'), row.get('source'), row.get('sourceRow')): index for index, row in enumerate(q.get('rows', []))}
        originals.sort(key=lambda row: positions.get(row.get('id'), unnamed_positions.get((row.get('name'), row.get('source'), row.get('sourceRow')), len(q.get('rows', [])))))
    rows = []
    for index, original in enumerate(originals, 1):
        row = dict(original, sequence=index)
        row['brand'] = str(row.get('brand') or '').strip() or '未指定'
        group = str(row.get('group') or '')
        if group in sheet_names:
            source = str(row.get('source') or '').split(' / ')
            key = (source[0], source[1], row.get('sourceRow')) if len(source) >= 2 else None
            group = source_groups.get(key, '')
            if source_subgroups.get(key) and not row.get('subgroup'):
                row['subgroup']=source_subgroups[key]
        if group in ('手动添加', '部件库添加'):
            group = ''
        row['group'] = group
        rows.append(row)
    sections = []
    for row in rows:
        if not sections or sections[-1]['title'] != row['group']:
            sections.append({'title': row['group'], 'rows': []})
        sections[-1]['rows'].append(row)
    totals = [{'label': '含税金额合计' if q['taxMode'] == 'included' else '未税金额合计', 'value': result['total'], 'kind': 'subtotal'}]
    if result.get('discount'):
        totals = [dict(label='优惠前合计', value=result['grossTotal'], kind='gross'), dict(label='整单优惠', value=-result['discount'], kind='discount'), dict(label='优惠后金额合计', value=result['total'], kind='subtotal')]
    if q['taxMode'] == 'excluded':
        totals.extend([{'label': f"税额{display_number(q.get('taxRate', 0))}%", 'value': result['tax'], 'kind': 'tax'}, {'label': '合计含税金额', 'value': result['grandTotal'], 'kind': 'grandTotal'}])
    if not summary['canFinalize']:
        for total in totals:
            total['label'] = '已计价部分 · ' + total['label']
    # Legacy imports copied blank signature cells into the business notes. The
    # structured signature block replaces those cells without duplicating them.
    notes = completion_notes(contract_notes(q, result['omitted']), summary)
    return {'config': CONFIG, 'sections': sections, 'totals': totals, 'notes': notes, 'date': chinese_date(q.get('date')), 'completeness': summary, 'quoteStatus': summary['status']}


def plan(result):
    """A serializable geometry plan, also used for layout regression assertions."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    import os
    if 'QuoteSong' not in pdfmetrics.getRegisteredFontNames():
        font = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/simsun.ttc'
        if not font.is_file():
            raise ValueError('系统缺少宋体字体，无法生成中文PDF')
        pdfmetrics.registerFont(TTFont('QuoteSong', str(font), subfontIndex=0))
    model = result.get('exportContent') or content(result)
    width = PDF['width'] - PDF['left'] - PDF['right']
    bottom = PDF['height'] - PDF['bottom']
    leading, padding = PDF['leading'], PDF['padding']
    font_size = PDF['fontSize']

    def lines(text, available, size=font_size, spacing=0):
        out = []
        for line in str(text or '').replace('\r\n', '\n').replace('\r', '\n').split('\n'):
            current = ''
            # CJK character wrapping; uninterrupted Latin words split only if
            # longer than the whole column. No source text is discarded.
            for token in re.findall(r'[A-Za-z0-9_.,/%+\-]+|[^A-Za-z0-9_.,/%+\-]', line):
                if current and pdfmetrics.stringWidth(current + token, 'QuoteSong', size)+spacing*max(0,len(current+token)-1) > available:
                    out.append(current)
                    current = ''
                for ch in token:
                    if current and pdfmetrics.stringWidth(current + ch, 'QuoteSong', size)+spacing*len(current) > available:
                        out.append(current)
                        current = ''
                    current += ch
            out.append(current)
        return out

    pages = [[]]
    y = PDF['top']

    def add(kind, height, **kwargs):
        nonlocal y
        block = dict(type=kind, y=round(y, 4), height=round(height, 4), **kwargs)
        pages[-1].append(block)
        y += height
        return block

    def new_page():
        nonlocal y
        if pages[-1]:
            pages.append([])
        y = PDF['top']

    def room(height):
        if y + height > bottom + .001:
            new_page()

    q = result['quote']
    customer_lines=lines(q.get('customer',''),PDF['width']-PDF['right']-104.06,10.32,.129)
    extra=max(0,len(customer_lines)-1)*leading
    header_height=133+extra
    if header_height + 60 > bottom-PDF['top']:
        raise ValueError('项目或客户名称过长，无法放入首页抬头，请缩短抬头信息')
    add('firstHeader', header_height, customerLines=customer_lines, customerExtra=extra, date=model['date'])
    add('columns', 26, cells=CONFIG['columns'])

    # Normal rows remain intact. A cell longer than a page is split into safe
    # physical fragments; its sequence, quantity and money appear only once.
    sections = []
    for section in model['sections']:
        blocks = []
        if section['title']:
            text_lines = lines(section['title'], width - 2 * padding)
            blocks.append({'type': 'group', 'height': max(22.4, len(text_lines)*leading+2*padding), 'lines': text_lines})
        subgroup = None
        for row in section['rows']:
            if row.get('subgroup') and row['subgroup'] != subgroup:
                subgroup = row['subgroup']
                text_lines = lines(subgroup, width - 2 * padding)
                blocks.append({'type': 'subgroup', 'height': max(21, len(text_lines)*leading+2*padding), 'lines': text_lines})
            values = [str(row.get('displaySequence', row['sequence'])), row.get('displayName', row['name']), str(row.get('spec') or ''), str(row.get('brand') or ''), display_number(row['quantity']) if row.get('quantity') is not None else '', str(row.get('unit') or ''), display_money(row['unitPrice']) if row.get('unitPrice') is not None else '', display_money(row['amount']) if row.get('amount') is not None else '']
            sizes = [font_size] * 8
            for i in [0, 4, 5, 6, 7]:
                measured = pdfmetrics.stringWidth(values[i], 'QuoteSong', font_size)
                if measured > PDF['columnWidths'][i] - 2 * padding:
                    sizes[i] = max(8, font_size * (PDF['columnWidths'][i]-2*padding) / measured)
            cell_lines = [lines(v, w-2*padding, sizes[i]) for i,(v,w) in enumerate(zip(values, PDF['columnWidths']))]
            height = max(22,max(len(v) for v in cell_lines)*leading+2*padding)
            blocks.append({'type':'item','height':height,'cells':cell_lines,'sizes':sizes,'sequence':row['sequence'],'fragment':False,'long':height>bottom-PDF['top']})
        if section.get('sectionTotal'):
            total = section['sectionTotal']
            blocks.append({'type': 'sectionTotal', 'height': 26, 'label': total['label'], 'value': display_money(total['value']), 'numberValue': total['value'], 'chapterNo': section.get('chapterNo')})
        sections.append(blocks)

    note_lines = lines(model['notes'], width - 2*padding)
    total_blocks = [{'type':'total','height':26,'label':v['label'],'value':display_money(v['value'])} for v in model['totals']]
    tail_full = sum(b['height'] for b in total_blocks) + len(note_lines)*leading + 2*padding + PDF['signatureHeight'] + 8
    # Short notes are kept with their signature block; reserve that same space
    # before placing totals, rather than moving only the notes to a new page.
    full_height = bottom - PDF['top']
    tail_min = tail_full if 2*leading+2*padding+tail_full<=full_height else sum(b['height'] for b in total_blocks) + min(3,len(note_lines))*leading + 2*padding
    for section_index, blocks in enumerate(sections):
        group_height = sum(b['height'] for b in blocks)
        final = section_index == len(sections)-1
        requested = group_height + (tail_full if final and group_height+tail_full<=full_height else tail_min if final else 0)
        has_items=any(b['type']=='item' for p in pages for b in p)
        if has_items and requested <= full_height and y + requested > bottom:
            new_page()
        elif has_items and group_height <= full_height and y + group_height > bottom:
            new_page()
        for i, block in enumerate(blocks):
            needed = block['height']
            final_item = final and block['type'] == 'item' and all(value['type'] == 'sectionTotal' for value in blocks[i + 1:])
            section_tail = sum(value['height'] for value in blocks[i + 1:]) if final_item else 0
            if block['type'] in ('group','subgroup'):
                j=i+1
                while j<len(blocks) and blocks[j]['type'] in ('group','subgroup'):
                    needed+=blocks[j]['height'];j+=1
                if j<len(blocks):
                    needed+=min(blocks[j]['height'],2*leading+2*padding) if blocks[j].get('long') else blocks[j]['height']
            if block['type']=='item' and (block['long'] or final_item and block['height']+section_tail+tail_min>full_height):
                offset=0
                count=max(len(v) for v in block['cells'])
                while offset<count:
                    room(2*leading+2*padding)
                    take=int((bottom-y-2*padding)/leading)
                    remaining=count-offset
                    tail = (tail_full if remaining*leading+2*padding+section_tail+tail_full<=full_height else tail_min) + section_tail
                    if final_item and remaining*leading+2*padding+tail>full_height:
                        # Leave a readable last fragment to carry the totals and
                        # compact contract tail, even when this row alone fits.
                        take=min(take,max(1,remaining-2))
                    if final_item and remaining*leading+2*padding+tail<=full_height and y+remaining*leading+2*padding+tail>bottom:
                        new_page();take=int((bottom-y-2*padding-tail)/leading)
                    cells=[v[offset:offset+take] for v in block['cells']]
                    if offset:
                        for column in [0,4,5,6,7]:
                            cells[column]=[]
                    height=max(22,max(len(v) for v in cells)*leading+2*padding)
                    add('item',height,cells=cells,sizes=block['sizes'],sequence=block['sequence'],fragment=offset>0)
                    offset+=take
                continue
            if final_item and needed + section_tail + tail_min <= full_height:
                needed += section_tail + (tail_full if needed + section_tail + tail_full <= full_height else tail_min)
            if final and i == len(blocks)-1 and not final_item and needed+tail_min <= full_height:
                needed += tail_full if needed+tail_full<=full_height else tail_min
            room(needed)
            add(block['type'], block['height'], **{k:v for k,v in block.items() if k not in ('type','height')})
    room(tail_min)
    for block in total_blocks:
        add(block['type'], block['height'], label=block['label'], value=block['value'])
    # Flow notes directly after totals. Keep the final few lines with the
    # signature area so a signature-only extra page is not manufactured.
    for i, line in enumerate(note_lines):
        height = leading + (padding if i==0 else 0) + (padding if i==len(note_lines)-1 else 0)
        remaining = len(note_lines) - i
        needed = height
        if remaining <= 3:
            needed = remaining*leading + padding + PDF['signatureHeight'] + 8
        elif re.match(r'^\s*(?:[一二三四五六七八九十]+[、.]|付款方式|交货期|设备保养期)', line):
            needed += 2 * leading
        room(needed)
        add('note',height,lines=[line],first=i==0,last=i==len(note_lines)-1)
    page_count=len(pages)
    room(PDF['signatureHeight']+8)
    if len(pages)==page_count:y+=8
    add('signature',PDF['signatureHeight'])
    return {'config':CONFIG,'content':model,'blocks':[b for section in sections for b in section],'pages':pages}
