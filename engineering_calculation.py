"""Physical quantities from explicit geometry and user-owned rates; no design guesses."""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re


def evaluate(row):
    bill = row.get('engineeringBill') or {}
    geometry = dict(row.get('geometry') or {})
    # Inline specification edits must not leave a stale geometry price behind.
    for key, label in [('length', '长度|长'), ('width', '宽度|宽'), ('height', '高度|高'), ('thickness', '板厚|厚度|厚')]:
        matches = re.findall(r'(?:' + label + r')\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)?', str(row.get('spec') or ''), re.I)
        values = {Decimal(n) * (1000 if u.lower() in ('m', '米') else 10 if u.lower() in ('cm', '厘米') else 1) for n, u in matches}
        if len(values) == 1:
            geometry[key] = next(iter(values))
        elif len(values) > 1:
            geometry[key] = None
    def n(v):
        try:
            if v is None or v == '' or isinstance(v, bool):
                return None
            value = Decimal(str(v))
            return value if value.is_finite() and 0 <= value <= Decimal('1e12') else None
        except (ValueError, TypeError, InvalidOperation):
            return None
    def rounded(v):
        return v.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    total, ready, steps, issues = Decimal(0), 0, [], []
    for i, item in enumerate(bill.get('items') or []):
        label = item.get('name') or '组成' + str(i+1)
        get = lambda key: n(geometry.get(item['bindings'][key]) if (item.get('bindings') or {}).get(key) else item.get(key))
        count, rate, quantity, unit = get('count'), get('rate'), None, '件'
        method = item.get('method')
        if method == 'plate':
            vals = [get(k) for k in ('length', 'width', 'thickness', 'density', 'count')]
            if all(v is not None for v in vals):
                a, b, c, d, e = vals
                quantity = a*b*c*d*e/Decimal('1e9')
            unit = 'kg'
        elif method in ('section', 'pipe'):
            vals = [get(k) for k in ('length', 'kgPerM', 'count')]
            if all(v is not None for v in vals):
                a, b, c = vals
                quantity = a/1000*b*c
            unit = 'kg'
        elif method == 'area':
            vals = [get(k) for k in ('length', 'width', 'count')]
            if all(v is not None for v in vals):
                a, b, c = vals
                quantity = a*b*c/Decimal('1e6')
            unit = '㎡'
        elif method in ('unit', 'labour'):
            quantity, unit = count, '小时' if method == 'labour' else item.get('unit') or '件'
        loss = n(item.get('loss', 0))
        amount = None
        if loss is None or loss > 100:
            issues.append(label + '损耗比例无效')
        if quantity is not None and rate is not None and loss is not None and loss <= 100:
            quantity *= 1+loss/100
            amount = rounded(quantity*rate)
            total += amount
            ready += 1
        else:
            issues.append(label+'缺'+('工程量条件' if quantity is None else '')+('及' if quantity is None and rate is None else '')+('单价依据' if rate is None else ''))
        steps.append(dict(name=label, method=method, quantity=float(quantity) if quantity is not None else None, unit=unit, rate=float(rate) if rate is not None else None, amount=float(amount) if amount is not None else None, source=item.get('source') or ''))
    if not steps:
        issues.append('尚未填写工程组成')
    policy, price = bill.get('salePolicy') or {}, total if ready else None
    percent = n(policy.get('percent', 0))
    if bill.get('priceKind') not in ('purchase_cost', 'enterprise_quote'):
        issues.append('请选择工程组成的价格口径')
    if bill.get('priceKind') == 'purchase_cost':
        if percent is None or percent > 1000 or policy.get('method') == 'margin' and percent >= 100:
            price = None
            issues.append('成本转售价比例无效')
        elif price is not None:
            price = rounded(total/(1-percent/100) if policy.get('method') == 'margin' else total*(1+percent/100))
    if price is not None and price > Decimal('1e12'):
        price = None
        issues.append('工程金额超出范围')
    return dict(basePrice=float(price) if price is not None else None, subtotal=float(total), steps=steps, issues=issues, status='missing' if price is None else 'priced', partial=bool(issues))
