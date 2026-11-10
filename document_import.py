"""Local document extraction. Facts and page geometry precede optional AI."""
import base64
import hashlib
import json
import re
from pathlib import Path

from decomposition import extract


def store_original(body, data_dir):
    raw = base64.b64decode(body['data'], validate=True)
    filename = str(body.get('filename', '')).strip()
    if not raw or len(raw) > 20 * 1024 * 1024 or Path(filename).suffix.lower() not in ('.xls', '.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.webp'):
        raise ValueError('原资料须为20MB以内的Excel、PDF或图片')
    digest = hashlib.sha256(raw).hexdigest()
    folder = Path(data_dir) / 'source-documents'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (digest + '.bin')
    if not target.exists():
        target.write_bytes(raw)
    metadata = {'filename': Path(filename).name, 'documentId': digest}
    # Identical content under a different filename must never overwrite the
    # original identity. The caller can keep its alias on its case record.
    metadata_path=folder / (digest + '.json')
    if not metadata_path.exists():
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding='utf-8')
    return metadata


def extract_local(body, data_dir):
    source = extract(body)
    raw = base64.b64decode(body['data'], validate=True)
    source.update(store_original(body, data_dir), extractionVersion='2026-11-07.local-documents.1')
    if source['filename'].lower().endswith('.pdf'):
        import pymupdf
        with pymupdf.open(stream=raw, filetype='pdf') as document:
            for page, item in zip(document, source['pages']):
                item['tables'] = []
                try:
                    tables = page.find_tables()
                    for index, table in enumerate(tables.tables):
                        values = table.extract()
                        if len(values) < 2 or max((len(row) for row in values), default=0) < 2:
                            continue
                        item['tables'].append({'id': item['id'] + ':table-' + str(index + 1),
                                               'rows': values, 'bbox': list(table.bbox),
                                               'cells': [list(cell) if cell else None for cell in table.cells]})
                except (ValueError, RuntimeError):
                    item['tableStatus'] = 'unresolved'
    for page in source['pages']:
        page['recognitionStatus'] = 'pending' if page.get('image') and not page.get('text', '').strip() else 'local'
        if page['recognitionStatus'] == 'pending':
            page['recognitionError'] = '图片文字待识别，已保留原页，可继续编辑现有明细'
    customers = []
    for page in source['pages']:
        for line_number, line in enumerate(page.get('text', '').splitlines(), 1):
            match = re.match(r'^\s*(?:客户名称|客\s*户|买方名称|甲方名称)\s*[:：]\s*(\S.*)$', line)
            if match:
                value = match.group(1).strip()
                if not any(item['value'] == value for item in customers):
                    customers.append({'value': value, 'source': page.get('source'), 'pageId': page['id'], 'line': line_number, 'text': line})
    if customers:
        source['metadata'] = {'customerCandidates': customers}
        if len(customers) == 1:
            source['metadata']['customer'] = customers[0]['value']
    return source


def original_document(document_id, data_dir):
    if len(document_id) != 64 or any(c not in '0123456789abcdef' for c in document_id):
        raise ValueError('原资料编号无效')
    folder = Path(data_dir) / 'source-documents'
    meta = json.loads((folder / (document_id + '.json')).read_text(encoding='utf-8'))
    return meta, (folder / (document_id + '.bin')).read_bytes()
