"""Business-owned export layout, with optimistic saves and a pure export view.

Sources: bundled export_config.json, DATA/export-config.json, prepared quote.
Consumers: settings editor/preview and business Excel/PDF model. Never prices.
"""
import copy
import json
import re
import threading
import uuid
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

VERSION = '2026-11-08.visual-export.1'
ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
COLUMN_KEYS = {'code', 'description', 'quantity', 'unit', 'unitPrice', 'amount'}
PART_KEYS = {'name', 'length', 'width', 'height', 'material', 'thickness', 'reinforcement', 'brand', 'remainingConfirmedSpec', 'relatedParentCodes'}


def defaults():
    value = json.loads((ROOT / 'export_config.json').read_text(encoding='utf-8'))
    for chapter in value['chapters']['definitions']:
        chapter['sourceChapterNumbers'] = [chapter['number']]
    return value


def _text(value, label, maximum=120, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError(label + '不能为空或过长')
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value):
        raise ValueError(label + '包含不支持的控制字符')
    return value.strip()


def _number(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not low <= value <= high:
        raise ValueError(label + '超出范围')
    return value


def validate(config):
    if not isinstance(config, dict) or len(json.dumps(config, ensure_ascii=False, allow_nan=False)) > 100000:
        raise ValueError('报价单格式无效或过大')
    c = copy.deepcopy(config)
    if c.get('schemaVersion') != 1:
        raise ValueError('报价单格式版本不兼容，请刷新页面')
    try:
        if c['chapters'].get('numberingMode', 'continuous') not in ('continuous', 'configured'):
            raise ValueError('章节编号方式无效')
        if not isinstance(c['hierarchy'].get('mergeParentCode', True), bool):
            raise ValueError('主设备序号合并方式无效')
        chapters = c['chapters']['definitions']
        if not isinstance(chapters, list) or not 1 <= len(chapters) <= 40:
            raise ValueError('请保留1–40个章节')
        ids, numbers = set(), set()
        for chapter in chapters:
            chapter['id'] = _text(chapter.get('id'), '章节编号')
            chapter['title'] = _text(chapter.get('title'), '章节名称')
            if not re.sub(r'^[一二三四五六七八九十百\d]+[、.．]\s*', '', chapter['title']).strip():
                raise ValueError('章节名称不能为空')
            n = _number(chapter.get('number'), '章节序号', 1, 99)
            if int(n) != n or n in numbers or chapter['id'] in ids:
                raise ValueError('章节编号重复或无效')
            ids.add(chapter['id']); numbers.add(n)
            sources = chapter.get('sourceChapterNumbers', [])
            if not isinstance(sources, list) or any(type(v) is not int or v < 1 or v > 99 for v in sources):
                raise ValueError('原分类映射无效')
            terms = chapter.get('nameContains', [])
            if not isinstance(terms, list) or len(terms) > 20:
                raise ValueError('设备名称条件过多')
            chapter['nameContains'] = [_text(v, '设备名称条件', 60) for v in terms]
        columns = c['columns']
        keys = {v.get('key') for v in columns} if isinstance(columns, list) else set()
        if not isinstance(columns, list) or len(columns) != len(keys) or keys not in (COLUMN_KEYS, COLUMN_KEYS | {'name'}):
            raise ValueError('报价列定义无效')
        for column in columns:
            _text(column.get('label'), '列名称', 30)
            _number(column.get('width'), '列宽', 6, 100)
            if column.get('align') not in ('left', 'center', 'right'):
                raise ValueError('列对齐无效')
            if not isinstance(column.get('visible', True), bool):
                raise ValueError('列显示设置无效')
            if column['key'] in ('description', 'quantity', 'unitPrice', 'amount') and column.get('visible') is False:
                raise ValueError('名称、数量、单价和金额列必须显示')
        _text(c['workbook']['title']['text'], '报价单标题')
        if c['workbook']['page']['orientation'] not in ('portrait', 'landscape'):
            raise ValueError('纸张方向无效')
        for key in ('root', 'child'):
            pattern = _text(c['hierarchy']['numbering'][key], '编号格式')
            allowed = {'chapter.number', 'sequence:02', 'sequence', 'parent.code', 'childSequence'}
            if any(v not in allowed for v in re.findall(r'\{([^{}]+)\}', pattern)):
                raise ValueError('编号格式包含未知字段')
        _number(c['hierarchy']['indent']['perLevel'], '配件缩进', 0, 4)
        _number(c['styles']['base']['font']['size'], '字号', 9, 16)
        if c['styles']['base']['font']['name'] not in ('宋体', '微软雅黑', '等线'):
            raise ValueError('字体无效')
        if c['styles']['base']['border']['edges'] not in ('all', 'none'):
            raise ValueError('边框设置无效')
        for key in ('columnHeader', 'subtotal'):
            if not re.fullmatch(r'[0-9A-Fa-f]{6}', c['styles'][key]['fill']):
                raise ValueError('表格颜色无效')
        parts = c['description']['parts']
        if not isinstance(parts, list) or not 1 <= len(parts) <= 20:
            raise ValueError('配置说明无效')
        for part in parts:
            if not isinstance(part.get('fields'), list) or any(k not in PART_KEYS for k in part['fields']):
                raise ValueError('配置说明字段无效')
            if not isinstance(part.get('enabled', True), bool):
                raise ValueError('配置说明显示设置无效')
        if not any('name' in part['fields'] and part.get('enabled', True) for part in parts):
            raise ValueError('配置说明必须保留设备名称')
    except (KeyError, TypeError, AttributeError):
        raise ValueError('报价单格式字段不完整') from None
    return c


def load(data):
    path = Path(data) / 'export-config.json'
    if not path.exists():
        return {'revision': 0, 'version': VERSION, 'config': defaults()}
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return {'revision': value['revision'], 'version': VERSION, 'config': validate(value['config'])}
    except (ValueError, KeyError, TypeError):
        raise ValueError('已保存的报价单格式读取失败，请恢复备份后重试') from None


def save(data, body):
    config = validate(body.get('config'))
    with LOCK:
        current = load(data)
        if type(body.get('revision')) is not int or body['revision'] != current['revision']:
            raise ValueError('报价单格式已在其他页面修改，请重新读取后再保存')
        value = {'revision': current['revision'] + 1, 'version': VERSION, 'config': config}
        folder = Path(data); folder.mkdir(parents=True, exist_ok=True)
        temp = folder / ('export-config.' + uuid.uuid4().hex + '.tmp')
        try:
            temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding='utf-8')
            temp.replace(folder / 'export-config.json')
        finally:
            temp.unlink(missing_ok=True)
        return value


