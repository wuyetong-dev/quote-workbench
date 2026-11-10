"""Editable quotation outline. Prices remain owned by prepared quote rows."""
import copy
import re
from decimal import Decimal


def _title(value):
    return re.sub(r'^[一二三四五六七八九十百\d]+[、.．]\s*', '', str(value or '')).strip().lstrip('、.． ')


def _cn(n):
    digits = '零一二三四五六七八九'
    if n < 10:
        return digits[n]
    return (digits[n // 10] if n >= 20 else '') + '十' + (digits[n % 10] if n % 10 else '')


def validate(document):
    if not isinstance(document, dict) or document.get('version') != 1:
        raise ValueError('报价版式版本无效')
    nodes = copy.deepcopy(document.get('nodes'))
    if not isinstance(nodes, list) or len(nodes) > 10000:
        raise ValueError('报价版式节点过多或无效')
    ids, row_ids = set(), set()
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not 1 <= len(node['id']) <= 150 or node['id'] in ids:
            raise ValueError('报价版式节点编号重复或无效')
        ids.add(node['id'])
        if node.get('type') not in ('line', 'chapter', 'item', 'pending', 'note'):
            raise ValueError('报价版式节点类型无效')
        title = node.get('title', '')
        if not isinstance(title, str) or len(title) > 10000:
            raise ValueError('报价版式内容过长')
        if node.get('type') in ('line', 'chapter') and not title.strip():
            raise ValueError('生产线和章节名称不能为空')
        if node.get('number') not in (None, '') and (type(node['number']) is not int or not 1 <= node['number'] <= 99):
            raise ValueError('手工章号应为1至99')
        if node['type'] in ('item', 'pending'):
            if not isinstance(node.get('rowId'), str) or node['rowId'] in row_ids:
                raise ValueError('同一供货项不能在版式中重复计费')
            row_ids.add(node['rowId'])
    by_id = {n['id']: n for n in nodes}
    for node in nodes:
        parent = node.get('parentId')
        if parent and (parent not in by_id or by_id[parent]['type'] == 'note'):
            raise ValueError('报价版式上级不存在或不能容纳子项')
        if node['type'] == 'line' and parent:
            raise ValueError('生产线应位于最高层级')
        if node['type'] != 'line' and not parent:
            raise ValueError('章节、部件和说明应属于一条生产线')
        seen = {node['id']}
        while parent:
            if parent in seen or len(seen) > 40:
                raise ValueError('报价版式存在循环或层级过深')
            seen.add(parent); parent = by_id[parent].get('parentId')
    return {'version': 1, 'nodes': nodes}


def _pending(nodes, quote):
    existing = {n.get('rowId') for n in nodes}
    parents = {n.get('rowId'): n['id'] for n in nodes if n['type'] == 'item'}
    for row in quote.get('rows', []):
        configuration = (row.get('bom') or {}).get('engineeringType') == 'equipment-configuration'
        if row['id'] in existing or row.get('kind') != 'requirement' or row.get('quoteLayoutHidden') or not configuration:
            continue
        if (row.get('bom') or {}).get('resolved') or (row.get('scopeReview') or {}).get('confirmedAt'):
            continue
        parent = parents.get(row.get('parentId') or (row.get('bom') or {}).get('parentId'))
        if parent:
            nodes.append({'id': 'pending-' + row['id'], 'type': 'pending', 'rowId': row['id'], 'parentId': parent})


def seed(quote, model):
    """Keep original quotation sheets/chapters; process inputs use computed BOM."""
    raw = {r['id']: r for r in quote.get('rows', [])}
    nodes, lines, chapters = [], {}, {}
    quotation_sheets = [s for s in quote.get('sources', []) if s.get('type') == 'quotation']
    original = bool(quotation_sheets)
    source_lines = {str(s.get('filename', '')) + ' / ' + str(s.get('sheet', '')): s.get('sheet', '') for s in quotation_sheets}
    items = [r for ch in model['chapters'] for r in ch['rows']]
    chapter_by_item = {r['id']: ch for ch in model['chapters'] for r in ch['rows']}
    if original:
        order = {r['id']: n for n, r in enumerate(quote.get('rows', []))}
        items.sort(key=lambda r: order.get(r['id'], 10**9))
    item_nodes = {}
    for item in items:
        chapter = chapter_by_item[item['id']]
        r = raw.get(item['id'], {})
        line_name = next((title for source, title in source_lines.items() if str(r.get('source', '')).startswith(source + ' / ')), '') if len(source_lines) > 1 else ''
        line_name = line_name or quote.get('title') or '生产线'
        if line_name not in lines:
            line_id = 'line-' + str(len(lines) + 1); lines[line_name] = line_id
            nodes.append({'id': line_id, 'type': 'line', 'title': line_name, 'parentId': None})
        line_id = lines[line_name]
        title = _title(r.get('rawGroup')) if original else _title(chapter['chapterTitle'])
        title = title or _title(chapter['chapterTitle']) or '设备明细'
        key = (line_id, title)
        if key not in chapters:
            chapter_id = 'chapter-' + str(len(chapters) + 1); chapters[key] = chapter_id
            nodes.append({'id': chapter_id, 'type': 'chapter', 'title': title, 'parentId': line_id})
        node = {'id': 'item-' + item['id'], 'type': 'item', 'rowId': item['id'], 'parentId': chapters[key]}
        nodes.append(node); item_nodes[item['id']] = node
    for item in items:
        node = item_nodes[item['id']]
        parent = item_nodes.get(item.get('parentId'))
        r = raw.get(item['id'], {})
        if parent and not (r.get('bom') or {}).get('shared') and len(item.get('relatedIds', [])) <= 1:
            node['parentId'] = parent['id']
    # Vertical source serial-number merges explicitly group a main device and
    # its accessories. They are evidence, unlike mere neighbouring rows.
    for source in quotation_sheets:
        prefix = str(source.get('filename', '')) + ' / ' + str(source.get('sheet', '')) + ' / '
        for merge in source.get('merges', []):
            start, end = merge['s'], merge['e']
            if start['c'] != 0 or end['c'] != 0 or end['r'] <= start['r']:
                continue
            cells = source.get('rows', [])
            anchor = cells[start['r']][0] if start['r'] < len(cells) and cells[start['r']] else ''
            if not re.fullmatch(r'\d+(?:[-.]\d+)*', str(anchor or '').strip()):
                continue
            group = sorted((r for r in quote.get('rows', []) if r['id'] in item_nodes and str(r.get('source', '')).startswith(prefix) and start['r']+1 <= (r.get('sourceRow') or 0) <= end['r']+1), key=lambda r: r['sourceRow'])
            if len(group) > 1:
                for child in group[1:]:
                    item_nodes[child['id']]['parentId'] = item_nodes[group[0]['id']]['id']
    _pending(nodes, quote)
    return validate({'version': 1, 'nodes': nodes})


def apply(model, quote, document):
    document = validate(document)
    nodes = document['nodes']
    _pending(nodes, quote)
    raw_rows = {r['id']: r for r in quote.get('rows', [])}
    items = {r['id']: copy.deepcopy(r) for ch in model['chapters'] for r in ch['rows'] if r.get('type') != 'note'}
    mentioned = {n['rowId'] for n in nodes if n['type'] == 'item'}
    # Newly imported/manual supplies must remain visible even if a saved layout
    # predates them. Removing a layout group never removes a charged row.
    missing = [r for key, r in items.items() if key not in mentioned]
    if missing:
        line = next((n for n in nodes if n['type'] == 'line'), None)
        if not line:
            line = {'id': 'auto-line', 'type': 'line', 'title': quote.get('title') or '生产线', 'parentId': None}; nodes.append(line)
        chapter = {'id': 'auto-unassigned', 'type': 'chapter', 'title': '未归章设备', 'parentId': line['id']}
        if not any(n['id'] == chapter['id'] for n in nodes):
            nodes.append(chapter)
        nodes.extend({'id': 'item-' + r['id'], 'type': 'item', 'rowId': r['id'], 'parentId': chapter['id']} for r in missing)
    by_id = {n['id']: n for n in nodes}
    children = {}
    for node in nodes:
        children.setdefault(node.get('parentId'), []).append(node)
    sections, emitted = [], set()
    continuous = model.get('exportConfig', {}).get('chapters', {}).get('numberingMode', 'continuous') != 'configured'
    for line in children.get(None, []):
        section = {'id': line['id'], 'title': line['title'], 'chapters': [], 'subtotal': 0}
        counters, used_numbers = {}, {}

        def chapter_for(node, path):
            parent_id = node.get('parentId')
            auto = counters.get(parent_id, 0) + 1; counters[parent_id] = auto
            number = auto if continuous else node.get('number') or auto
            used = used_numbers.setdefault(parent_id, set())
            if number in used:
                raise ValueError('同一层级的手工章号重复')
            used.add(number)
            code = '.'.join(map(str, [*path, number]))
            chapter = {'id': node['id'], 'chapterNo': code, 'chapterTitle': (_cn(number) + '、' if not path else '（' + _cn(number) + '）') + _title(node['title']), 'rows': [], 'subtotal': 0, 'count': 0, 'missing': 0, 'lineId': line['id'], 'lineTitle': line['title']}
            section['chapters'].append(chapter)
            return chapter, [*path, number]

        def visit(node, chapter=None, path=None, parent_item=None):
            path = path or []
            if node['type'] == 'chapter':
                chapter, path = chapter_for(node, path); parent_item = None
            elif node['type'] in ('item', 'pending', 'note'):
                if chapter is None:
                    fallback = {'id': 'direct-' + line['id'], 'title': '设备明细', 'parentId': line['id']}
                    chapter, path = chapter_for(fallback, [])
                if node['type'] == 'pending':
                    row = raw_rows.get(node['rowId'], {})
                    from condition_binding import resolved as condition_resolved
                    if not (row.get('conditionBinding') and condition_resolved(row, quote.get('rows', []))):
                        chapter['rows'].append({'id': row.get('id', node['id']), 'type': 'pending', 'description': row.get('name', '') + '\n' + (row.get('rawSpec') or row.get('spec', '')) + '\n待内部核定供货做法及单价，未计入金额', 'name': row.get('name', ''), 'amount': None, 'quantity': None, 'unitPrice': None, 'unit': row.get('unit', ''), 'depth': parent_item['depth'] + 1 if parent_item else 0, 'code': '', 'rootId': parent_item['rootId'] if parent_item else node['id'], 'groupCode': parent_item['groupCode'] if parent_item else ''})
                elif node['type'] == 'note':
                    chapter['rows'].append({'id': node['id'], 'type': 'note', 'description': node.get('title', ''), 'name': '', 'amount': None, 'quantity': None, 'unitPrice': None, 'unit': '', 'depth': 0, 'code': '', 'rootId': parent_item['rootId'] if parent_item else node['id'], 'groupCode': parent_item['groupCode'] if parent_item else ''})
                elif node['rowId'] in items:
                    item = items[node['rowId']]
                    if item['id'] in emitted:
                        raise ValueError('报价版式出现重复供货项')
                    emitted.add(item['id'])
                    root_count = sum(1 for r in chapter['rows'] if r.get('type') not in ('note', 'pending') and not r.get('parentId')) + 1
                    sibling_count = sum(1 for r in chapter['rows'] if r.get('type') not in ('note', 'pending') and parent_item and r.get('parentId') == parent_item['id']) + 1
                    item.update(parentId=parent_item['id'] if parent_item else None, depth=parent_item['depth'] + 1 if parent_item else 0)
                    item['code'] = parent_item['code'] + '.' + str(sibling_count) if parent_item else str(chapter['chapterNo']) + '-' + f'{root_count:02}'
                    item['rootId'] = parent_item['rootId'] if parent_item else item['id']; item['groupCode'] = parent_item['groupCode'] if parent_item else item['code']
                    chapter['rows'].append(item); parent_item = item
            for child in children.get(node['id'], []):
                visit(child, chapter, path, parent_item)
        direct = [n for n in children.get(line['id'], []) if n['type'] != 'chapter']
        direct_chapter, direct_path = (chapter_for({'id': 'direct-' + line['id'], 'title': '设备明细', 'parentId': line['id']}, []) if direct else (None, []))
        for child in children.get(line['id'], []):
            visit(child, direct_chapter if child['type'] != 'chapter' else None, direct_path if child['type'] != 'chapter' else [])
        for ch in section['chapters']:
            supplies = [r for r in ch['rows'] if r.get('type') not in ('note', 'pending') and r.get('billing') != 'included']
            ch['count'] = len(supplies); ch['missing'] = sum(r['amount'] is None for r in supplies)
            ch['subtotal'] = float(sum((Decimal(str(r['amount'])) for r in supplies if r['amount'] is not None), Decimal(0)))
        section['subtotal'] = float(sum(Decimal(str(ch['subtotal'])) for ch in section['chapters']))
        sections.append(section)
    if emitted != set(items):
        raise ValueError('版式未覆盖全部供货项，请检查层级')
    locations = {r['id']: (section['title'], r) for section in sections for ch in section['chapters'] for r in ch['rows'] if r.get('type') != 'note'}
    for section in sections:
        for ch in section['chapters']:
            for item in ch['rows']:
                relation = item.get('relationText')
                if relation:
                    item['description'] = '\n'.join(line for line in item['description'].splitlines() if line != relation)
                related = [key for key in item.get('relatedIds', []) if key in locations]
                if len(related) > 1 or related and related[0] != item.get('parentId'):
                    item['description'] += '\n原配套关系：' + '、'.join((locations[key][0] + ' / ' if len(sections) > 1 else '') + locations[key][1]['code'] for key in related)
    model = copy.deepcopy(model)
    model['sections'] = sections; model['chapters'] = [ch for section in sections for ch in section['chapters']]
    model['document'] = document
    # Pricing notes must point to the current presentation codes.
    model['pricingNotes'] = [(r['code'] + ' ' + r['name'] + '：' + '；'.join(r.get('pricingNotes', []))) for ch in model['chapters'] for r in ch['rows'] if r.get('pricingNotes')]
    return model
