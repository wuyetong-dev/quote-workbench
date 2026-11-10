"""Source reconciliation is an issuance check, never a pricing prerequisite."""
import hashlib
import json
import re
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

CENT = Decimal('.01')


def text(value):
    return unicodedata.normalize('NFKC', str(value if value is not None else '')).strip()


def number(value):
    if value is None or isinstance(value, bool):
        return None
    raw = re.sub(r'[,，\s￥¥]', '', text(value))
    raw = re.sub(r'(?:人民币|RMB|CNY|元)$', '', raw, flags=re.I)
    try:
        n = Decimal(raw)
        return n if n.is_finite() and abs(n) <= Decimal('1e15') else None
    except InvalidOperation:
        return None


def money(n):
    return n.quantize(CENT, rounding=ROUND_HALF_UP)


def header(row):
    out = {}
    for col, value in enumerate(row):
        s = re.sub(r'\s', '', text(value))
        if re.fullmatch(r'(?:设备|物料|部件|产品|项目)?名称(?:及(?:规格|配置)(?:说明)?)?', s):
            out['name'] = col
        elif re.fullmatch(r'(?:设备|供货)?数量(?:[（(].*?[)）])?', s):
            out['quantity'] = col
        elif re.search(r'^(?:规格|型号|配置|技术参数)', s):
            out.setdefault('spec', col)
        elif re.search(r'^(?:单价|报价单价|销售价|售价)', s) and not re.search(r'成本|采购|USD|美元|欧元|EUR', s, re.I):
            out['price'] = col
        elif re.search(r'^(?:金额|总价|合价|合计金额)', s):
            out['amount'] = col
        elif s in ('单位', '计量单位'):
            out['unit'] = col
    return out if 'name' in out and ('quantity' in out or 'price' in out or 'amount' in out) else None


def colname(c):
    out = ''
    while c >= 0:
        out = chr(65 + c % 26) + out
        c = c // 26 - 1
    return out


