"""Issued quotations are append-only snapshots, independent of live price books."""
import datetime
import hashlib
import json


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in ('knowledgeEvidence', 'linkedPriceMatch', 'engineering', 'updatedAt', 'deliveryConfirmation', 'exportMode')}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def issue(prepared, database):
    q = clean(prepared['quote'])
    signature = hashlib.sha256(json.dumps(q, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
    key = q['id'] + ':' + signature[:20]
    con = database()
    try:
        with con:
            con.execute('BEGIN IMMEDIATE')
            old = con.execute("SELECT body FROM records WHERE kind='issued' AND id=?", (key,)).fetchone()
            if old:
                return json.loads(old[0])
            existing = [json.loads(r[0]) for r in con.execute("SELECT body FROM records WHERE kind='issued'")]
            version = max([r['version'] for r in existing if r['quoteId'] == q['id']] or [0]) + 1
            record = dict(id=key, quoteId=q['id'], signature=signature, version=version,
                          issuedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), quote=q,
                          total=prepared['total'], tax=prepared['tax'], grandTotal=prepared['grandTotal'])
            con.execute('INSERT INTO records VALUES (?,?,?)', ('issued', key, json.dumps(record, ensure_ascii=False, allow_nan=False)))
            return record
    finally:
        con.close()
