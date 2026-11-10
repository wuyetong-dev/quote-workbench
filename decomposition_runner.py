"""Bounded source-grounded batches and deterministic result merging.

Checkpoints contain inputs/validated results, never provider headers or keys.
"""
import copy
import json
import relation_decisions
from token_usage import add_usage, total_usage
from decomposition import (VERSION, LOCAL_MODEL, PROMPT, AssistError, fingerprint,
                           normalized, validate, remote, local)


def prepare(body):
    if not isinstance(body, dict):
        raise ValueError('工艺资料格式无效。')
    fragments, modules, baseline = (body.get(k, []) for k in ('fragments', 'modules', 'baseline'))
    if not isinstance(fragments, list) or not 1 <= len(fragments) <= 1200:
        raise ValueError('请选择包含1—1200个有效来源段的工艺资料。')
    if any(not isinstance(f, dict) or not isinstance(f.get('id'), str) or not f['id']
           or not isinstance(f.get('text'), str) for f in fragments):
        raise ValueError('工艺来源格式无效。')
    if len({f['id'] for f in fragments}) != len(fragments) or sum(len(f['text']) for f in fragments) > 600000:
        raise ValueError('工艺来源重复或过大，请按工艺段导入。')
    if not isinstance(modules, list) or len(modules) > 250 or any(not isinstance(m, dict) or not isinstance(m.get('id'), str) for m in modules):
        raise ValueError('拆解样例模块无效。')
    if not isinstance(baseline, list) or len(baseline) > 10000 or any(not isinstance(r, dict) or not isinstance(r.get('id'), str) for r in baseline):
        raise ValueError('已有工程明细格式无效。')
    return fragments, modules, baseline


def chunks(fragments, limit=10000, count_limit=14):
    """Keep full rows together; split oversized pages with original source IDs."""
    batches, current, size = [], [], 0
    for fragment in fragments:
        text = fragment['text']
        pieces = [text[i:i + limit] for i in range(0, len(text), limit)] or ['']
        for index, piece in enumerate(pieces):
            if current and (size + len(piece) > limit or len(current) >= count_limit):
                batches.append(current)
                current, size = [], 0
            item = {k: fragment.get(k) for k in ('id', 'text', 'source', 'sourceRow', 'recognition') if k in fragment}
            item['text'] = piece
            if len(pieces) > 1:
                item['segmentStart'] = index * limit
                item['segmentEnd'] = index * limit + len(piece)
            current.append(item)
            size += len(piece)
    if current:
        batches.append(current)
    return batches


def truncated(error):
    return any(word in str(error) for word in ('截断', '输出超过', '响应过大'))


