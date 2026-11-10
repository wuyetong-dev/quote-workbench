"""Explicit enterprise decisions, stored separately from quote snapshots."""
import datetime
import json
import math
import sqlite3
import uuid
from pathlib import Path

VERSION = '2026-11-08.rules-memory.2'


def connect(data):
    Path(data).mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(Path(data) / 'workbench.sqlite3', timeout=15)
    con.executescript(Path(__file__).with_suffix('.sql').read_text(encoding='utf-8'))
    return con


def decode(row):
    return dict(id=row[0], kind=row[1], match=json.loads(row[2]), value=json.loads(row[3]),
                enabled=bool(row[4]), revision=row[5], createdAt=row[6], updatedAt=row[7])


def list_rules(data):
    con = connect(data)
    try:
        return [decode(row) for row in con.execute('SELECT * FROM rules_memory ORDER BY updated_at DESC,id')]
    finally:
        con.close()


def validate(rule):
    if not isinstance(rule, dict) or rule.get('kind') not in ('default', 'price'):
        raise ValueError('规则类型无效')
    match, value = rule.get('match'), rule.get('value')
    if not isinstance(match, dict) or not isinstance(value, dict) or not match or not value:
        raise ValueError('请填写规则条件和值')
    if len(json.dumps(rule, ensure_ascii=False)) > 24000:
        raise ValueError('规则过长')
    if rule['kind'] == 'default':
        if set(value) == {'thickness'}:
            v = value['thickness']
            if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not 0 < v <= 1000:
                raise ValueError('板厚需为有效正数')
            if match.get('material') not in ('PP', 'IMPORT_PP', 'SUS304', 'SUS316'):
                raise ValueError('板厚默认规则须限定明确材质')
        elif set(value) == {'material'}:
            if value['material'] not in ('PP', 'IMPORT_PP', 'SUS304', 'SUS316') or not str(match.get('name', '')).strip():
                raise ValueError('材质默认规则须限定设备名称及明确牌号')
        elif set(value) == {'linkedPolicy'}:
            policy = value['linkedPolicy']
            if match.get('material') not in ('PP', 'IMPORT_PP', 'SUS304', 'SUS316') or not isinstance(policy, dict):
                raise ValueError('联槽默认规则须限定明确主体材质')
            method = policy.get('method')
            if method not in ('stations', 'extra', 'factor'):
                raise ValueError('联槽默认计价方式无效')
            field = {'extra': 'extraPrice', 'factor': 'extraFactor'}.get(method)
            if set(policy) != ({'method', field} if field else {'method'}):
                raise ValueError('联槽默认口径字段无效')
            if field:
                v = policy[field]
                if isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not 0 <= v <= (10 if method == 'factor' else 1e12):
                    raise ValueError('联槽加价或系数无效')
        else:
            raise ValueError('仅支持缺失主体板厚或材质的默认值')
        if set(match) - {'material', 'name', 'operation'}:
            raise ValueError('默认规则条件无效')
    else:
        if set(match) != {'signature', 'features'} or not isinstance(match['signature'], str) or not match['signature']:
            raise ValueError('缺少完整设备匹配特征')
        f = match['features']
        if not isinstance(f, dict) or any(not f.get(k) for k in ('name', 'spec', 'unit', 'material')):
            raise ValueError('价格记忆须包含名称、完整规格、单位及明确材质')
        if match['signature'] != json.dumps(f, ensure_ascii=False, separators=(',', ':')):
            raise ValueError('设备特征签名不一致')
        v = value.get('unitPrice')
        if set(value) - {'unitPrice', 'priceMode', 'source', 'confirmedAt'} or 'unitPrice' not in value or isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or not 0 <= v <= 1e12:
            raise ValueError('销售单价无效')
        if value.get('priceMode', 'base') not in ('base', 'fixed_sale'):
            raise ValueError('价格口径无效')
        if any(not isinstance(value.get(k, ''), str) or len(value.get(k, '')) > 500 for k in ('source', 'confirmedAt')):
            raise ValueError('价格来源或确认时间无效')
    if not isinstance(rule.get('enabled', True), bool):
        raise ValueError('规则启用状态无效')


def save_rules(data, body):
    batch = body.get('rules') if isinstance(body, dict) else None
    if not isinstance(batch, list) or not 1 <= len(batch) <= 200:
        raise ValueError('请提交1至200条规则')
    for rule in batch:
        validate(rule)
    con = connect(data)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with con:
            con.execute('BEGIN IMMEDIATE')
            for rule in batch:
                rid = rule.get('id') or str(uuid.uuid4())
                if not isinstance(rid, str) or len(rid) > 100:
                    raise ValueError('规则编号无效')
                old = con.execute('SELECT revision,created_at FROM rules_memory WHERE id=?', (rid,)).fetchone()
                if old and rule.get('revision') != old[0]:
                    raise ValueError('规则已被其他窗口修改，请刷新字典')
                if not old and rule.get('revision'):
                    raise ValueError('原规则不存在，请刷新字典')
                revision = old[0] + 1 if old else 1
                stored = {**rule, 'id': rid, 'revision': revision, 'updatedAt': now}
                con.execute('INSERT INTO rules_memory VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,match_json=excluded.match_json,value_json=excluded.value_json,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at',
                            (rid, rule['kind'], json.dumps(rule['match'], ensure_ascii=False), json.dumps(rule['value']), int(rule.get('enabled', True)), revision, old[1] if old else now, now))
                con.execute('INSERT INTO rules_memory_audit(rule_id,revision,body_json,changed_at) VALUES (?,?,?,?)', (rid, revision, json.dumps(stored, ensure_ascii=False), now))
        return list_rules(data)
    finally:
        con.close()
