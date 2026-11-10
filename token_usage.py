"""Provider-reported counters only. Never retain headers or response bodies."""
FIELDS = ('prompt_tokens', 'completion_tokens', 'total_tokens',
          'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens')


def add_usage(target, usage):
    if not isinstance(usage, dict):
        return
    target['reportedResponses'] = target.get('reportedResponses', 0) + 1
    for field in FIELDS:
        value = usage.get(field)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            target[field] = target.get(field, 0) + value


def total_usage(records):
    result = {}
    for record in records:
        for key, value in record.get('tokenUsage', {}).items():
            if key in (*FIELDS, 'requests', 'reportedResponses', 'inputCharacters') and isinstance(value, int) and value >= 0:
                result[key] = result.get(key, 0) + value
    return result