def _render(pattern, values):
    return re.sub(r'\{([^{}]+)\}', lambda m: str(values.get(m[1], '')), pattern)


def _cn(number):
    digits = '零一二三四五六七八九'
    if number < 10:
        return digits[number]
    tens, units = divmod(number, 10)
    return (digits[tens] if tens > 1 else '') + '十' + (digits[units] if units else '')


def _heading(title, number):
    return _cn(number) + '、' + re.sub(r'^[一二三四五六七八九十百\d]+[、.．]\s*', '', title)


def apply(model, result, config):
    """Reorder/describe prepared supplies without recomputing any price."""
    c = validate(config)
    model = copy.deepcopy(model)
    source_rows = {r.get('id'): r for r in result['quote'].get('rows', [])}
    items = [r for ch in model['chapters'] for r in ch['rows']]
    by_id = {r['id']: r for r in items}
    source_chapter = {r['id']: ch for ch in model['chapters'] for r in ch['rows']}
    definitions = c['chapters']['definitions']
    default_titles = {d['number']: d['title'] for d in defaults()['chapters']['definitions']}
    default_sources = set(default_titles)
    assigned, parents = {}, {}
    for item in items:
        raw = source_rows.get(item['id'], {})
        links = {(raw.get('business') or {}).get('parentId'), raw.get('parentId'), (raw.get('bom') or {}).get('parentId')} - {None, ''}
        related = list(dict.fromkeys([*(raw.get('business') or {}).get('relatedParentIds', []), *(raw.get('bom') or {}).get('relatedParentIds', [])]))
        shared = len(related) > 1 or (raw.get('bom') or {}).get('shared') or (raw.get('bom') or {}).get('role') == 'shared'
        parent = next(iter(links)) if len(links) == 1 and not shared else None
        parents[item['id']] = parent if parent in by_id else None
        item['relatedIds'] = related
        if len(links) > 1:
            item['layoutNote'] = '配套归属有多种记录，暂单独列项'
        elif parent and parent not in by_id:
            item['layoutNote'] = '配套主项未列入本次报价，暂单独列项'
        match = next((d for d in definitions if d['id'] == raw.get('exportChapterId')), None)
        if not match:
            match = next((d for d in definitions if any(term.casefold() in item['name'].casefold() for term in d.get('nameContains', []))), None)
        if not match:
            old = source_chapter[item['id']]['chapterNo']
            original_title = source_chapter[item['id']]['chapterTitle']
            standard = default_titles.get(old, '')
            custom_source = result['quote'].get('decomposition') and original_title != standard
            match = None if custom_source else next((d for d in definitions if old in d.get('sourceChapterNumbers', [])), None)
        if not match:
            old = source_chapter[item['id']]
            # Retain custom source chapters; deleting a mapped chapter collects
            # its supplies in an explicit remainder instead of dropping them.
            key = 'source-' + str(old['chapterNo']) if old['chapterNo'] not in default_sources or result['quote'].get('decomposition') else 'unassigned'
            match = next((d for d in definitions if d['id'] == key), None)
            if not match:
                match = {'id': key, 'number': max(d['number'] for d in definitions) + 1,
                         'title': old['chapterTitle'] if key != 'unassigned' else '其他设备'}
                definitions.append(match)
        assigned[item['id']] = match['id']
    counts, children, roots = {}, {}, []
    for item in items:
        parent = parents[item['id']]
        if parent:
            children.setdefault(parent, []).append(item)
        else:
            roots.append(item)
    visiting, visited = set(), set()
    def check(key):
        if len(visiting) > 100:
            raise ValueError('设备配套层级超过100层，请核对主从关系')
        if key in visiting:
            raise ValueError('设备配套关系存在循环，请先核对主从关系')
        if key in visited:
            return
        visiting.add(key)
        if parents[key]:
            check(parents[key])
        visiting.remove(key); visited.add(key)
    for key in by_id:
        check(key)
    active = {assigned[root['id']] for root in roots}
    continuous = c['chapters'].get('numberingMode', 'continuous') == 'continuous'
    visible = [d for d in definitions if d['id'] in active or not c['chapters']['hideEmpty']]
    chapters = {d['id']: {'id': d['id'], 'chapterNo': n if continuous else d['number'],
                         'chapterTitle': _heading(d['title'], n) if continuous else d['title'],
                         'rows': [], 'subtotal': 0, 'count': 0, 'missing': 0}
                for n, d in enumerate(visible, 1)}
    def visit(item, chapter_id, parent=None, child_sequence=0):
        ch = chapters[chapter_id]
        counts[chapter_id] = counts.get(chapter_id, 0) + (0 if parent else 1)
        values = {'chapter.number': ch['chapterNo'], 'sequence': counts[chapter_id], 'sequence:02': f"{counts[chapter_id]:02d}", 'parent.code': parent['code'] if parent else '', 'childSequence': child_sequence}
        item['code'] = _render(c['hierarchy']['numbering']['child' if parent else 'root'], values)
        item['depth'] = parent['depth'] + 1 if parent else 0
        item['parentCode'] = parent['code'] if parent else ''
        item['parentId'] = parent['id'] if parent else None
        item['rootId'] = parent['rootId'] if parent else item['id']
        item['groupCode'] = parent['groupCode'] if parent else item['code']
        ch['rows'].append(item)
        for n, child in enumerate(children.get(item['id'], []), 1):
            visit(child, chapter_id, item, n)
    for definition in visible:
        for root in roots:
            if assigned[root['id']] == definition['id']:
                visit(root, definition['id'])
    if len({item['code'] for item in items}) != len(items):
        raise ValueError('生成的设备序号重复，请调整编号格式')
    for item in items:
        raw = source_rows.get(item['id'], {})
        geometry = raw.get('geometry') or {}
        params = (raw.get('pricing') or {}).get('params') or {}
        facts = {key: geometry.get(key, params.get(key, raw.get(key))) for key in ('length', 'width', 'height', 'material', 'thickness')}
        # A special structure may block a formula without invalidating known
        # dimensions. Only actual conflicting parameters suppress these facts.
        if raw.get('parameterConflicts'):
            facts = {}
        # No structural default is introduced by a layout operation.
        facts.update(name=item['name'], brand=raw.get('brand', ''), reinforcement=raw.get('reinforcement', ''), remainingConfirmedSpec=item['spec'],
                     relatedParentCodes='、'.join(by_id[key]['code'] for key in item['relatedIds'] if key in by_id))
        spec_lines = facts['remainingConfirmedSpec'].splitlines()
        if all(facts.get(k) not in (None, '') for k in ('length', 'width', 'height')):
            spec_lines = [line for line in spec_lines if not re.fullmatch(r'长[\d.]+mm\s+宽[\d.]+mm\s+高[\d.]+mm(?:\s+厚度[\d.]+mm)?(?:\s+材质\S+)?', line.strip())]
        facts['remainingConfirmedSpec'] = '\n'.join(spec_lines)
        if raw.get('quoteRemark'):
            facts['remainingConfirmedSpec'] += ('\n' if facts['remainingConfirmedSpec'] else '') + str(raw['quoteRemark'])
        pieces = []
        item['relationText'] = ''
        for part in c['description']['parts']:
            if not part.get('enabled', True):
                continue
            fields = part['fields']
            present = [key for key in fields if facts.get(key) not in (None, '', [])]
            if not present or part.get('require') == 'all' and len(present) != len(fields):
                continue
            if part.get('items'):
                text = part.get('join', '，').join(_render(p['text'], facts) for p in part['items'] if facts.get(p['field']) not in (None, '', []))
            else:
                text = _render(part.get('text', ''), facts)
            if text and text not in pieces:
                pieces.append(text)
                if 'relatedParentCodes' in fields:
                    item['relationText'] = text
        if item.get('layoutNote'):
            pieces.append(item['layoutNote'])
        if item.get('billing') == 'included':
            pieces.append('已含在主设备报价，不另计')
        item['description'] = c['description'].get('join', '\n').join(pieces)
    for chapter in chapters.values():
        chapter['count'] = sum(r.get('billing') != 'included' for r in chapter['rows'])
        chapter['missing'] = sum(r['amount'] is None and r.get('billing') != 'included' for r in chapter['rows'])
        chapter['subtotal'] = float(sum((Decimal(str(r['amount'])) for r in chapter['rows'] if r['amount'] is not None), Decimal(0)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))
    model['chapters'] = [chapters[d['id']] for d in visible]
    if sum(ch['count'] for ch in model['chapters']) != model['selectedCount']:
        raise ValueError('排版后的供货项数不一致，请核对配套关系')
    model['exportConfig'] = c
    model['columns'] = [col['label'] for col in c['columns']]
    model['excelWidths'] = [col['width'] for col in c['columns']]
    return model
