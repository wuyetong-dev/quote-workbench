"""Local quote service; explicit AI review sends selected rows and retrieved evidence."""
import argparse
import ctypes
from contextlib import closing
import io
import json
import mimetypes
import os
import datetime
import threading
import zlib
from pathlib import Path
import sqlite3
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote, parse_qs
from xml.sax.saxutils import escape
from formula_engine import base_price, quoted_spec, is_requirement, is_included, VERSION as FORMULA_VERSION
from ai_assist import MODEL as AI_MODEL, review as ai_review, account_balance as ai_account_balance, AssistError
from decomposition import extract as extract_process, read_images, decompose, VERSION as DECOMPOSITION_VERSION

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('QUOTE_WORKBENCH_DATA', ROOT / 'data'))
CENT = Decimal('0.01')
_JOB_STORE = None


def job_store():
    global _JOB_STORE
    if _JOB_STORE is None:
        from decomposition_jobs import JobStore
        _JOB_STORE = JobStore(DATA / 'decomposition-jobs', credential_path)
    return _JOB_STORE


def credential_path():
    """Allow isolated acceptance to use an existing vault without copying it."""
    return Path(os.environ.get('QUOTE_WORKBENCH_CREDENTIAL_FILE', DATA / 'deepseek.dpapi'))

def db():
    DATA.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DATA / 'workbench.sqlite3', timeout=15)
    con.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT, PRIMARY KEY(kind,id))')
    con.execute('CREATE TABLE IF NOT EXISTS record_revisions (kind TEXT, id TEXT, revision INTEGER, created_at TEXT, body TEXT, PRIMARY KEY(kind,id,revision))')
    return con

def records(kind):
    with closing(db()) as con:
        return [json.loads(r[0]) for r in con.execute('SELECT body FROM records WHERE kind=? ORDER BY rowid DESC', (kind,))]


def quote_record(record_id):
    with closing(db()) as con:
        row=con.execute("SELECT body FROM records WHERE kind='quotes' AND id=?",(record_id,)).fetchone()
        return json.loads(row[0]) if row else None


def startup(record_id=None):
    # Only the active quote needs its original documents and full row data.
    # Other drafts remain directory entries until explicitly opened.
    with closing(db()) as con:
        summaries=[{'id':i,'title':title or '未命名报价','updatedAt':updated,'_summary':True}
                   for i,title,updated in con.execute("SELECT id,json_extract(body,'$.title'),json_extract(body,'$.updatedAt') FROM records WHERE kind='quotes' ORDER BY rowid DESC")]
        selected=record_id if any(q['id']==record_id for q in summaries) else summaries[0]['id'] if summaries else None
        row=con.execute("SELECT body FROM records WHERE kind='quotes' AND id=?",(selected,)).fetchone() if selected else None
        current=json.loads(row[0]) if row else None
    return {'quote':current,'quotes':summaries,'parts':records('parts'),'templates':records('templates')}

def save(kind, body):
    if not isinstance(body, dict) or not isinstance(body.get('id'), str) or len(body['id']) > 100:
        raise ValueError('记录缺少有效编号')
    if kind in ('quotes','templates') and body.get('_summary'):
        raise ValueError('请先打开完整报价后再保存')
    with closing(db()) as con, con:
        if kind in ('quotes', 'templates'):
            old = con.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind, body['id'])).fetchone()
            revision = con.execute('SELECT COALESCE(MAX(revision), 0) FROM record_revisions WHERE kind=? AND id=?', (kind, body['id'])).fetchone()[0]
            if old and old[0] != json.dumps(body, ensure_ascii=False, allow_nan=False):
                con.execute('INSERT INTO record_revisions VALUES (?,?,?,?,?)', (kind, body['id'], revision + 1, datetime.datetime.now(datetime.timezone.utc).isoformat(), revision_body(old[0])))
                # Revisions are a bounded undo trail, not another full backup.
                con.execute('DELETE FROM record_revisions WHERE kind=? AND id=? AND revision <= ?', (kind, body['id'], max(0, revision - 19)))
        con.execute('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body', (kind, body['id'], json.dumps(body, ensure_ascii=False, allow_nan=False)))
    return body