def bisect_batch(batch):
    """Stable children keep source identities; an oversized page keeps offsets."""
    if len(batch) > 1:
        midpoint = len(batch) // 2
        return [copy.deepcopy(batch[:midpoint]), copy.deepcopy(batch[midpoint:])]
    item = batch[0]
    value = item['text']
    if len(value) <= 512:
        return None
    midpoint = len(value) // 2
    # Prefer a source boundary without permitting an unbalanced recursion.
    separators = [value.rfind(c, len(value) // 3, midpoint + 1) for c in ('\n', '；', ';')]
    midpoint = max(separators) + 1 if max(separators) >= 0 else midpoint
    start = item.get('segmentStart', 0)
    return [[{**copy.deepcopy(item), 'text': value[:midpoint], 'segmentStart': start,
              'segmentEnd': start + midpoint}],
            [{**copy.deepcopy(item), 'text': value[midpoint:], 'segmentStart': start + midpoint,
              'segmentEnd': start + len(value)}]]


def batch_context(chunk, baseline, prior_parts):
    """Station facts are explicit context, distinct from earlier AI proposals."""
    source_ids = {f['id'] for f in chunk}
    locations = {f.get('source') for f in chunk}
    existing = []
    for row in baseline:
        if not (source_ids.intersection(row.get('sourceIds') or []) or row.get('source') and row['source'] in locations):
            continue
        item = {k: row.get(k) for k in ('id', 'name', 'role', 'parentId', 'deviceFamily',
                                       'source', 'scope', 'sourceIds', 'sourceSpec', 'confirmed', 'quantity', 'unit')}
        item['configurationFacts'] = [{k: fact.get(k) for k in ('family', 'text', 'sourceIds')}
                                      for fact in row.get('configurationFacts', []) if isinstance(fact, dict)
                                      and source_ids.intersection(fact.get('sourceIds') or [])]
        existing.append(item)
    return {'fragments': chunk, 'existingComponents': existing,
            'priorObservations': [{k: p.get(k) for k in ('id', 'name', 'sourceIds', 'equipmentTag', 'relationship', 'intent', 'parentId', 'targetExistingId', 'evidence')}
                                  for p in prior_parts[-40:]]}


def recognition_context(body, fragments, baseline):
    """Compact global identity survives batching; source evidence stays local."""
    plan = body.get('recognitionPlan')
    if not isinstance(plan, dict):
        if not body.get('relationTasks'):
            return {}
        plan = {}
    tasks = plan.get('tasks', [])
    if not isinstance(tasks, list) or len(tasks) > 1200:
        raise ValueError('识别整理任务格式无效。')
    knowledge = body.get('knowledgeContext', [])
    if not isinstance(knowledge, list) or len(knowledge) > 40:
        raise ValueError('识别知识上下文格式无效。')
    # Do not forward arbitrary persisted application fields to the model.
    index = [{k: r.get(k) for k in ('id', 'name', 'role', 'parentId', 'deviceFamily',
                                   'sourceIds', 'quantity', 'unit', 'scope')}
             for r in baseline if r.get('role') != 'requirement']
    return {
        'relationTasks': relation_decisions.tasks(body, fragments),
        'recognitionPlan': {k: plan.get(k) for k in ('version', 'tasks', 'pricingPolicy')},
        'knowledgeContext': [{k: e.get(k) for k in ('id', 'title', 'summary', 'conditions', 'sourceRefs')}
                             for e in knowledge if isinstance(e, dict)],
        'documentIndex': index,
        'documentOutline': [{k: f.get(k) for k in ('id', 'source', 'text')} for f in fragments],
    }


def compact_payload(prepared, chunk):
    """Keep ownership/global identities; remove repetitions, never source cells."""
    out = copy.deepcopy(prepared)
    local_ids = {f['id'] for f in chunk}
    complete_ids = {f['id'] for f in chunk if 'segmentStart' not in f}
    out['relationTasks'] = [{k: v for k, v in t.items() if k not in ('basis', 'group')}
                            for t in out.get('relationTasks', [])
                            if local_ids.intersection(t.get('sourceIds', []))]
    documents = {}
    for f in out.get('documentOutline', out['fragments']):
        source = f.get('source')
        if source:
            documents.setdefault(f['id'].split(':')[0], source.rsplit(' / 第', 1)[0])
    out['sourceDocuments'] = [{'id': k, 'source': v} for k, v in documents.items()]
    for f in out['fragments']:
        f.pop('source', None)
    for f in out.get('documentOutline', []):
        f.pop('source', None)
        if f['id'] in complete_ids:
            f.pop('text', None)
    for row in out.get('existingComponents', []):
        row.pop('source', None)
        for fact in row.get('configurationFacts', []):
            if fact.get('sourceIds') == row.get('sourceIds'):
                fact.pop('sourceIds', None)
        for key in ('sourceSpec', 'scope', 'parentId', 'deviceFamily', 'configurationFacts', 'confirmed'):
            if not row.get(key):
                row.pop(key, None)
    for observation in out.get('priorObservations', []):
        if not local_ids.intersection(observation.get('sourceIds') or []):
            observation.pop('evidence', None)
    plan = out.get('recognitionPlan')
    if plan:
        plan['tasks'] = [task for task in plan.get('tasks') or [] if task.get('sourceId') in local_ids]
        # New requests carry retrieval ownership; older requests keep all context.
        if plan['tasks'] and all('knowledgeIds' in task for task in plan['tasks']):
            relevant = {k for task in plan['tasks'] for k in task['knowledgeIds']}
            out['knowledgeContext'] = [entry for entry in out.get('knowledgeContext', []) if entry.get('id') in relevant]
        # Ownership and known conditions are already in existingComponents.
        for task in plan['tasks']:
            for key in ('deviceIds', 'requirementIds', 'knownConditions', 'knowledgeIds'):
                task.pop(key, None)
            if task.get('quantityGaps'):
                task['quantityGaps'] = [{'rowId': gap['rowId']} for gap in task['quantityGaps'] if isinstance(gap, dict) and gap.get('rowId')]
    # Fixed global identities first improve the provider's prefix-cache reuse.
    return {**{key: out[key] for key in ('documentIndex', 'sourceDocuments') if key in out},
            **{key: value for key, value in out.items() if key not in ('documentIndex', 'sourceDocuments')}}


def alias_existing_ids(prepared, existing):
    """Short transport IDs are reversed before validation/persistence."""
    ids = {row['id'] for row in existing}
    mapping, used, index = {}, set(ids), 0
    for row in existing:
        key = row['id']
        if len(key) <= 24 or key in mapping:
            continue
        index += 1
        while 'E' + str(index) in used:
            index += 1
        mapping[key] = 'E' + str(index)
        used.add(mapping[key])
    def replace(value, field=None):
        if isinstance(value, dict):
            return {k: replace(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [replace(v, field) for v in value]
        if field in ('id', 'rowId', 'parentId', 'targetExistingId', 'deviceIds', 'requirementIds') and isinstance(value, str):
            return mapping.get(value, value)
        return value
    return replace(prepared), {short: original for original, short in mapping.items()}


def expand_existing_ids(payload, aliases):
    if not isinstance(payload, dict):
        return payload
    result = copy.deepcopy(payload)
    if 'components' not in result and isinstance(result.get('relationDecisions'), list):
        result['components'] = []
    if not isinstance(result.get('components'), list):
        return payload
    for item in result['components']:
        if not isinstance(item, dict):
            continue
        for field in ('id', 'parentId', 'targetExistingId'):
            value = item.get(field)
            if isinstance(value, str) and value in aliases:
                item[field] = aliases[value]
    for item in result.get('relationDecisions', []) if isinstance(result.get('relationDecisions'), list) else []:
        if isinstance(item, dict) and isinstance(item.get('allocations'), list):
            for allocation in item['allocations']:
                if isinstance(allocation, dict) and isinstance(allocation.get('rowId'), str):
                    allocation['rowId'] = aliases.get(allocation['rowId'], allocation['rowId'])
    return result


def repair_payload(payload, prepared, rejected, aliases, reason):
    """A failed proposal gets its evidence/targets, not the entire quotation again."""
    bad_ids = {r['componentId'] for r in rejected}
    parts = payload.get('components', []) if isinstance(payload, dict) else []
    if not isinstance(parts, list):
        parts = []
    bad = [p for p in parts if not bad_ids or not isinstance(p, dict)
           or aliases.get(p.get('id'), p.get('id')) in bad_ids]
    refs = {ref for p in bad if isinstance(p, dict) for ref in p.get('sourceIds', [])}
    fragments = [f for f in prepared['fragments'] if f['id'] in refs] or prepared['fragments']
    targets = {p.get(k) for p in bad if isinstance(p, dict) for k in ('targetExistingId', 'parentId')}
    existing = [row for row in prepared.get('existingComponents', []) if row['id'] in targets]
    return {'fragments': fragments, 'sourceDocuments': prepared.get('sourceDocuments', []),
            'documentIndex': prepared.get('documentIndex') or [{k: r.get(k) for k in ('id', 'name', 'parentId', 'sourceIds', 'unit', 'quantity')} for r in prepared.get('existingComponents', [])], 'existingComponents': existing,
            'exampleModules': prepared.get('exampleModules', []),
            'acceptedComponents': [{k: p.get(k) for k in ('id', 'name', 'parentId', 'targetExistingId', 'sourceIds')}
                                   for p in parts if isinstance(p, dict) and p not in bad],
            'proposalsToRepair': bad, 'validationError': reason,
            'repairInstruction': '只修proposalsToRepair的来源、编号、关系错误，返回components。acceptedComponents保留且不要重复。缺原文依据的候选删去，不编依据，不新增无关设备。'}


def _parse(raw):
    if isinstance(raw, str):
        if not raw.strip():
            raise AssistError('模型返回空内容；该段尚未完成。')
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            raise AssistError('模型返回的JSON不完整；该段尚未完成。') from None
    if not isinstance(raw, dict):
        raise AssistError('模型返回的部件清单格式无效。')
    return raw


def salvage(payload, fragments, modules, baseline):
    """Reject individual invalid proposals without discarding grounded siblings."""
    if not isinstance(payload, dict) or not isinstance(payload.get('components'), list):
        raise AssistError('拆解模型没有返回有效部件清单。')
    possible = [{'id': p.get('id')} for p in payload['components'] if isinstance(p, dict)]
    kept, rejected = [], []
    for item in payload['components']:
        key = item.get('id') if isinstance(item, dict) else None
        try:
            result = validate({'components': [item]}, fragments, modules,
                              baseline + [p for p in possible if p.get('id') != key])
            kept.append(result['components'][0])
        except (AssistError, TypeError, ValueError) as error:
            rejected.append({'componentId': str(key or '')[:100], 'reason': str(error) if isinstance(error, AssistError) else '来源、数量依据或部件结构未通过校验'})
    # Remove missing/cyclic containment after the evidence-valid subset is known.
    while True:
        by_id = {p['id']: p for p in baseline + kept}
        bad = set()
        for part in kept:
            seen, node = {part['id']}, part
            while node.get('parentId'):
                parent = node['parentId']
                if parent not in by_id or parent in seen:
                    bad.add(part['id'])
                    break
                seen.add(parent)
                node = by_id[parent]
        if not bad:
            break
        rejected.extend({'componentId': p['id'], 'reason': '所属主项缺失或包含关系循环'} for p in kept if p['id'] in bad)
        kept = [p for p in kept if p['id'] not in bad]
    result = validate({'components': kept}, fragments, modules, baseline)
    result['rejectedComponents'] = rejected
    return result


def merge(states, fragments, provider, status='running', usage_history=()):
    parts, aliases, by_key = [], {}, {}
    for state in states:
        for original in state.get('components', []):
            item = copy.deepcopy(original)
            key = item.get('entityKey') or fingerprint([item['name'], item.get('sourceIds'), item.get('evidence')])
            if key in by_key:
                prior = by_key[key]
                aliases[item['id']] = prior['id']
                prior['sourceIds'] = list(dict.fromkeys(prior['sourceIds'] + item['sourceIds']))
                prior['evidence'] = list({fingerprint(e): e for e in prior['evidence'] + item['evidence']}.values())
                if prior['quantity'] != item['quantity']:
                    prior['quantity'] = None
                    prior['status'] = 'needs_engineering'
                    prior['missing'] = list(dict.fromkeys(prior['missing'] + ['跨段数量不一致，需确认供货数量']))
                continue
            aliases[item['id']] = item['id']
            by_key[key] = item
            parts.append(item)
    for part in parts:
        if part.get('parentId') in aliases:
            part['parentId'] = aliases[part['parentId']]
    unresolved = list(dict.fromkeys(source for s in states for source in (
        s.get('unresolvedSourceIds', []) if s.get('status') in ('completed', 'partial') else s['sourceIds'])))
    return {'version': VERSION, 'provider': provider, 'components': parts, 'status': status,
            'relationDecisions': [d for s in states for d in s.get('relationDecisions', [])],
            'relationRejected': [d for s in states for d in s.get('relationRejected', [])],
            'unresolvedSourceIds': unresolved, 'batches': len(states), 'sourceCount': len(fragments),
            'completedBatches': sum(s.get('status') in ('completed', 'partial') for s in states),
            'failedBatches': sum(s.get('status') == 'failed' for s in states),
            'batchStates': [{k: v for k, v in s.items() if k not in ('components',)} for s in states],
            'rejectedComponents': [e for s in states for e in s.get('rejectedComponents', [])],
            'tokenUsage': total_usage([*usage_history, *states]),
            'inputCompaction': {key: sum(s.get('inputCompaction', {}).get(key, 0) for s in states)
                                for key in ('beforeCharacters', 'afterCharacters')}}


def run(body, credential_path, generate=None, *, checkpoint=None, on_progress=None):
    fragments, modules, baseline = prepare(body)
    context = recognition_context(body, fragments, baseline)
    cloud = credential_path.is_file()
    provider = 'DeepSeek' if cloud else LOCAL_MODEL if body.get('allowLocalModel') else 'DeepSeek'
    checkpoint = checkpoint if isinstance(checkpoint, dict) else {}
    limit = checkpoint.get('chunkLimit') or (10000 if cloud else 6000)
    checkpoint['chunkLimit'] = limit
    signature = fingerprint({'version': VERSION, 'fragments': fragments, 'modules': modules, 'baseline': baseline,
                             'limit': limit})
    context_signature = fingerprint({'version': VERSION, 'modules': modules, 'baseline': baseline, 'limit': limit, 'recognition': context})
    previous = {s['id']: s for s in checkpoint.get('batchStates', [])} if checkpoint.get('contextFingerprint') == context_signature else {}
    source_hashes = {f['id']: fingerprint(f['text']) for f in fragments}
    # Newly recognized pages append new batches. Do not regroup a successful
    # earlier page into a larger batch and force an unnecessary model rerun.
    retained = [batch for batch in checkpoint.get('chunkPlans', []) if previous and all(
        checkpoint.get('sourceHashes', {}).get(f['id']) == source_hashes.get(f['id']) for f in batch)]
    covered = {f['id'] for batch in retained for f in batch}
    fresh = chunks([f for f in fragments if f['id'] not in covered], limit, count_limit=40 if context else 14)
    batches = retained + fresh
    if context:
        # Independent second reading checks source coverage against both the
        # local BOM and first-pass additions. Keep source IDs and full evidence.
        batches += [[{**f, 'auditPass': True} for f in batch] for batch in fresh]
    checkpoint['requestFingerprint'] = signature
    checkpoint['contextFingerprint'] = context_signature
    checkpoint['sourceHashes'] = source_hashes
    checkpoint['chunkPlans'] = batches
    old_states = checkpoint.get('batchStates', [])
    checkpoint['batchStates'] = [previous.get(fingerprint(batch)[:16]) or {
        'id': fingerprint(batch)[:16], 'sourceIds': list(dict.fromkeys(f['id'] for f in batch)),
        'status': 'pending', 'attempts': 0} for batch in batches]
    states = checkpoint['batchStates']
    usage_history = checkpoint.setdefault('usageHistory', [])
    for state in old_states:
        if not any(state is active for active in states) and state.get('tokenUsage'):
            usage_history.append({'tokenUsage': copy.deepcopy(state['tokenUsage'])})
    def current_result(status='running'):
        result = merge(states, fragments, provider, status, usage_history)
        result['relationTasks'] = context.get('relationTasks', [])
        return result
    if not cloud and generate is None and not body.get('allowLocalModel'):
        result = current_result('key_required')
        result['error'] = '补充理解需要DeepSeek，请到设置保存Key；本地导入、编辑、计算和导出可继续。'
        if on_progress:
            on_progress(result)
        return result
    def subdivide(index, state):
        children = bisect_batch(batches[index])
        if not children or len(states) >= 4096:
            return False
        child_states = [{'id': fingerprint(child)[:16], 'sourceIds': list(dict.fromkeys(f['id'] for f in child)),
                         'status': 'pending', 'attempts': 0, 'splitFrom': state['id']}
                        for child in children]
        checkpoint.setdefault('splitHistory', []).append({'id': state['id'], 'sourceIds': state['sourceIds'],
                    'reason': '模型输出截断，程序自动缩小资料段', 'childIds': [s['id'] for s in child_states],
                    'attempts': state.get('attempts', 0)})
        if state.get('tokenUsage'):
            usage_history.append({'tokenUsage': copy.deepcopy(state['tokenUsage'])})
        batches[index:index + 1] = children
        states[index:index + 1] = child_states
        if on_progress:
            on_progress(current_result())
        return True

    index = 0
    while index < len(batches):
        chunk, state = batches[index], states[index]
        prior_signature = fingerprint([p for s in states[:index] for p in s.get('components', [])]) if chunk[0].get('auditPass') else None
        if prior_signature and state.get('status') == 'completed' and state.get('priorFingerprint') != prior_signature:
            state['status'] = 'pending'
        if state.get('status') == 'partial' and state.get('rejectedComponents') and not state.get('error'):
            state['status'] = 'completed'
        if state.get('status') == 'completed':
            index += 1
            continue
        # Upgrade old failed checkpoints without charging for the same known
        # oversized request again. Successful siblings remain untouched.
        if state.get('status') == 'failed' and truncated(state.get('error', '')) and subdivide(index, state):
            continue
        state['status'] = 'running'
        state['attempts'] += 1
        if on_progress:
            on_progress(current_result())
        prior_parts = [p for s in states[:index] for p in s.get('components', [])]
        existing = baseline + prior_parts
        prepared = batch_context(chunk, baseline, prior_parts)
        if chunk[0].get('auditPass'):
            prepared['pass'] = 'omission_audit'
            prepared['auditInstruction'] = ('独立复读本段全部原文，与existingComponents、documentIndex及priorObservations逐一对应。'
                '尤其检查夹在备注、其他配套、选项中的实物及不同编号。只补尚未覆盖的实物或工程条件；'
                'priorObservations已有内容不再输出。暂保留设备保留可选性质，不变成必供；没有漏项返回空components。')
        if context:
            prepared.update(context)
            # Whole-source audit is bounded. Larger documents retain identities
            # and the beginning of each source; full evidence is in its batch.
            # Bound aggregate context as well as individual rows. Local station
            # facts always remain complete; omitted global records are explicit.
            remaining, outline = 18000, []
            for f in context['documentOutline']:
                value = f['text'][:min(300, max(0, remaining))]
                outline.append({**f, 'text': value})
                remaining -= len(value)
            prepared['documentOutline'] = outline
            prepared['documentIndex'] = context['documentIndex'][:500]
            prepared['omittedGlobalDeviceCount'] = max(0, len(context['documentIndex']) - 500)
        prepared['exampleModules'] = [{k: m.get(k) for k in ('id', 'name', 'system', 'unit')} for m in modules]
        before_size = len(PROMPT) + len(json.dumps(prepared, ensure_ascii=False))
        prepared = compact_payload(prepared, chunk)
        prepared, aliases = alias_existing_ids(prepared, existing)
        messages = [{'role': 'system', 'content': PROMPT},
                    {'role': 'user', 'content': json.dumps(prepared, ensure_ascii=False, separators=(',', ':'))}]
        state['inputCompaction'] = {'beforeCharacters': before_size,
                                    'afterCharacters': sum(len(m['content']) for m in messages)}
        usage = state.setdefault('tokenUsage', {})
        def invoke(messages):
            if generate:
                return generate(messages)
            if not cloud:
                return local(messages)
            usage['requests'] = usage.get('requests', 0) + 1
            usage['inputCharacters'] = usage.get('inputCharacters', 0) + sum(len(m['content']) for m in messages)
            return remote(messages, credential_path, usage_sink=lambda value: add_usage(usage, value))
        try:
            payload = _parse(invoke(messages))
            from relation_decisions import validate as validate_relations
            state['relationDecisions'], state['relationRejected'] = validate_relations(
                expand_existing_ids(payload, aliases), context.get('relationTasks', []), fragments)
            try:
                valid = validate(expand_existing_ids(payload, aliases), chunk, modules, existing)
                valid['rejectedComponents'] = []
            except AssistError as error:
                # One bounded semantic repair; if it fails, accept only siblings
                # which independently pass the same source and relation checks.
                try:
                    valid = salvage(expand_existing_ids(payload, aliases), chunk, modules, existing)
                except AssistError:
                    valid = {'components': [], 'rejectedComponents': [{'componentId': '', 'reason': str(error)}],
                             'unresolvedSourceIds': [f['id'] for f in chunk]}
                state['repairReasons'] = [str(error)]
                if cloud and generate is None:
                    repair = [{'role': 'system', 'content': PROMPT}, {'role': 'user', 'content': json.dumps(
                        repair_payload(payload, prepared, valid['rejectedComponents'], aliases, str(error)),
                        ensure_ascii=False, separators=(',', ':'))}]
                    try:
                        fixed = expand_existing_ids(_parse(invoke(repair)), aliases)
                        if not isinstance(fixed.get('components'), list):
                            raise AssistError('修正结果没有有效部件清单。')
                        kept = {p['id'] for p in valid['components']}
                        combined = {'components': valid['components'] + [p for p in fixed['components'] if not isinstance(p, dict) or p.get('id') not in kept]}
                        valid = salvage(combined, chunk, modules, existing)
                    except AssistError:
                        pass
            local_ids = {p['id'] for p in valid['components']}
            for part in valid['components']:
                part['id'] = state['id'] + ':' + part['id']
                if part.get('parentId') in local_ids:
                    part['parentId'] = state['id'] + ':' + part['parentId']
            state.update({k: valid[k] for k in ('components', 'unresolvedSourceIds', 'rejectedComponents')})
            # Rejected semantic proposals are preserved for source review.
            # Processing the same successful batch again is not unfinished work.
            state['status'] = 'completed'
            if prior_signature:
                state['priorFingerprint'] = prior_signature
            state.pop('error', None)
        except (AssistError, TimeoutError, ValueError) as error:
            state['status'] = 'failed'
            # Known errors are user-safe labels; never persist provider bodies.
            state['error'] = str(error)[:500] if isinstance(error, AssistError) else '该段尚未完成，请继续重试。'
            if truncated(state['error']) and subdivide(index, state):
                continue
        if on_progress:
            on_progress(current_result())
        if state.get('error') and any(word in state['error'] for word in ('密钥', '余额')):
            break
        index += 1
    finished = all(s.get('status') == 'completed' for s in states)
    any_success = any(s.get('status') in ('completed', 'partial') for s in states)
    result = current_result('completed' if finished else 'partial' if any_success else 'failed')
    result['needsReview'] = len(result.get('rejectedComponents', []))
    result['canRetry'] = any(s.get('status') in ('failed', 'pending') for s in states)
    if not finished:
        result['error'] = '部分资料尚未完成，已通过来源校验的结果已保留，可继续未完成部分。'
    if on_progress:
        on_progress(result)
    return result
