"""Delivery validation: priced subtotal and complete engineering scope differ."""
import json
import re

from calculation_engine import evaluate, inspect_quote
from formula_engine import basis as formula_basis


def stale_price(row, quote):
    """An old fine adjustment cannot revive an invalid automatic price basis."""
    if row.get('historyReuseBasis'):
        from source_audit import number
        qty=number(row.get('quantity'));rate=number(quote.get('taxRate'))
        current=[row.get('name') or '',row.get('spec') or '',row.get('unit') or '',row.get('brand') or '',float(qty) if qty is not None else None,row.get('supplyScope') or row.get('scope') or '',quote.get('currency') or 'CNY',quote.get('taxMode') or 'none',float(rate) if rate is not None else 0,quote.get('businessTerms') or '']
        if row['historyReuseBasis'] != current:
            return True
    if row.get('calculation'):
        return evaluate(row, quote)['status'] != 'priced'
    pricing = row.get('pricing') or {}
    if pricing.get('mode') in ('formula', 'assembly'):
        try:
            if json.loads(pricing.get('basis', '')) != formula_basis(row):
                return True
            if pricing.get('mode') == 'assembly' and pricing.get('dependencyBasis'):
                expected = [row.get('geometry'), (row.get('bom') or {}).get('memberGeometry'), row.get('extraPricing')]
                if row.get('assemblyResolution') or len(json.loads(pricing['dependencyBasis'])) > 3 + bool(row.get('linkedPricingPolicy')):
                    expected.insert(2, row.get('assemblyResolution'))
                if row.get('linkedPricingPolicy'):
                    expected.append(row['linkedPricingPolicy'])
                return json.loads(pricing['dependencyBasis']) != expected
        except (ValueError, TypeError):
            return True
    return False


def delivery_status(quote, prepared=None):
    from source_audit import audit
    summary = inspect_quote(quote, prepared)
    issues = list(summary['issues'])
    rows, by_id, seen_ids = quote.get('rows') or [], {}, set()

    def add(code, message, row=None, source=None):
        item = {'rowId': (row or {}).get('id') or '', 'code': code, 'message': message, 'field': None}
        if source:
            item['source'] = source
        if not any((old.get('rowId'), old['code'], old.get('source')) == (item['rowId'], code, item.get('source')) for old in issues):
            issues.append(item)

    for row in rows:
        key = row.get('id')
        if key:
            if key in seen_ids:
                add('duplicate_row_id', '报价明细编号重复，请重新导入或恢复工程', row)
            seen_ids.add(key)
            by_id[key] = row
    for fact in quote.get('quantityFacts') or []:
        targets = [by_id.get(key, {}) for key in fact.get('rowIds', [])]
        values = [row.get('quantity') for row in targets]
        complete = bool(values) and all(isinstance(v, (float, int)) and not isinstance(v, bool) and v >= 0 for v in values)
        if not complete or sum(values) != fact.get('value'):
            add('quantity_allocation', str(fact.get('name') or '设备') + '原表总量已知，配置分配尚未与总量核对一致', source=fact.get('id'))
    for row in rows:
        parent = row.get('parentId') or (row.get('bom') or {}).get('parentId')
        if row.get('engineeringBill') and row.get('selected') is not False:
            from engineering_calculation import evaluate as engineering_evaluate
            for message in engineering_evaluate(row)['issues']:
                issues.append(dict(rowId=row.get('id') or '', code='engineering', message=message, field='engineeringBill'))
        if parent and parent not in by_id:
            add('relationship', '所属主项已不存在，请重新确定包含范围', row)
        seen = {row.get('id')}
        while parent and parent in by_id:
            if parent in seen:
                add('relationship_cycle', '部件包含关系形成循环，请重新确定主项', row)
                break
            seen.add(parent)
            current = by_id[parent]
            parent = current.get('parentId') or (current.get('bom') or {}).get('parentId')
        if stale_price(row, quote) and row.get('selected') is not False:
            add('stale_price', '规格或计价依据已改变，原单价需重新确认', row)

    for source in quote.get('sources') or []:
        origin = source.get('filename') or source.get('id') or '资料'
        if source.get('type') == 'unmapped':
            add('mapping', '工序或字段尚未识别', source=origin)
        for page in source.get('pages') or []:
            reviewed = page.get('manualReview') or {}
            if (page.get('recognitionStatus') == 'pending' or (not str(page.get('text') or '').strip() and page.get('image'))) and not (reviewed.get('confirmedAt') and str(reviewed.get('reason') or '').strip()):
                add('recognition', '该页图片文字尚未识别', source=page.get('source') or origin)
    task = quote.get('aiTask') or {}
    for group in (quote.get('decomposition') or {}).get('reviewGroups') or []:
        if group.get('status') == 'pending':
            title=re.sub(r'^[a-z_]+(?=配置核对)', '设备', str(group.get('title') or '资料补查建议'))
            add('ai_review', title + '尚未核对', source=group.get('id'))
    state = task.get('status')
    reviewed = task.get('manualReview') or {}
    if state in ('queued', 'running', 'partial', 'failed', 'interrupted', 'key_required') and (state in ('queued', 'running') or not (reviewed.get('confirmedAt') and str(reviewed.get('reason') or '').strip())):
        labels = {'queued': '复杂资料补查等待处理', 'running': '复杂资料仍在补查', 'partial': '部分资料补查未完成', 'failed': '资料补查尚未完成', 'interrupted': '资料补查已中断', 'key_required': '图片或复杂资料补查需要配置DeepSeek'}
        add('ai', labels[state], source=task.get('jobId'))
    if not summary['selectedCount']:
        add('supply', '尚无已确认供货明细')

    # prepare() has already rejected stale fine adjustments in its copied rows.
    if prepared is not None:
        incomplete = [r for r in [*prepared.get('rows', []), *prepared.get('omitted', [])]
                      if r.get('selected') is not False and r.get('amount') is None
                      and r.get('kind') not in ('process', 'requirement')
                      and (r.get('bom') or {}).get('role') != 'requirement'
                      and (r.get('bom') or {}).get('supplyStatus') != 'included'
                      and (r.get('decomposition') or {}).get('relationship') != 'included']
        summary['unpricedCount'] = sum(r.get('unitPrice') is None for r in incomplete)
        for row in incomplete:
            if not any(i.get('rowId') == (row.get('id') or '') and i['code'] in ('quantity', 'price', 'stale_price') for i in issues):
                add('price', row.get('reason') or '待补数量或确认单价', row)
    source_result = audit(quote)
    issues.extend(source_result['issues'])
    summary['sourceAudit'] = source_result
    summary['issues'] = issues
    summary['canFinalize'] = bool(summary['selectedCount']) and not issues
    summary['status'] = 'ready' if summary['canFinalize'] else 'incomplete'
    return summary


def require_final(summary):
    if not summary.get('canFinalize'):
        messages = list(dict.fromkeys(i['message'] for i in summary['issues']))
        raise ValueError('正式报价尚有待确认项：' + '；'.join(messages[:5]))