def audit(quote):
    rows = quote.get('rows') or []
    reviews = {r.get('key'): r for r in quote.get('sourceAuditReviews') or []
               if r.get('at') and str(r.get('reason') or '').strip()}
    issues, resolved, checks = [], [], []
    coverage = dict(sourceRows=0, representedRows=0, unrepresentedRows=0)

    def add(code, message, evidence, **fields):
        key = hashlib.sha256(json.dumps([code, evidence], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        item = dict(code=code, type=code, key=key, message=message, evidence=evidence, **fields)
        if key in reviews:
            resolved.append(dict(item, review=reviews[key]))
        else:
            issues.append(item)

    for si, source in enumerate(quote.get('sources') or []):
        if source.get('type') != 'quotation':
            continue
        raw = source.get('rows') or []
        filename, sheet = source.get('filename') or '', source.get('sheet') or ''
        prefix = filename + ' / ' + sheet + ' / '
        represented = set()
        source_rows = {}
        for row in rows:
            if str(row.get('source') or '').startswith(prefix):
                if row.get('sourceRow'):
                    represented.add(int(row['sourceRow']))
                    source_rows.setdefault(int(row['sourceRow']), []).append(row)
                ranges = [f.get('range', '') for f in row.get('fields') or []] + (row.get('bom') or {}).get('sourceRanges', [])
                for location in ranges:
                    m = re.search(r'![A-Z]+(\d+)', location)
                    if m:
                        represented.add(int(m[1]))
        mapping, labels, total, section_total, last_total, tax, notes = None, [], Decimal(0), Decimal(0), None, Decimal(0), False
        for index, values in enumerate(raw):
            if not isinstance(values, list):
                continue
            h = header(values)
            if h:
                mapping, labels = h, values
                continue
            if mapping is None or notes:
                continue
            get = lambda key: values[mapping[key]] if key in mapping and mapping[key] < len(values) else None
            name = text(get('name'))
            if re.match(r'^(?:备注[:：]|商务条款|付款方式|交货)', ' '.join(text(v) for v in values if text(v))):
                notes = True
                continue
            original_qty, original_price, original_amount = number(get('quantity')), number(get('price')), number(get('amount'))
            pscale = Decimal(10000) if 'price' in mapping and '万元' in text(labels[mapping['price']]) else Decimal(1)
            ascale = Decimal(10000) if 'amount' in mapping and '万元' in text(labels[mapping['amount']]) else Decimal(1)
            if original_price is not None:
                original_price *= pscale
            if original_amount is not None:
                original_amount *= ascale
            rownum = index + 1
            origin = prefix + '第' + str(rownum) + '行'
            evidence = dict(filename=filename, sheet=sheet, row=rownum, name=name,
                            quantity=str(original_qty), price=str(original_price), amount=str(original_amount))
            anchor = source_rows.get(rownum, [{}])[0].get('id', '')
            total_name = re.sub(r'\s', '', name)
            if not total_name:
                total_name = ' '.join(text(v) for c, v in enumerate(values) if c not in (mapping.get('quantity'), mapping.get('price'), mapping.get('amount')))
            is_tax = bool(re.match(r'^(?:增值税|税额|税金|税费|VAT|TAX)', total_name, re.I))
            is_total = bool(re.search(r'合计|小计|总计|总金额|最终报价', total_name))
            if is_tax:
                actual = original_amount if original_amount is not None else original_price
                match = re.search(r'(\d+(?:\.\d+)?)\s*%', ' '.join(text(v) for v in values))
                if actual is not None and match and last_total is not None:
                    expected = money(last_total * Decimal(match[1]) / 100)
                    if abs(expected - actual) > CENT:
                        add('source_tax', f'原表税额{actual}与基数×税率{expected}不一致', evidence, source=origin, sourceIndex=si, rowId=anchor, expected=float(expected), original=float(actual))
                if actual is not None:
                    tax = actual
                continue
            if is_total:
                actual = original_amount if original_amount is not None else original_price
                if actual is None:
                    continue
                expected = total + tax if re.search(r'含税|价税|最终', total_name) else section_total if re.search(r'小计|部分合计', total_name) else total
                # A named chapter total closes the current section. A plain
                # final/untaxed total closes the whole sheet.
                if re.search(r'.+(?:部分|系统|机架|槽体|行车|配置).*合计', total_name):
                    expected = section_total
                checks.append(dict(source=origin, kind='summary', expected=float(expected), original=float(actual)))
                if expected and abs(money(expected) - actual) > CENT:
                    add('source_summary', f'{total_name}：原表{actual}，明细复核{money(expected)}，相差{money(actual-expected)}', evidence, source=origin, sourceIndex=si, rowId=anchor, expected=float(money(expected)), original=float(actual))
                last_total = actual
                section_total = Decimal(0)
                continue
            if not name or re.match(r'^[一二三四五六七八九十百]+[、.．]', name) and original_qty is None:
                continue
            address = colname(mapping['price']) + str(rownum) if 'price' in mapping else ''
            formula = (source.get('formulas') or {}).get(address, '').replace('$', '').lstrip('=')
            direct = re.fullmatch(r'([A-Z]+)(\d+)', formula, re.I)
            if direct and int(direct[2]) < rownum and re.search(r'合计|小计|总计', ' '.join(text(v) for v in raw[int(direct[2])-1])):
                continue
            # A row is data-bearing only if a quantity or monetary field exists;
            # captions and descriptive continuations do not become false omissions.
            if original_qty is None and original_price is None and original_amount is None:
                continue
            coverage['sourceRows'] += 1
            if rownum in represented:
                coverage['representedRows'] += 1
            else:
                coverage['unrepresentedRows'] += 1
                add('source_omission', '原表有明细尚未进入报价：' + name, evidence, source=origin, sourceIndex=si, rowId='', item=dict(name=name, spec=text(get('spec')), quantity=float(original_qty) if original_qty is not None else None, unit=text(get('unit')), basePrice=float(original_price) if original_price is not None else None, source=origin, sourceRow=rownum))
            expected = money(original_qty * original_price) if original_qty is not None and original_price is not None else None
            if expected is not None and original_amount is not None and abs(expected-original_amount) > CENT:
                add('source_line', f'{name}：原金额{original_amount}，原数量×原单价{expected}，相差{money(original_amount-expected)}', evidence, source=origin, sourceIndex=si, rowId=anchor, expected=float(expected), original=float(original_amount), originalPrice=float(original_price))
            for field in ('price', 'amount'):
                if field not in mapping:
                    continue
                addr = colname(mapping[field]) + str(rownum)
                if (source.get('formulas') or {}).get(addr) and number(get(field)) is None:
                    add('source_formula', f'{name}的原表公式没有可计算结果：{sheet}!{addr}', dict(evidence, formula=source['formulas'][addr]), source=origin, sourceIndex=si, rowId=anchor)
            value = original_amount if original_amount is not None else expected
            if value is not None:
                total += value
                section_total += value

    duplicates = {}
    for row in rows:
        if row.get('selected') is False or row.get('kind') in ('requirement', 'process') or (row.get('bom') or {}).get('role') == 'requirement':
            continue
        bom = row.get('bom') or {}
        station = [m.get('stationNumber') for m in bom.get('stationMembers') or []]
        signature = [row.get(k) or '' for k in ('name', 'spec', 'brand', 'unit', 'group', 'subgroup')]
        # Identical accessories under different explicitly named source devices
        # are separate supplies, not duplicate charges in one device.
        signature.extend([row.get('rawGroup') or '',row.get('rawSubgroup') or '',row.get('parentId') or bom.get('parentId') or ''])
        signature.append(station or bom.get('stationNumber') or row.get('stationNumber') or '')
        signature.append(re.sub(r'/\s*第\d+行.*$', '', str(row.get('source') or '')))
        key = json.dumps(signature, ensure_ascii=False, sort_keys=True)
        duplicates.setdefault(key, []).append(row)
    for group in duplicates.values():
        if len(group) < 2:
            continue
        evidence = [dict(id=r.get('id'), source=r.get('source'), quantity=r.get('quantity'), spec=r.get('spec')) for r in group]
        add('duplicate_quote', group[0]['name'] + f'有{len(group)}条同范围同规格明细，请确认分别供货还是重复', evidence, rowId=group[0].get('id', ''), rowIds=[r.get('id') for r in group], source=group[0].get('source', ''))
    for row in rows:
        for kind, suggestion in (row.get('automaticSuggestions') or {}).items():
            if suggestion.get('status') != 'pending':
                continue
            if kind == 'quantity':
                value = [row.get('quantity'), [[m.get('stationNumber'), m.get('sourceRow')] for m in (row.get('bom') or {}).get('stationMembers') or []]]
            else:
                value = [row.get('name'), row.get('spec'), row.get('unit'), row.get('brand') or '', row.get('basePrice')]
            try:
                matches = json.loads(suggestion.get('basis', '')) == value
            except (ValueError, TypeError):
                matches = False
            if matches:
                issues.append(dict(code='automatic_'+kind, type='automatic_'+kind, rowId=row.get('id'), group=suggestion.get('group'), message=suggestion.get('message'), key='automatic:'+str(row.get('id'))+':'+kind))
    return dict(issues=issues, resolved=resolved, checks=checks, coverage=coverage)
