"""Versioned arithmetic contracts shared with web/calculation.js; no eval."""
import json
import unicodedata
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, ROUND_CEILING

VERSION = '2026-11-07.calculation.1'
KINDS = {'purchase_cost': '采购成本', 'estimate': '估算参考', 'enterprise_quote': '企业报价', 'confirmed_sale': '确认售价'}
SELL = {'enterprise_quote', 'confirmed_sale'}


def norm(value):
    return unicodedata.normalize('NFKC', str(value or '')).strip()


def number(value):
    if value is None or isinstance(value, bool) or str(value).strip() == '':
        return None
    try:
        n = Decimal(str(value))
        return n if n.is_finite() else None
    except (InvalidOperation, ValueError, TypeError):
        return None


def money(value):
    return value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)


def basis(row):
    bom = row.get('bom') or {}
    return [*[norm(row.get(k)) for k in ['name', 'spec', 'unit', 'brand']], row.get('geometry'),
            {'chamberCount': bom.get('chamberCount'), 'stationMembers': bom.get('stationMembers') or [], 'supplyStatus': bom.get('supplyStatus') or ''},
            norm(row.get('supplyScope', row.get('scope')))]


def arithmetic(expression, parameters):
    count = 0

    def run(node, depth=0):
        nonlocal count
        count += 1
        if count > 128 or depth > 16:
            raise ValueError('公式过长，请分成独立计算项')
        if isinstance(node, (int, float, Decimal)) and not isinstance(node, bool) or isinstance(node, str) and re.fullmatch(r'-?\d+(?:\.\d+)?', node):
            value = number(node)
            if value is None or abs(value) > Decimal('1e30'):
                raise ValueError('计算参数不是有效数字')
            return value
        if not isinstance(node, dict):
            raise ValueError('公式节点无效')
        if set(node) == {'param'} and isinstance(node['param'], str):
            if node['param'] not in parameters:
                raise ValueError('缺少参数 ' + node['param'])
            return Decimal(str(parameters[node['param']]))
        args = node.get('args')
        if set(node) - {'op', 'args'} or not isinstance(args, list) or not 0 < len(args) <= 32:
            raise ValueError('公式运算无效')
        values = [run(n, depth + 1) for n in args]
        op = node.get('op')
        if op == 'add':
            value = sum(values)
        elif op == 'mul':
            value = Decimal(1)
            for item in values:
                value *= item
        elif op == 'sub' and len(values) == 2:
            value = values[0] - values[1]
        elif op == 'div' and len(values) == 2:
            if not values[1]:
                raise ValueError('计算分母不能为零')
            value = values[0] / values[1]
        elif op == 'min':
            value = min(values)
        elif op == 'max':
            value = max(values)
        elif op == 'round' and len(values) == 1:
            value = money(values[0])
        elif op == 'ceil' and len(values) == 1:
            value = values[0].to_integral_value(rounding=ROUND_CEILING)
        else:
            raise ValueError('不支持的公式运算')
        if not value.is_finite() or abs(value) > Decimal('1e15'):
            raise ValueError('计算中间值超出范围')
        return value

    return run(expression)


