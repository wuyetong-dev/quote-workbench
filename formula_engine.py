"""Independent export-time recalculation of versioned formula input snapshots."""
import json
import math
import re
import unicodedata
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP

VERSION = '2026-10-08.v1'
KEYS = {'tank': ['length', 'width', 'height', 'thickness', 'material'],
        'plate': ['length', 'width', 'thickness', 'density', 'rate'],
        'bar': ['length', 'width', 'thickness', 'density', 'rate'],
        'shaft': ['length', 'diameter', 'density', 'rate'],
        'tube': ['length', 'diameter', 'thickness', 'density', 'rate'],
        'hollow': ['length', 'width', 'height', 'thickness', 'density', 'rate'],
        'section': ['length', 'kgPerM', 'rate']}
MATERIALS = {'PP': ('.92', '13.5'), 'IMPORT_PP': ('.92', '25'),
             'SUS304': ('7.96', '20'), 'SUS316': ('7.96', '20')}
SPECIAL_TANK = re.compile(r'油水分离|水浴.*(?:内槽|内胆)|加热内槽|保温|岩棉|外封|外覆|外包|涂层|喷涂|喷塑|涂覆|上涂|夹套|内衬|钢衬|SS41|Q235|双层|内外槽|外槽|连槽|联槽|(?:一|二|两|三|四|五|六|七|八|九|十|百|\d)+[联连]|隔板|圆形|圆筒|槽盖|封闭结构|异形', re.I)
PIECE_UNITS = re.compile(r'^(?:kg|公斤|千克|吨|t|m|米|m2|m²|平方米|组|批|项)$', re.I)


def is_requirement(row):
    return row.get('kind') == 'requirement' or (row.get('bom') or {}).get('role') == 'requirement'


def is_included(row):
    return (row.get('bom') or {}).get('supplyStatus') == 'included' or (row.get('decomposition') or {}).get('relationship') == 'included'


def formula_applicable(row, rule):
    """Apply the same scope guards as the browser before trusting a snapshot."""
    if row.get('kind') == 'process' or is_requirement(row) or row.get('formulaBlocked'):
        return False
    if PIECE_UNITS.fullmatch(str(row.get('unit') or '').strip()):
        return False
    bom = row.get('bom') or {}
    if rule == 'tank' and isinstance(row.get('bom'), dict) and bom.get('role') not in ('tank', 'component'):
        return False
    if rule == 'tank':
        try:
            linked = (float(bom.get('chamberCount') or 1) > 1 or
                      float((row.get('geometry') or {}).get('chambers') or 1) > 1)
        except (TypeError, ValueError):
            return False
        if linked:
            return False
        if SPECIAL_TANK.search(str(row.get('name') or '') + ' ' + str(row.get('spec') or '')):
            return False
        if re.search(r'泵|风机|滚筒|配件|排水管|洗涤塔', str(row.get('name') or '')):
            return False
    return True


def money(n):
    return n.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)


def evaluate(rule, values, version=VERSION):
    if rule not in KEYS or version != VERSION:
        return None
    p = {}
    for k in KEYS[rule]:
        v = values.get(k)
        if k == 'material':
            if v not in MATERIALS:
                return None
            p[k] = v
        else:
            try:
                n = Decimal(str(v))
                if not n.is_finite() or (n < 0 if k == 'rate' else n <= 0) or n > Decimal('1e8'):
                    return None
                p[k] = n
            except Exception:
                return None
    L, W, H, T, D = (p.get(k) for k in ['length', 'width', 'height', 'thickness', 'diameter'])
    if rule == 'tank':
        if T >= min(L, W, H) / 2:
            return None
        density, rate = map(Decimal, MATERIALS[p['material']])
        def plate(area):
            return (area * density * T / 1000000 * rate / 100).to_integral_value(rounding=ROUND_CEILING) * 100
        s = (H + W + H) / 100 + (L + H + H) / 100 * (2 if L + H + H > 500 else 1)
        value = sum(plate(area) for area in [L * W, 2 * L * H, 2 * W * H]) + s * 100 / 6 + s * 15 * 2 * Decimal('1.3') + 500
    else:
        rho = p.get('density')
        if rule in ('tube', 'hollow') and 2 * T >= min([D] if rule == 'tube' else [W, H]):
            return None
        if rule in ('plate', 'bar'):
            mass = L * W * T * rho / Decimal('1e9')
        elif rule == 'shaft':
            mass = Decimal(str(math.pi)) / 4 * D * D * L * rho / Decimal('1e9')
        elif rule == 'tube':
            mass = Decimal(str(math.pi)) / 4 * (D * D - (D - 2 * T)**2) * L * rho / Decimal('1e9')
        elif rule == 'hollow':
            mass = (W * H - (W - 2 * T) * (H - 2 * T)) * L * rho / Decimal('1e9')
        else:
            mass = L / 1000 * p['kgPerM']
        value = mass * p['rate']
    return money(value) if value.is_finite() and value <= Decimal('1e12') else None


