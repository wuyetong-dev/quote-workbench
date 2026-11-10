"""Validate source-condition ownership independently of browser resolved flags."""
import re
import unicodedata

VERSION = '2026-11-09.condition-binding.2'


def text(value):
    return unicodedata.normalize('NFKC', str(value or '')).strip()


def parent_id(row):
    return row.get('parentId') or (row.get('bom') or {}).get('parentId')


def condition(row, rows):
    parent = next((r for r in rows if r.get('id') == parent_id(row)), None)
    if not parent or parent.get('kind') == 'requirement' or (parent.get('bom') or {}).get('role') == 'requirement':
        return None
    spec = text(row.get('spec') or row.get('rawSpec'))
    lines = [s.strip() for s in spec.splitlines() if s.strip()]
    if not lines:
        return None
    temperature, ambient = False, True
    for line in lines:
        match = re.fullmatch(r'([^:：]+)[:：]\s*(.+)', line)
        if not match:
            return None
        label = re.sub(r'\s|\([^)]*\)', '', match[1].split('/')[-1])
        value = match[2].strip()
        if re.fullmatch(r'(?:工艺|处理|停留)?时间(?:MIN|S|秒|分钟)?', label, re.I):
            if not re.fullmatch(r'[\d\s.～~至–—\-]+(?:MIN|S|H|秒|分钟|分|小时)?', value, re.I):
                return None
        elif re.fullmatch(r'(?:工艺|工作)?温度(?:°?C|℃)?|槽温(?:°?C|℃)?', label, re.I):
            temperature = True
            if not re.fullmatch(r'室温|常温|RT', value, re.I):
                ambient = False
                if not re.fullmatch(r'[\d\s.～~至–—\-]+(?:°?C|℃)?', value, re.I):
                    return None
        elif match[1].startswith('使用场景/') and re.fullmatch(r'手动线|自动线|半自动线', label):
            if not re.fullmatch(r'√|✓|是|适用|有', value) or not (row.get('bom') or {}).get('sourceRanges'):
                return None
        else:
            return None
    hardware = [r['id'] for r in rows if parent_id(r) == parent['id'] and r.get('selected') is not False
                and r.get('kind') != 'requirement' and (r.get('bom') or {}).get('role') != 'requirement'
                and re.search('加温|加热|换热|冷却|制冷', r.get('name', ''))]
    if temperature and not ambient and not hardware:
        return None
    return dict(parentId=parent['id'], basis=spec, method='source-process-condition', hardwareIds=hardware if temperature and not ambient else [])


def resolved(row, rows):
    binding = row.get('conditionBinding')
    if not binding:
        return bool((row.get('bom') or {}).get('resolved'))
    current = condition(row, rows)
    parent = next((r for r in rows if r.get('id') == binding.get('parentId')), {})
    return bool(current and all(binding.get(k) == current[k] for k in ('parentId', 'basis', 'method'))
                and binding.get('hardwareIds', []) == current['hardwareIds']
                and any(e.get('requirementId') == row.get('id') and e.get('text') == binding.get('basis')
                        for e in parent.get('engineeringRequirements', [])))