def evaluate(row, quote=None):
    quote = quote or {}
    c = row.get('calculation') or {}
    out = {'version': VERSION, 'method': c.get('method'), 'priceKind': c.get('priceKind'), 'basePrice': None, 'value': None, 'status': 'missing', 'missing': [], 'issues': [], 'steps': []}
    try:
        if c.get('version') != VERSION:
            raise ValueError('计价规则版本不可用')
        if c.get('priceKind') not in KINDS:
            raise ValueError('请选择价格口径')
        try:
            matches = json.loads(c.get('basis', '')) == basis(row)
        except (TypeError, ValueError):
            matches = False
        if not matches:
            return dict(out, status='stale', issues=['规格或供货范围已改变，原计价条件待重新确认'])
        if c.get('confirmed') is not True or not norm(c.get('confirmedBy')):
            return dict(out, status='unconfirmed', issues=['此计价方法尚未确认'])
        value = None
        if c.get('method') == 'fixed':
            value = number(c.get('unitPrice'))
            if value is None or value < 0:
                value = None
                out['missing'].append('确认单价')
        elif c.get('method') == 'rule':
            matches = [r for r in quote.get('calculationRules') or [] if r.get('id') == c.get('ruleId') and r.get('version') == c.get('ruleVersion')]
            if len(matches) != 1:
                raise ValueError('找不到唯一的当前公式版本')
            rule = matches[0]
            if rule.get('approved') is not True or not norm(rule.get('approvedBy')):
                raise ValueError('企业公式尚未由负责人确认')
            try:
                approved = json.loads(c.get('ruleBasis', ''))
            except (TypeError, ValueError):
                raise ValueError('公式依据缺失')
            if approved != rule:
                return dict(out, status='stale', issues=['公式内容或审批状态已改变，请重新确认'])
            if rule.get('priceKind') != c.get('priceKind'):
                raise ValueError('公式输出的价格口径不一致')
            parameters, parameter_ids = {}, set()
            import re
            definitions = rule.get('parameters') or []
            if not isinstance(definitions, list) or len(definitions) > 64:
                raise ValueError('公式参数定义无效')
            for p in definitions:
                key = p.get('id')
                if not isinstance(key, str) or not re.fullmatch(r'[_A-Za-z][_A-Za-z0-9]{0,39}', key) or key in parameter_ids or key in {'__proto__', 'prototype', 'constructor'}:
                    raise ValueError('公式参数定义无效')
                parameter_ids.add(key)
                raw = (c.get('parameters') or {}).get(key)
                if isinstance(raw, dict):
                    if raw.get('field'):
                        field = raw['field']
                        if not re.fullmatch(r'quantity|geometry\.(?:length|width|height|thickness|diameter|density|chambers)', field):
                            raise ValueError('参数绑定字段无效')
                        resolved = row
                        for part in field.split('.'):
                            resolved = resolved.get(part) if isinstance(resolved, dict) else None
                        raw_value = resolved
                    else:
                        raw_value = raw.get('value')
                    if 'unit' in raw and 'unit' in p and raw['unit'] != p['unit']:
                        out['issues'].append((p.get('label') or key) + '单位应为 ' + p['unit'])
                    raw = raw_value
                n = number(raw)
                if n is None:
                    out['missing'].append(p.get('label') or key)
                elif n < Decimal(str(p.get('min', 0))) or n > Decimal(str(p.get('max', '1e9'))):
                    out['issues'].append((p.get('label') or key) + '超出范围')
                else:
                    parameters[key] = n
            if not out['missing'] and not out['issues']:
                value = arithmetic(rule.get('expression'), parameters)
                out['steps'] = [{'name': key, 'value': float(n)} for key, n in parameters.items()]
        elif c.get('method') == 'components':
            components = c.get('components')
            if not isinstance(components, list) or not 0 < len(components) <= 200:
                raise ValueError('请填写成套计价组成')
            subtotal, kinds = Decimal(0), set()
            for index, part in enumerate(components):
                label = norm(part.get('name')) or '组成' + str(index + 1)
                quantity, price = number(part.get('quantity')), number(part.get('unitPrice'))
                if quantity is None or quantity < 0:
                    out['missing'].append(label + '用量')
                if price is None or price < 0:
                    out['missing'].append(label + '单价')
                if part.get('confirmed') is not True or part.get('priceKind') not in KINDS:
                    out['issues'].append(label + '价格依据待确认')
                kinds.add(part.get('priceKind'))
                if quantity is not None and price is not None and quantity >= 0 and price >= 0:
                    subtotal += quantity * price
                    out['steps'].append({'name': label, 'value': float(money(quantity * price)), 'priceKind': part.get('priceKind')})
            if 'purchase_cost' in kinds:
                if len(kinds) != 1:
                    out['issues'].append('采购成本与售价不能直接混加')
                if c.get('priceKind') in SELL:
                    policy = c.get('salePolicy') or {}
                    if policy.get('confirmed') is not True or not norm(policy.get('confirmedBy')) or policy.get('method') not in {'markup', 'margin'}:
                        out['issues'].append('成本转报价需确认成本加成或毛利口径')
                    else:
                        rate = number(policy.get('percent'))
                        if rate is None or rate < 0 or rate > 1000 or policy['method'] == 'margin' and rate >= 100:
                            out['issues'].append('成本报价比例无效')
                        else:
                            subtotal = subtotal / (1 - rate / 100) if policy['method'] == 'margin' else subtotal * (1 + rate / 100)
            elif kinds - SELL and c.get('priceKind') in SELL:
                out['issues'].append('估算参考不能直接作为确认售价')
            if not out['missing'] and not out['issues']:
                value = subtotal
        else:
            raise ValueError('请选择适用的计价方法')
        if value is not None:
            value = money(value)
            if not value.is_finite() or not 0 <= value <= Decimal('1e12'):
                raise ValueError('计算结果超出有效范围')
            out['value'] = float(value)
            out['basePrice'] = float(value) if c['priceKind'] in SELL else None
            out['status'] = 'priced' if out['basePrice'] is not None else 'reference'
            if out['basePrice'] is None:
                out['issues'].append(KINDS[c['priceKind']] + '仅作参考，尚未形成确认报价')
        elif out['issues']:
            out['status'] = 'invalid'
        return out
    except (ValueError, TypeError, ArithmeticError, AttributeError, KeyError) as exc:
        return dict(out, status='invalid', basePrice=None, issues=[str(exc)])