def basis(row):
    return [unicodedata.normalize('NFKC', str(row.get(k) or '')).strip() for k in ['name', 'spec', 'unit', 'brand']]


def base_price(row, quote=None):
    if row.get('engineeringBill'):
        from engineering_calculation import evaluate as engineering_evaluate
        return engineering_evaluate(row)['basePrice']
    if is_requirement(row):
        return None
    if row.get('calculation'):
        from calculation_engine import evaluate as evaluate_contract
        return evaluate_contract(row, quote).get('basePrice')
    if row.get('priceKind') in ('purchase_cost', 'estimate'):
        return None
    pricing = row.get('pricing') or {}
    if pricing.get('mode') == 'assembly':
        return assembly_price(row)
    if pricing.get('mode') == 'linked_reference':
        return linked_reference_price(row, quote)
    if pricing.get('mode') != 'formula':
        return row.get('basePrice')
    # Never export a stale or incomplete client-side cached price.
    try:
        matches = json.loads(pricing.get('basis', '')) == basis(row)
    except (TypeError, ValueError):
        matches = False
    if not matches or pricing.get('issues') or not formula_applicable(row, pricing.get('rule')):
        return None
    return evaluate(pricing.get('rule'), pricing.get('params') or {}, pricing.get('version'))


def linked_reference_price(row, quote=None):
    pricing, evidence = row.get('pricing') or {}, row.get('priceEvidence') or {}
    if pricing.get('version') != '2026-11-06.linked-reference.2' or pricing.get('status') != 'matched' or pricing.get('confirmed') is not True or evidence.get('confirmed') is not True:
        return None
    try:
        matched_basis = json.loads(pricing.get('basis', ''))
        entry = evidence.get('entry') or {}
        if quote is not None:
            table = quote.get('linkedPriceTable') or {}
            signature = [table.get('source'), [[e.get(k) for k in ('id', 'key', 'price', 'spec', 'usable')] for e in table.get('entries') or []]]
            if table.get('confirmed') is not True or json.loads(table.get('confirmedBasis', '')) != signature or json.loads(pricing.get('tableBasis', '')) != signature:
                return None
            selection = (quote.get('linkedReferenceSelections') or {}).get(row.get('id')) or {}
            if json.loads(selection.get('basis', '')) != matched_basis or selection.get('entryId') != entry.get('id') or json.loads(selection.get('tableBasis', '')) != signature:
                return None
            original = next((e for e in table.get('entries') or [] if e.get('id') == entry.get('id')), None)
            if original is None or any(original.get(k) != entry.get(k) for k in ('key', 'price', 'spec', 'usable', 'dimensions', 'material', 'thickness', 'chambers', 'type')):
                return None
        if any(matched_basis.get(k) != row.get(k) for k in ('name', 'spec', 'unit', 'quantity')):
            return None
        if matched_basis.get('stationMembers') != ((row.get('bom') or {}).get('stationMembers') or []):
            return None
        if row.get('parameterConflicts') or (row.get('geometry') or {}).get('dimensionIssue'):
            return None
        geometry = row.get('geometry') or {}
        if matched_basis.get('geometry') != geometry:
            return None
        if any(Decimal(str(geometry.get(k))) != Decimal(str(v)) for k, v in (matched_basis.get('dimensions') or {}).items()):
            return None
        count = max(int((row.get('bom') or {}).get('chamberCount') or 1), int(geometry.get('chambers') or 1))
        if count < 2 or matched_basis.get('chambers') != count or entry.get('chambers') != count:
            return None
        source_dimensions, target_dimensions = matched_basis.get('dimensions') or {}, entry.get('dimensions') or {}
        same_dimensions = all(source_dimensions.get(k) == target_dimensions.get(k) for k in ('length', 'width', 'height'))
        rotated_dimensions = source_dimensions.get('length') == target_dimensions.get('width') and source_dimensions.get('width') == target_dimensions.get('length') and source_dimensions.get('height') == target_dimensions.get('height')
        if not (same_dimensions or rotated_dimensions):
            return None
        if entry.get('thickness') is not None and geometry.get('thickness') is not None and Decimal(str(entry.get('thickness'))) != Decimal(str(geometry.get('thickness'))):
            return None
        if entry.get('key') != pricing.get('key') or entry.get('material') != matched_basis.get('material') or entry.get('type') != matched_basis.get('type') or not entry.get('usable'):
            return None
        value = Decimal(str(entry.get('price')))
        return money(value) if value.is_finite() and 0 <= value <= Decimal('1e12') else None
    except (ValueError, TypeError, ArithmeticError):
        return None