def revision_body(text):
    raw=text.encode('utf-8')
    packed=b'HJZ1'+zlib.compress(raw)
    return packed if len(raw)>=65536 and len(packed)<len(raw) else text


def revision_quote(value):
    if isinstance(value,bytes) and value.startswith(b'HJZ1'):
        value=zlib.decompress(value[4:]).decode('utf-8')
    return json.loads(value)


def entry_catalog():
    from quote_entry import catalog, bundled_library
    from history_learning import library
    return catalog(records('templates'),records('parts'),[*library(records('pricebooks')),*bundled_library()])

def dec(value, label, optional=False):
    if value is None or value == '':
        if optional:
            return None
        raise ValueError(label + '尚未填写')
    try:
        n = Decimal(str(value))
        if not n.is_finite() or n < 0 or n > Decimal('1000000000000'):
            raise ValueError(label + '超出有效范围')
        return n
    except (InvalidOperation, TypeError):
        raise ValueError(label + '不是有效数字')

def rounded(n):
    return n.quantize(CENT, rounding=ROUND_HALF_UP)

def prepare(q, final=False):
    from quotation_validation import delivery_status, require_final, stale_price
    if not isinstance(q.get('rows'), list) or len(q['rows']) > 15000:
        raise ValueError('报价明细过多或无效')
    markup = dec(q.get('markup', 0), '上浮比例')
    if markup > 1000:
        raise ValueError('上浮比例应在0–1000%之间')
    rate = dec(q.get('taxRate', 0), '税率')
    if rate > 100:
        raise ValueError('税率应在0–100%之间')
    if q.get('taxMode') not in ('included', 'excluded', 'none'):
        raise ValueError('请选择税价口径')
    ready, omitted, subtotal = [], [], Decimal(0)
    for source in q['rows']:
        row = dict(source)
        if not str(row.get('name', '')).strip():
            raise ValueError('明细名称不能为空')
        # Requirements preserve unresolved source scope. They cannot become a
        # second charge merely because a stale client selected or priced them.
        if is_requirement(row) or is_included(row):
            reviewed = (row.get('scopeReview') or {}).get('status') == 'requirement_only' and (row.get('scopeReview') or {}).get('confirmedAt')
            row.update(selected=False, basePrice=None, unitPrice=None, amount=None,
                       reason='已含在主项' if is_included(row) else '工艺要求，本次不独立供货' if reviewed or (row.get('bom') or {}).get('resolved') else '待确认供货范围')
            omitted.append(row)
            continue
        qty = dec(row.get('quantity'), '数量', True)
        base = dec(base_price(row, q), '基础单价', True)
        row['basePrice'] = float(base) if base is not None else None
        row['spec'] = quoted_spec(source)
        stale = stale_price(source, q)
        checked = None
        if stale and source.get('calculation'):
            from calculation_engine import evaluate as evaluate_contract
            checked = evaluate_contract(source, q)
        override = None if stale else dec(row.get('override'), '本次单价', True)
        if stale:
            base = None
            row['basePrice'] = None
            row['priceStatus'] = checked['status'] if checked else 'stale'
        unit = rounded(override) if override is not None else rounded(base * (1 + markup / 100)) if base is not None else None
        row['unitPrice'] = float(unit) if unit is not None else None
        row['amount'] = float(rounded(qty * unit)) if qty is not None and unit is not None else None
        if row.get('selected') is False or row['amount'] is None:
            row['reason'] = '本次不含' if row.get('selected') is False else '计价依据已改变，原价待重新确认' if stale else '待填数量' if qty is None else '待补计算条件' if (row.get('pricing') or {}).get('mode') == 'formula' else '待补单价'
            if checked and row.get('selected') is not False:
                row['reason'] = '；'.join(checked['issues']) or '待补计价条件：' + '、'.join(checked['missing'])
            omitted.append(row)
        else:
            ready.append(row)
            subtotal += Decimal(str(row['amount']))
    gross = subtotal
    commercial = q.get('commercial') or {}
    value = dec(commercial.get('discountValue', 0), '整单优惠')
    if commercial.get('discountType') == 'percent' and value > 100:
        raise ValueError('优惠比例应在0至100%')
    discount = rounded(gross * value / 100) if commercial.get('discountType') == 'percent' else rounded(value)
    if discount > gross:
        raise ValueError('整单优惠不能超过已计价金额')
    subtotal -= discount
    tax = rounded(subtotal * rate / 100) if q['taxMode'] == 'excluded' else Decimal(0)
    result = dict(quote=q, rows=ready, omitted=omitted, total=float(subtotal), tax=float(tax), grandTotal=float(subtotal + tax))
    result.update(grossTotal=float(gross), discount=float(discount))
    result['completeness'] = delivery_status(q, result)
    result['quoteStatus'] = result['completeness']['status']
    result['documentStatus'] = 'formal' if final else 'draft'
    if final:
        require_final(result['completeness'])
    return result