def inspect_quote(quote, prepared=None):
    """Completeness is separate from the priced subtotal, including requirements."""
    from formula_engine import base_price, is_requirement, is_included
    from condition_binding import resolved as condition_resolved
    rows = quote.get('rows') or []
    issues, identities = [], {}
    by_id = {r.get('id'): r for r in rows}
    counts = dict(selectedCount=0, unpricedCount=0, requirementCount=0, unresolvedRequirementCount=0, includedCount=0, excludedCount=0, pendingAdditionCount=0)
    def add(row, code, message, field=None):
        issues.append({'rowId': row.get('id') or '', 'code': code, 'message': message, 'field': field})
    for row in rows:
        if (row.get('decomposition') or {}).get('reviewState') == 'pending':
            add(row, 'candidate_review', '候选设备的来源或供货范围待确认', 'scope')
        if (row.get('duplicateReview') or {}).get('status') == 'pending':
            add(row, 'duplicate_review', '多份资料可能重复描述同一设备，待确认', 'selected')
        seen, parent = {row.get('id')}, row.get('parentId') or (row.get('bom') or {}).get('parentId')
        if parent and parent not in by_id:
            add(row, 'relationship', '所属主项已不存在，请重新确定包含范围', 'parentId')
        while parent and parent in by_id:
            if parent in seen:
                add(row, 'relationship_cycle', '部件包含关系形成循环', 'parentId')
                break
            seen.add(parent)
            current = by_id[parent]
            parent = current.get('parentId') or (current.get('bom') or {}).get('parentId')
        if is_requirement(row) or row.get('kind') == 'process':
            counts['requirementCount'] += 1
            review = row.get('scopeReview') or {}
            if not condition_resolved(row, rows) and not (review.get('status') == 'requirement_only' and review.get('confirmedAt')):
                counts['unresolvedRequirementCount'] += 1
                add(row, 'scope', '待确认供货范围', 'scope')
            continue
        if is_included(row):
            counts['includedCount'] += 1
            parent = row.get('parentId') or (row.get('bom') or {}).get('parentId')
            if not parent or parent not in by_id:
                add(row, 'included_parent', '包内子项缺少有效主项', 'parentId')
            continue
        if row.get('selected') is False:
            counts['excludedCount'] += 1
            continue
        counts['selectedCount'] += 1
        if number(row.get('quantity')) is None or number(row.get('quantity')) < 0:
            add(row, 'quantity', '待填数量', 'quantity')
        evaluated = evaluate(row, quote) if row.get('calculation') else {}
        invalid = bool(row.get('calculation')) and evaluated.get('status') != 'priced'
        if not row.get('calculation') and (row.get('pricing') or {}).get('mode') in ('formula', 'assembly'):
            try:
                from formula_engine import basis as formula_basis
                invalid = json.loads(row['pricing'].get('basis', '')) != formula_basis(row)
                if row['pricing'].get('mode') == 'assembly' and row['pricing'].get('dependencyBasis'):
                    expected = [row.get('geometry'), (row.get('bom') or {}).get('memberGeometry'), row.get('extraPricing')]
                    if row.get('linkedPricingPolicy'):
                        expected.append(row['linkedPricingPolicy'])
                    invalid = invalid or json.loads(row['pricing']['dependencyBasis']) != expected
            except (TypeError, ValueError):
                invalid = True
        unit = None if invalid else number(row.get('override'))
        if unit is None:
            unit = None if invalid else number(base_price(row, quote))
        if unit is None:
            counts['unpricedCount'] += 1
            add(row, 'stale_price' if evaluated.get('status') == 'stale' else 'price', (evaluated.get('issues') or ['待补确认单价'])[0], 'basePrice')
        for message in (row.get('pricing') or {}).get('pendingInclusions') or []:
            counts['pendingAdditionCount'] += 1
            add(row, 'price_scope', message, 'pricing')
        object_id = (row.get('engineering') or {}).get('objectId') or row.get('engineeringId') or (row.get('bom') or {}).get('objectId')
        if object_id:
            if object_id in identities:
                add(row, 'duplicate', '同一工程对象被重复计入报价', 'selected')
            else:
                identities[object_id] = row.get('id')
    ready = bool(counts['selectedCount']) and not issues
    return dict(version=VERSION, status='ready' if ready else 'incomplete', canFinalize=ready, **counts, duplicateCount=sum(i['code'] in ('duplicate', 'duplicate_review') for i in issues), issues=issues)
