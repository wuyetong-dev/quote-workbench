"""Local resumable jobs around the existing source-grounded decomposition.

Only explicitly supplied source pages/fragments enter a job. Credentials are
resolved at execution time and are never serialized with the project or job.
"""
import copy
import json
import os
from pathlib import Path
import re
import threading
from datetime import datetime, timezone

from ai_assist import AssistError
from decomposition import VERSION, decompose, fingerprint, read_images
from decomposition_runner import prepare


def now():
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, directory, credential_path, *, generate=None, recognize=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.credential_path = credential_path
        self.generate = generate
        self.recognize = recognize or read_images
        self._lock = threading.RLock()
        self._threads = {}
        self._slots = threading.BoundedSemaphore(2)

    def _credential(self):
        return Path(self.credential_path() if callable(self.credential_path) else self.credential_path)

    def _path(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{24}', job_id):
            raise ValueError('补查任务编号无效。')
        return self.directory / (job_id + '.json')

    def _read(self, job_id):
        path = self._path(job_id)
        if not path.is_file():
            raise ValueError('没有找到该补查任务。')
        return json.loads(path.read_text(encoding='utf-8'))

    def _write(self, job):
        job['updatedAt'] = now()
        path = self._path(job['jobId'])
        temp = path.with_suffix('.pending')
        temp.write_text(json.dumps(job, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        os.replace(temp, path)

    def _public(self, job):
        result = copy.deepcopy(job.get('result', {}))
        states = result.get('batchStates', [])
        semantic_only = bool(states) and all(s.get('status') in ('completed', 'partial') and not s.get('error') for s in states)
        pending_pages = any(p.get('status') != 'completed' for p in job.get('recognition', []))
        status = 'completed' if job['status'] == 'partial' and semantic_only and not pending_pages else job['status']
        can_retry = status in ('partial', 'failed', 'interrupted') and (pending_pages or not states or any(s.get('status') in ('failed', 'pending', 'running') for s in states))
        result['status'] = status
        return {'jobId': job['jobId'], 'quoteId': job['request'].get('quoteId'),
                'version': VERSION, 'status': status, 'canRetry': can_retry,
                'needsReview': len(result.get('rejectedComponents', [])), 'stage': job.get('stage', 'decomposing'),
                'createdAt': job['createdAt'], 'updatedAt': job['updatedAt'],
                'completedBatches': result.get('completedBatches', 0),
                'totalBatches': result.get('batches', 0), 'failedBatches': result.get('failedBatches', 0),
                'completedPages': sum(p.get('status') == 'completed' for p in job.get('recognition', [])),
                'totalPages': len(job.get('recognition', [])),
                'result': result, 'error': job.get('error', result.get('error', ''))}

    def get(self, job_id):
        with self._lock:
            job = self._read(job_id)
            if job['status'] in ('running', 'queued') and not self._threads.get(job_id, None):
                job['status'] = 'interrupted'
                job['error'] = '上次补查未完成，已保存成功部分，可继续。'
                self._write(job)
            return self._public(job)

    def _request(self, body):
        if not isinstance(body, dict):
            raise ValueError('补查资料格式无效。')
        if body.get('mode')=='history':
            ids=body.get('historyBookIds')
            if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(not isinstance(i,str) or len(i)>100 for i in ids):
                raise ValueError('历史资料任务编号无效')
            from history_learning import VERSION as HISTORY_VERSION
            return {'mode':'history','historyBookIds':sorted(set(ids)),'sourcePages':[],'historyVersion':HISTORY_VERSION}
        # Deliberately whitelist, so a client can never persist an API key,
        # authorization header or arbitrary application settings in this store.
        request = {k: copy.deepcopy(body[k]) for k in ('fragments', 'modules', 'baseline', 'quoteId', 'sourcePages', 'allowLocalModel', 'mode', 'parameterRequests', 'recognitionPlan', 'knowledgeContext', 'relationTasks') if k in body}
        if request.get('mode') == 'parameters':
            from parameter_parser import prepare as prepare_parameters, VERSION as PARAMETER_VERSION
            prepare_parameters(request)
            request['parameterVersion'] = PARAMETER_VERSION
        request.setdefault('fragments', [])
        pages = request.get('sourcePages', [])
        if not isinstance(pages, list) or len(pages) > 60:
            raise ValueError('每次补查最多60个图像页。')
        clean_pages = []
        for page in pages:
            if (not isinstance(page, dict) or not isinstance(page.get('id'), str)
                    or not isinstance(page.get('sourceIndex'), int) or not 0 <= page['sourceIndex'] < 200
                    or not isinstance(page.get('image', ''), str) or not isinstance(page.get('text', ''), str)):
                raise ValueError('图像页来源格式无效。')
            clean_pages.append({k: page[k] for k in ('id', 'sourceIndex', 'text', 'image', 'source', 'recognition', 'recognitionStatus') if k in page})
        request['sourcePages'] = clean_pages
        if request['fragments']:
            prepare(request)
            from relation_decisions import tasks as relation_tasks
            request['relationTasks'] = relation_tasks(request, request['fragments'])
        elif not clean_pages:
            raise ValueError('当前没有可补查的原文或图像页，请先导入资料。')
        if len(json.dumps(request, ensure_ascii=False).encode('utf-8')) > 40 * 1024 * 1024:
            raise ValueError('补查资料过大，请按60页或40MB以内分批导入。')
        return request

    def start(self, body, *, background=True):
        request = self._request(body)
        job_id = fingerprint({'version': VERSION, 'request': request})[:24]
        with self._lock:
            if self._path(job_id).is_file():
                return self.get(job_id)
            job = {'jobId': job_id, 'status': 'queued', 'stage': 'recognizing' if request['sourcePages'] else 'decomposing',
                   'request': request, 'checkpoint': {}, 'createdAt': now(), 'result': {},
                   'recognition': [{'id': fingerprint(p)[:20], 'status': 'pending', 'attempts': 0} for p in request['sourcePages']]}
            self._write(job)
            if background:
                self._launch(job_id)
                return self.get(job_id)
        return self.run(job_id)

    def _launch(self, job_id):
        if job_id in self._threads:
            return
        def work():
            with self._slots:
                self.run(job_id)
        thread = threading.Thread(target=work, name='quote-source-' + job_id[:8], daemon=True)
        self._threads[job_id] = thread
        thread.start()

    def retry(self, job_id, *, background=True):
        with self._lock:
            job = self._read(job_id)
            if job_id in self._threads or self._public(job)['status'] == 'completed':
                return self.get(job_id)
            job['status'] = 'queued'
            job.pop('error', None)
            self._write(job)
            if background:
                self._launch(job_id)
                return self.get(job_id)
        return self.run(job_id)

    def _recognized(self, job):
        return [{**state['page'], 'sourceIndex': original['sourceIndex']}
                for original, state in zip(job['request']['sourcePages'], job['recognition']) if state.get('page')]

    def _save_progress(self, job, result):
        with self._lock:
            result = copy.deepcopy(result)
            result['recognizedPages'] = self._recognized(job)
            job['result'] = result
            job['status'] = result.get('status', 'running')
            self._write(job)

    def run(self, job_id):
        with self._lock:
            job = self._read(job_id)
            if job.get('status') == 'completed':
                return self._public(job)
            job['status'] = 'running'
            self._write(job)
        try:
            if job['request'].get('mode')=='history':
                from history_learning import run
                result=run(job['request'],self._credential(),self.generate,checkpoint=job['checkpoint'],on_progress=lambda r:self._save_progress(job,r))
                self._save_progress(job,result)
                return self._public(job)
            fragments = {f['id']: copy.deepcopy(f) for f in job['request']['fragments']}
            for page, state in zip(job['request']['sourcePages'], job['recognition']):
                if state.get('status') != 'completed':
                    job['stage'] = 'recognizing'
                    state['status'] = 'running'
                    state['attempts'] += 1
                    self._save_progress(job, {**job.get('result', {}), 'status': 'running'})
                    try:
                        recognized = self.recognize([page], self._credential())[0]
                        state['page'] = {k: v for k, v in recognized.items() if k != 'image'}
                        state['status'] = 'completed' if recognized.get('recognitionStatus') != 'pending' and recognized.get('text') else 'pending'
                    except (AssistError, ValueError):
                        state['status'] = 'pending'
                        state['page'] = {'id': page['id'], 'text': page.get('text', ''), 'source': page.get('source', ''),
                                         'recognitionStatus': 'pending', 'recognitionError': '该页识别尚未完成，可继续重试。'}
                    self._save_progress(job, {**job.get('result', {}), 'status': 'running'})
                recognized = state.get('page', {})
                if recognized.get('text'):
                    fragment_id = 's' + str(page['sourceIndex']) + ':' + page['id']
                    fragments[fragment_id] = {'id': fragment_id, 'text': recognized['text'], 'source': page.get('source', ''),
                                              'recognition': recognized.get('recognition', 'vision_transcription')}
            if not fragments:
                result = {'version': VERSION, 'provider': 'DeepSeek', 'status': 'key_required' if not self._credential().is_file() else 'failed',
                          'components': [], 'unresolvedSourceIds': [], 'sourceCount': 0, 'batches': 0,
                          'error': '图像文字尚未识别，原资料已保存；配置DeepSeek或稍后继续，仍可编辑已有明细。'}
            else:
                request = {**job['request'], 'fragments': list(fragments.values())}
                job['stage'] = 'decomposing'
                if request.get('mode') == 'parameters':
                    from parameter_parser import run as execute
                else:
                    execute = decompose
                result = execute(request, self._credential(), self.generate, checkpoint=job['checkpoint'],
                                   on_progress=lambda r: self._save_progress(job, r))
                pending_pages = any(s['status'] != 'completed' for s in job['recognition'])
                if pending_pages and result['status'] == 'completed':
                    result['status'] = 'partial'
                    result['error'] = '已识别文字已完成补查，部分图像页仍待识别，可继续。'
            self._save_progress(job, result)
        except (ValueError, AssistError):
            with self._lock:
                job['status'] = 'failed'
                job['error'] = '补查尚未完成，已保存的资料和成功部分保留，可继续。'
                self._write(job)
        except Exception:
            with self._lock:
                job['status'] = 'interrupted'
                job['error'] = '补查中断，已保存分段进度；可继续未完成部分。'
                self._write(job)
        finally:
            with self._lock:
                self._threads.pop(job_id, None)
        return self.get(job_id)