def protect(value):
    class Blob(ctypes.Structure):
        _fields_ = [('size', ctypes.c_ulong), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    content = value.encode('utf-8')
    buf = ctypes.create_string_buffer(content)
    src = Blob(len(content), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    dst = Blob()
    if os.name != 'nt' or not ctypes.windll.crypt32.CryptProtectData(ctypes.byref(src), None, None, None, None, 1, ctypes.byref(dst)):
        raise ValueError('API Key 加密保存失败')
    try:
        return ctypes.string_at(dst.data, dst.size)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.data)

def settings():
    return {'keySaved': credential_path().is_file(), 'provider': 'DeepSeek', 'model': AI_MODEL, 'reviewAvailable': True}

def knowledge_catalog():
    path = ROOT / 'knowledge/catalog.json'
    bundle=json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {'version': 'empty', 'sources': [], 'terms':[], 'entries': []}
    from history_learning import case_knowledge
    return case_knowledge(bundle,records('pricebooks'))

def validate_pricebook(body):
    if not isinstance(body, dict) or not isinstance(body.get('name'), str) or not body['name'].strip():
        raise ValueError('请填写历史报价资料名称')
    index = body.get('index', {})
    if not isinstance(index, dict) or not isinstance(index.get('records'), list) or len(index['records']) > 15000:
        raise ValueError('历史价格明细无效或过多')
    for record in index['records']:
        if not isinstance(record, dict):
            raise ValueError('历史价格记录格式无效')
        value = record.get('price', record.get('unitPrice', record.get('basePrice')))
        dec(value, '历史单价')
    return body

def pdf_bytes(result):
    from pdf_export import pdf_bytes as render
    return render(result)


def export_response(value):
    """Keep export data and pricing evidence; omit repeated derived candidates.

    The quote, detail rows and page layout can refer to the same row. Returning
    their candidate caches repeatedly made a small workbook require a 94MB JSON
    response. The exporters use the business model, never these two caches.
    """
    if isinstance(value, dict):
        return {key: export_response(item) for key, item in value.items()
                if key not in ('knowledgeEvidence', 'linkedPriceMatch')}
    if isinstance(value, list):
        return [export_response(item) for item in value]
    return value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # No request bodies, keys, or business contents in logs.

    def send(self, status, content, mime='application/json; charset=utf-8', cache_control='no-store', etag=None):
        if not isinstance(content, bytes):
            # Long process workbooks retain source snapshots. Do not build a
            # second full unicode response plus a full UTF-8 copy in memory.
            import tempfile
            import shutil
            with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as encoded:
                for chunk in json.JSONEncoder(ensure_ascii=False, allow_nan=False).iterencode(content):
                    encoded.write(chunk.encode('utf-8'))
                size = encoded.tell()
                encoded.seek(0)
                self.response_headers(status, mime, size, cache_control, etag)
                shutil.copyfileobj(encoded, self.wfile, 64 * 1024)
            return
        self.response_headers(status, mime, len(content), cache_control, etag)
        self.wfile.write(content)

    def response_headers(self, status, mime, length, cache_control='no-store', etag=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        if status!=304:self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', cache_control)
        if etag:self.send_header('ETag',etag)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/startup':
            return self.send(200,startup(parse_qs(urlparse(self.path).query).get('quoteId',[None])[0]))
        if path.startswith('/api/quotes/'):
            quote=quote_record(unquote(path.removeprefix('/api/quotes/')))
            return self.send(200,quote) if quote is not None else self.send(404,{'error':'未找到该报价草稿'})
        if path == '/api/quote-entry/catalog':
            return self.send(200, entry_catalog())
        if path == '/api/history-prices':
            from history_learning import pricebooks
            bundled=ROOT/'knowledge/enterprise-pricebook.json'
            books=records('pricebooks')
            if bundled.is_file():books.append(json.loads(bundled.read_text(encoding='utf-8')))
            return self.send(200,pricebooks(books))
        if path == '/api/history-cases':
            from history_learning import summary
            return self.send(200,[{**summary(b),'reference':{'_historyId':b['id']}} for b in records('pricebooks')])
        if path.startswith('/api/history-case/'):
            book=next((b for b in records('pricebooks') if b['id']==unquote(path.rsplit('/',1)[1])),None)
            return self.send(200,book['reference']) if book and book.get('reference') else self.send(404,{'error':'历史资料不存在'})
        if path == '/api/export-config':
            from export_templates import load
            try:
                return self.send(200, load(DATA))
            except ValueError as error:
                return self.send(400, {'error': str(error)})
        if path == '/api/health':
            from parameter_parser import VERSION as PARAMETER_VERSION
            from rules_memory import VERSION as RULES_VERSION
            from condition_binding import VERSION as CONDITION_VERSION
            from quote_entry import VERSION as QUOTE_ENTRY_VERSION
            from reference_excel import VERSION as EXCEL_VERSION
            return self.send(200, {'app': 'quote-workbench', 'version': '2026-11-08.hybrid-parser.1', 'rulesMemoryVersion': RULES_VERSION, 'conditionBindingVersion': CONDITION_VERSION, 'parameterParserVersion': PARAMETER_VERSION, 'formulaVersion': FORMULA_VERSION, 'exportVersion':EXCEL_VERSION, 'startupVersion':'2026-11-10.startup.1', 'decompositionVersion': DECOMPOSITION_VERSION, 'quoteEntryVersion': QUOTE_ENTRY_VERSION, 'processImportVersion': 2, 'instance': os.environ.get('QUOTE_WORKBENCH_INSTANCE', '')})
        if path == '/api/excel-templates':
            from reference_excel import profiles
            return self.send(200,[{'id':p['id'],'name':p['name']} for p in profiles() if p['kind']=='business'])
        if path == '/api/rules-memory':
            from rules_memory import list_rules
            return self.send(200, list_rules(DATA))
        if path.startswith('/api/issued/'):
            quote_id = unquote(path.removeprefix('/api/issued/'))
            return self.send(200, sorted([r for r in records('issued') if r.get('quoteId') == quote_id], key=lambda r: r['version'], reverse=True))
        if path.startswith('/api/decomposition-jobs/'):
            try:
                return self.send(200, job_store().get(path.rsplit('/', 1)[1]))
            except (ValueError, FileNotFoundError):
                return self.send(404, {'error': '未找到资料补查任务'})
        if path.startswith('/api/revisions/'):
            record_id = path.removeprefix('/api/revisions/')
            with closing(db()) as con:
                result = [{'revision': row[0], 'at': row[1], 'quote': revision_quote(row[2])} for row in con.execute('SELECT revision, created_at, body FROM record_revisions WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 20', ('quotes', record_id))]
            return self.send(200, result)
        if path.startswith('/api/source-document/'):
            from document_import import original_document
            try:
                meta, raw = original_document(path.removeprefix('/api/source-document/'), DATA)
                return self.send(200, raw, mimetypes.guess_type(meta['filename'])[0] or 'application/octet-stream')
            except (ValueError, FileNotFoundError):
                return self.send(404, {'error': '未找到原始资料'})
        if path == '/api/knowledge':
            return self.send(200, knowledge_catalog())
        if path == '/api/knowledge-pricebook':
            seed = ROOT / 'knowledge/enterprise-pricebook.json'
            return self.send(200, json.loads(seed.read_text(encoding='utf-8')) if seed.is_file() else None)
        if path == '/api/settings':
            return self.send(200, settings())
        if path == '/api/settings/balance':
            try:
                return self.send(200, ai_account_balance(credential_path()))
            except AssistError as error:
                return self.send(200, {'status': 'error', 'message': str(error)})
        if path == '/api/decomposition-status':
            return self.send(200, {'version': DECOMPOSITION_VERSION, 'provider': 'DeepSeek' if credential_path().is_file() else '本机视觉模型'})
        if path.startswith('/api/'):
            kind = path.removeprefix('/api/')
            return self.send(200, records(kind)) if kind in ('quotes', 'templates', 'parts', 'pricebooks', 'decomposition-examples', 'process-mappings', 'process-scope-rules') else self.send(404, {'error': '接口不存在'})
        target = (ROOT / 'web' / unquote(path.lstrip('/') or 'index.html')).resolve()
        if not target.is_relative_to((ROOT / 'web').resolve()) or not target.is_file():
            return self.send(404, {'error': '文件不存在'})
        mime = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        import hashlib
        data=target.read_bytes();etag='"'+hashlib.sha256(data).hexdigest()+'"'
        mime += '; charset=utf-8' if target.suffix in ('.html', '.js', '.css') else ''
        if self.headers.get('If-None-Match')==etag:
            return self.send(304,b'',mime,'no-cache',etag)
        self.send(200,data,mime,'no-cache',etag)

    def do_POST(self):
        try:
            if self.headers.get('Origin') and self.headers['Origin'] != 'http://' + self.headers.get('Host', ''):
                return self.send(403, {'error': '请从本机报价页面操作'})
            if not self.headers.get('Content-Type', '').startswith('application/json'):
                return self.send(415, {'error': '请使用JSON请求'})
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 35 * 1024 * 1024:
                return self.send(413, {'error': '请求内容过大'})
            body = json.loads(self.rfile.read(size))
            kind = urlparse(self.path).path.removeprefix('/api/')
            if kind == 'quote-entry-plan':
                from quote_entry import plan
                return self.send(200, plan(body, entry_catalog(), credential_path()))
            if kind == 'history-import':
                from history_learning import ingest
                from types import SimpleNamespace
                storage=SimpleNamespace(records=records,validate_pricebook=validate_pricebook,db=db,save=save)
                return self.send(200,ingest(body,DATA,job_store(),storage))
            if kind == 'quote-audit':
                return self.send(200, prepare(body)['completeness'])
            if kind == 'export-config':
                from export_templates import save as save_export_config
                return self.send(200, save_export_config(DATA, body))
            if kind == 'export-config-preview':
                from business_export import content as business_content
                from export_templates import validate
                config = validate(body.get('config'))
                preview_quote = {**(body.get('quote') or {}), 'exportConfig': config}
                result = prepare(preview_quote)
                return self.send(200, business_content(result, config))
            if kind == 'quotation-document':
                from business_export import content as business_content
                from export_templates import load as load_export_config
                from quotation_document import seed, apply as apply_document
                result = prepare(body)
                model = business_content(result, load_export_config(DATA)['config'])
                if not body.get('exportDocument'):
                    model = apply_document(model, body, seed(body, model))
                return self.send(200, {'document': model['document'], 'model': model})
            if kind == 'rules-memory':
                from rules_memory import save_rules
                return self.send(200, save_rules(DATA, body))
            if kind == 'extract-local':
                from document_import import extract_local
                return self.send(200, extract_local(body, DATA))
            if kind == 'store-source':
                from document_import import store_original
                return self.send(200, store_original(body, DATA))
            if kind == 'parameter-jobs':
                return self.send(200, job_store().start({**body, 'mode': 'parameters'}))
            if kind == 'decomposition-jobs':
                return self.send(200, job_store().start(body))
            if kind.startswith('decomposition-jobs/') and kind.endswith('/retry'):
                return self.send(200, job_store().retry(kind.split('/')[1]))
            if kind == 'extract-process':
                result = extract_process(body)
                result['pages'] = read_images(result['pages'], credential_path())
                return self.send(200, result)
            if kind == 'decompose':
                return self.send(200, decompose(body, credential_path()))
            if kind == 'process-mappings':
                headers, columns = body.get('headerRows'), body.get('columns')
                if not isinstance(headers, list) or not 1 <= len(headers) <= 30 or any(not isinstance(row, list) or not 1 <= len(row) <= 300 or any(not isinstance(cell, str) for cell in row) for row in headers):
                    raise ValueError('工艺表头映射无效')
                width = len(headers[0])
                name, seq = body.get('name'), body.get('seq')
                if type(name) is not int or not 0 <= name < width or seq is not None and (type(seq) is not int or not 0 <= seq < width or seq == name):
                    raise ValueError('请选择不同的工序和工位号列')
                if not isinstance(columns, dict) or any(not key.isascii() or not key.isdecimal() or int(key) >= width or not isinstance(value, str) or len(value) > 100 for key, value in columns.items()):
                    raise ValueError('字段映射无效')
                return self.send(200, save(kind, body))
            if kind == 'process-scope-rules':
                limits = {'key': 12000, 'condition': 500, 'counterexample': 500, 'reason': 500}
                if body.get('status') not in ('confirmed', 'included') or any(not isinstance(body.get(key), str) or not 1 <= len(body[key].strip()) <= limit for key, limit in limits.items()):
                    raise ValueError('请填写有效的供货规则、适用条件、依据及反例')
                return self.send(200, save(kind, body))
            if kind == 'decomposition-examples':
                modules = body.get('modules')
                if not isinstance(modules, list) or not 1 <= len(modules) <= 250:
                    raise ValueError('样例需要1—250个有效部件模块')
                return self.send(200, save(kind, body))
            if kind == 'ai-review':
                return self.send(200, ai_review(body, knowledge_catalog(), credential_path()))
            if kind == 'pricebooks':
                from history_learning import immutable_save
                return self.send(200, immutable_save(validate_pricebook(body),db,save))
            if kind in ('quotes', 'templates'):
                prepare(body)
                for row in body['rows']:
                    if (row.get('pricing') or {}).get('mode') in ('formula', 'assembly', 'linked_reference'):
                        value = base_price(row, body)
                        row['basePrice'] = float(value) if value is not None else None
                        row['pricing']['price'] = row['basePrice']
                return self.send(200, save(kind, body))
            if kind == 'parts':
                if not str(body.get('name', '')).strip():
                    raise ValueError('请填写部件名称')
                price = dec(base_price({**body, 'basePrice': body.get('price')}), '部件单价', True)
                body['price'] = float(rounded(price)) if price is not None else None
                return self.send(200, save(kind, body))
            if kind == 'excel-template-choice':
                from reference_excel import select_profile
                selected=select_profile(body)
                return self.send(200,{'id':selected['id'] if selected else 'custom'})
            if kind == 'reference-excel':
                from business_export import content as business_content
                from export_templates import load as load_export_config
                from reference_excel import select_profile, render, MIME
                export_kind=body.pop('referenceExportKind','business')
                if export_kind not in ('business','contract'):raise ValueError('Excel原稿种类无效')
                result=prepare(body,final=body.get('exportMode')=='final')
                result['businessContent']=business_content(result,load_export_config(DATA)['config'])
                blob,_=render(result,select_profile(body,export_kind))
                if body.get('exportMode')=='final':
                    from quotation_lifecycle import issue
                    issue(result,db)
                return self.send(200,blob,MIME)
            if kind in ('prepare-business-export', 'business-pdf'):
                from business_export import content as business_content, pdf_bytes as business_pdf
                from export_templates import load as load_export_config
                result = prepare(body, final=body.get('exportMode') == 'final')
                template = load_export_config(DATA)
                result['businessContent'] = business_content(result, template['config'])
                result['businessContent']['exportConfigRevision'] = template['revision']
                if not result['businessContent']['selectedCount']:
                    raise ValueError('没有选中的供货部件')
                if body.get('exportMode') == 'final':
                    from quotation_lifecycle import issue
                    result['issuedVersion'] = issue(result, db)['version']
                return self.send(200, business_pdf(result), 'application/pdf') if kind == 'business-pdf' else self.send(200, export_response(result))
            if kind == 'prepare-export' or kind == 'pdf':
                result = prepare(body, final=body.get('exportMode') == 'final')
                if not any(not is_requirement(r) and not is_included(r) and r.get('selected') is not False for r in body['rows']):
                    raise ValueError('尚无已确认供货明细，请先确认供货范围')
                from export_layout import content, plan
                result['exportContent'] = content(result)
                if body.get('exportMode') == 'final':
                    from quotation_lifecycle import issue
                    result['issuedVersion'] = issue(result, db)['version']
                if kind == 'prepare-export':
                    result['layout'] = plan(result)
                return self.send(200, pdf_bytes(result), 'application/pdf') if kind == 'pdf' else self.send(200, export_response(result))
            if kind == 'settings':
                value = str(body.get('apiKey', '')).strip()
                if not value or len(value) > 1000:
                    raise ValueError('请填写有效的API Key')
                credential_path().parent.mkdir(parents=True, exist_ok=True)
                temp = credential_path().with_suffix('.pending')
                temp.write_bytes(protect(value))
                os.replace(temp, credential_path())
                return self.send(200, settings())
            return self.send(404, {'error': '接口不存在'})
        except (ValueError, KeyError, TypeError) as err:
            self.send(400, {'error': str(err) if not isinstance(err, json.JSONDecodeError) else '请求内容无效'})
        except Exception:
            self.send(500, {'error': '本机服务未完成操作，请检查磁盘空间和PDF依赖后重试'})

    def do_DELETE(self):
        if self.headers.get('Origin') and self.headers['Origin'] != 'http://' + self.headers.get('Host', ''):
            return self.send(403, {'error': '请从本机报价页面操作'})
        path = urlparse(self.path).path.removeprefix('/api/')
        if path == 'settings':
            credential_path().unlink(missing_ok=True)
            return self.send(200, settings())
        pieces = path.split('/')
        if len(pieces) != 2 or pieces[0] not in ('quotes', 'templates', 'parts', 'pricebooks'):
            return self.send(404, {'error': '接口不存在'})
        with closing(db()) as con, con:
            con.execute('DELETE FROM records WHERE kind=? AND id=?', pieces)
        self.send(200, {'ok': True})

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=19904)
    parser.add_argument('--open', action='store_true', help='Open the local workbench in the default browser')
    args = parser.parse_args()
    db().close()
    print(f'报价工作台：http://127.0.0.1:{args.port}/', flush=True)
    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    if args.open:
        import threading
        import webbrowser
        threading.Timer(.3, lambda: webbrowser.open(f'http://127.0.0.1:{args.port}/')).start()
    httpd.serve_forever()