def assembly_price(row):
    pricing = row.get('pricing') or {}
    if pricing.get('version') != '2026-11-05.assembly.1' or (row.get('bom') or {}).get('role') != 'tank':
        return None
    try:
        if json.loads(pricing.get('basis', '')) != basis(row):
            return None
        if pricing.get('dependencyBasis'):
            expected = [row.get('geometry'), (row.get('bom') or {}).get('memberGeometry'), row.get('extraPricing')]
            if row.get('assemblyResolution'):
                expected.insert(2, row['assemblyResolution'])
            if row.get('linkedPricingPolicy'):
                expected.append(row['linkedPricingPolicy'])
            if json.loads(pricing['dependencyBasis']) != expected:
                return None
        if row.get('parameterConflicts') or (row.get('geometry') or {}).get('dimensionIssue'):
            return None
        count = max(int((row.get('bom') or {}).get('chamberCount') or 1), int((row.get('geometry') or {}).get('chambers') or 1))
        if pricing.get('chambers') != count:
            return None
        policy = pricing.get('policy') or {}
        method = policy.get('method')
        if count > 1 and (not policy.get('confirmed') or policy.get('version') != '2026-11-05.assembly.1'):
            return None
        if count > 1 and method == 'fixed':
            raw = (policy.get('prices') or {}).get(pricing.get('policyKey'), policy.get('fixedPrice'))
            value = Decimal(str(raw))
        else:
            stations = pricing.get('stations') or []
            if len(stations) != count:
                return None
            prices = [evaluate('tank', s.get('params') or {}) for s in stations]
            if any(p is None for p in prices):
                return None
            if policy.get('material') and any(s.get('params', {}).get('material') != policy['material'] for s in stations):
                return None
            if count == 1 and pricing.get('scope') == 'tank_body':
                value = prices[0]
            elif count > 1 and method == 'stations':
                value = sum(prices)
            elif count > 1 and method == 'extra':
                increment = Decimal(str(policy.get('extraPrice')))
                if not increment.is_finite() or increment < 0:
                    return None
                value = prices[0] + (count - 1) * increment
            elif count > 1 and method == 'factor':
                factor = Decimal(str(policy.get('extraFactor')))
                if not factor.is_finite() or not 0 <= factor <= 10 or any(s.get('params') != stations[0].get('params') for s in stations):
                    return None
                value = prices[0] * (1 + (count - 1) * factor)
            else:
                return None
        for extra in pricing.get('adjustments') or []:
            if extra.get('choice') != 'separate':
                continue
            fixed = extra.get('fixedPrice')
            rate, area = extra.get('rate'), extra.get('area')
            if fixed is not None:
                value += Decimal(str(fixed))
            elif rate is not None and area is not None:
                value += money(Decimal(str(rate)) * Decimal(str(area)))
        return money(value) if value.is_finite() and 0 <= value <= Decimal('1e12') else None
    except (ValueError, TypeError, ArithmeticError):
        return None


def quoted_spec(row):
    """Export the explicitly confirmed geometry alongside preserved source text."""
    pricing = row.get('pricing') or {}
    resolution = row.get('assemblyResolution') or {}
    if resolution and pricing.get('mode') == 'assembly' and assembly_price(row) is not None:
        members = (row.get('bom') or {}).get('memberGeometry') or []
        if members:
            g = members[0]
            dimensions = '×'.join(str(g.get(k, '')) for k in ('length', 'width', 'height'))
            method = '按各节槽体主体价相加' if pricing.get('method') == 'stations' else '采用已确认联槽计价口径'
            spec = '\n'.join(line for line in row.get('spec', '').splitlines() if not (line.startswith('本次确认：') and '采购数量按组；' in line))
            return spec + '\n本次确认：' + str(resolution.get('chambers')) + '节；单节 ' + dimensions + 'mm；采购数量按组；' + method
    if pricing.get('mode') != 'formula' or not pricing.get('supplied'):
        return row.get('spec', '')
    labels = {'length': '长', 'width': '宽', 'height': '高', 'thickness': '厚', 'diameter': '外径'}
    p = pricing.get('params') or {}
    geometry = [labels[k] + str(p[k]) + 'mm' for k in labels if k in p]
    if p.get('material'):
        geometry.append(p['material'].replace('IMPORT_PP', '进口PP'))
    if not geometry:
        return row.get('spec', '')
    return '本次计价规格：' + '；'.join(geometry) + '\n原始要求：' + str(row.get('spec', ''))
