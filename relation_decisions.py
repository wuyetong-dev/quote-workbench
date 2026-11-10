"""Ground relation proposals in the requested objects and original excerpts.

No prices are accepted. Geometry similarity alone never authorizes a write.
"""
import copy
import math
import re
import unicodedata


def norm(value):
    return re.sub(r'\s', '', unicodedata.normalize('NFKC', str(value or '')))


def tasks(body, fragments):
    values = body.get('relationTasks', [])
    if not isinstance(values, list) or len(values) > 500:
        raise ValueError('关系任务无效')
    allowed = {f['id'] for f in fragments}
    row_ids = {r['id'] for r in body.get('baseline', [])}
    result = []
    for t in values:
        if not isinstance(t, dict) or t.get('type') not in ('allocation', 'assembly') or not isinstance(t.get('id'), str):
            raise ValueError('关系任务格式无效')
        refs = t.get('sourceIds', [])
        if not isinstance(refs, list) or any(ref not in allowed for ref in refs):
            raise ValueError('关系任务来源无效')
        targets = t.get('targets', [])
        if not isinstance(targets, list) or not targets or any(not isinstance(r, dict) or not isinstance(r.get('rowId'), str) for r in targets):
            raise ValueError('关系任务设备无效')
        if len({r['rowId'] for r in targets}) != len(targets) or any(r['rowId'] not in row_ids or any(s not in allowed for s in r.get('sourceIds', [])) for r in targets):
            raise ValueError('关系任务设备不属于本次资料')
        if not isinstance(t.get('basis'), str):
            raise ValueError('关系任务缺少原始状态')
        if t['type'] == 'allocation' and (not isinstance(t.get('total'), (int, float)) or isinstance(t['total'], bool) or not math.isfinite(t['total']) or t['total'] < 0):
            raise ValueError('关系总量无效')
        clean = copy.deepcopy({k: t[k] for k in ('id', 'type', 'name', 'total', 'unit', 'chambers', 'geometry', 'sourceIds', 'evidence', 'basis', 'pricingPolicy') if k in t})
        clean['targets'] = [{k: copy.deepcopy(r[k]) for k in ('rowId', 'name', 'owner', 'quantity', 'unit', 'sourceIds', 'geometry') if k in r} for r in targets]
        result.append(clean)
    return result


def validate(payload, requested, fragments):
    proposals = payload.get('relationDecisions', []) if isinstance(payload, dict) else []
    if not isinstance(proposals, list) or len(proposals) > 500:
        return [], [{'reason': '关系结果格式无效'}]
    by_id, sources = {t['id']: t for t in requested}, {f['id']: f['text'] for f in fragments}
    kept, rejected = [], []
    for p in proposals:
        try:
            if not isinstance(p, dict) or p.get('taskId') not in by_id:
                raise ValueError('关系任务不匹配')
            t = by_id[p['taskId']]
            evidence = p.get('evidence', [])
            if not isinstance(evidence, list) or not evidence or len(evidence) > 100:
                raise ValueError('缺少原文依据')
            proof = []
            for e in evidence:
                if not isinstance(e, dict) or e.get('sourceId') not in t['sourceIds'] or not norm(e.get('quote')) or norm(e['quote']) not in norm(sources.get(e['sourceId'], '')):
                    raise ValueError('关系依据与原文不符')
                proof.append({'sourceId': e['sourceId'], 'quote': e['quote']})
            d = {'taskId': t['id'], 'taskBasis': t['basis'], 'type': t['type'], 'evidence': proof, 'reason': str(p.get('reason', ''))[:200]}
            if t['type'] == 'allocation':
                allocations = p.get('allocations', [])
                ids = {r['rowId'] for r in t['targets']}
                if not isinstance(allocations, list) or len(allocations) != len(ids):
                    raise ValueError('分配对象未齐')
                used, values = set(), []
                for a in allocations:
                    if not isinstance(a, dict) or a.get('rowId') not in ids or a['rowId'] in used:
                        raise ValueError('分配对象不匹配')
                    n = a.get('quantity')
                    if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n) or not 0 <= n <= 1e12:
                        raise ValueError('分配数量无效')
                    used.add(a['rowId'])
                    values.append({'rowId': a['rowId'], 'quantity': n})
                if abs(sum(a['quantity'] for a in values) - t['total']) > 1e-8:
                    raise ValueError('分配合计不符')
                d['allocations'] = values
            else:
                if p.get('dimensions') not in ('section', 'total_length', 'total_width', 'total_height'):
                    raise ValueError('尺寸含义尚未确定')
                d['dimensions'] = p['dimensions']
            # The client rechecks ownership and in-flight edits before applying.
            # Provider confidence, numeric prices and unsolicited row edits drop.
            kept.append(d)
        except (ValueError, KeyError, TypeError) as e:
            rejected.append({'taskId': p.get('taskId') if isinstance(p, dict) else '', 'reason': str(e)})
    return kept, rejected
