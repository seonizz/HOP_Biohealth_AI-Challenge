"""Collect real BASE12 outputs locally; never convert unreviewed outputs to scores."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'outputs/base12_local_20261009'
PPT = ROOT.parent / 'HOP_pptdata'
MODEL = 'gemma4:12b'
SEED = 3407
LABELS = {'ASK_CFI', 'CLARIFY', 'SUPPORT', 'SUPPORT_LIMITED', 'SAFETY_SUPPORT', 'END'}
SUPPORT_PROMPT = '''너는 가까운 사람의 어려움을 돕는 주변인을 지원하는 말씨다. 한국어로 현재 요청에 답하라.
현재 요청에 답할 정보가 충분하면 구체적으로 건넬 말과 실행 가능한 행동을 안내한다. 도움을 바꿀 정보만 질문하며 주질문은 기본 한 개다. 이미 답한 내용, 모름, 거절, 정정을 기억한다.
사용자의 관찰, 당사자 발언, 제3자의 말, 사용자의 추측을 구분하고 확인되지 않은 진단이나 속마음을 사실처럼 말하지 않는다. 모름이나 거절만으로 지원을 중단하지 않는다.
관계와 의향, 현실적인 자원, 사용자 자신의 한계를 존중한다. 강압, 감시, 위협, 동의 없는 접근을 돕지 않는다. 미성년자에게 성인 가족 문제 해결 책임을 맡기지 않는다.
현재 입력에 근거 있는 급박한 안전 우려가 있으면 안전 지원을 우선한다. 한국어만으로 국가를 추정하거나 확인되지 않은 긴급 번호를 만들지 않는다. 안전 우려가 없는 종료 요청은 존중한다.
불필요한 개인정보를 반복하지 않는다. 간결하고 자연스러운 상담 답변을 작성하라.'''


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path, rows):
    Path(path).write_bytes(b''.join(canonical(r) + b'\n' for r in rows))


def api(path, payload=None):
    request = urllib.request.Request('http://127.0.0.1:11434' + path,
        data=canonical(payload) if payload is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.load(response)


def tokenizer():
    # Reuse an already-installed cached library; no package installation.
    candidates = sorted((Path.home() / '.cache/uv/archive-v0').glob('*/tokenizers'))
    if not candidates:
        raise RuntimeError('Existing tokenizers runtime not found')
    sys.path.insert(0, str(candidates[0].parent))
    from tokenizers import Tokenizer
    model_root = Path.home() / '.ollama/models'
    manifest = json.loads((model_root / 'manifests/registry.ollama.ai/library/gemma4/12b').read_text())
    layer = next(x for x in manifest['layers'] if x.get('name') == 'tokenizer.json')
    return Tokenizer.from_file(str(model_root / 'blobs' / layer['digest'].replace(':', '-')))


def render(messages):
    """Text-only, no-tools subset of Ollama v0.40.0 Gemma4 renderer, think=false."""
    out = '<bos>'
    for i, message in enumerate(messages):
        assert set(message) == {'role', 'content'} and isinstance(message['content'], str)
        role = message['role']
        assert role in {'system', 'user', 'assistant'}
        assert role != 'system' or i == 0
        content = message['content']
        if role == 'assistant':
            content = re.sub(r'<\|channel>.*?<channel\|>', '', content, flags=re.S)
            content = content.split('<|channel>')[0]
        content = content.strip()
        previous = messages[i - 1]['role'] if i else None
        following = messages[i + 1]['role'] if i + 1 < len(messages) else None
        if not (role == 'assistant' and previous == 'assistant'):
            out += '<|turn>' + ('model' if role == 'assistant' else role) + '\n'
        out += content
        if not (role == 'assistant' and following == 'assistant'):
            out += '<turn|>\n'
    return out + '<|turn>model\n<|channel>thought\n<channel|>'


def options(task):
    return {'temperature': 0, 'seed': SEED, 'num_predict': 32 if task == 'action' else 512,
            'num_ctx': 4096, 'top_k': 64, 'top_p': 0.95, 'repeat_penalty': 1.0}


def prepare():
    assert not (WORK / 'run_manifest.json').exists(), 'Run already frozen'
    for folder in ['private/inputs', 'private/requests', 'private/responses', 'private/raw', 'snapshots']:
        (WORK / folder).mkdir(parents=True, exist_ok=True)
    os.chmod(WORK / 'private', 0o700)
    for name in ['발표용_데이터_추출_활용안.md', '발표데이터_최신확인_20261009.json',
                 '에이전트용_발표수치_수집지침.md', 'LLM_학습전후_분류평가.md']:
        shutil.copy2(PPT / name, WORK / 'snapshots' / name)
    shutil.copytree(PPT / '평가양식', WORK / 'snapshots/평가양식', dirs_exist_ok=True)
    tok = tokenizer()
    archive = next(ROOT.glob('*.zip'))
    z = zipfile.ZipFile(archive)
    prefix = 'malssi_stage1_training_20261009/'
    raw_val = z.read(prefix + 'data/validation.jsonl.gz')
    val = [json.loads(x) for x in gzip.decompress(raw_val).splitlines()]
    train = [json.loads(x) for x in gzip.decompress(z.read(prefix + 'data/train.jsonl.gz')).splitlines()]
    profile = json.loads(z.read(prefix + 'data/common_profile_ids.json'))
    common = set(profile['ids_by_split']['validation'])
    action_prompt = (PPT / '평가양식/행동분류_프롬프트.txt').read_text()
    (WORK / 'support_prompt.txt').write_text(SUPPORT_PROMPT)
    (WORK / 'action_prompt.txt').write_text(action_prompt)
    candidates = []
    for row in val:
        if row['id'] not in common:
            continue
        assert row['messages'][-1]['role'] == 'assistant'
        messages = row['messages'][:-1]
        count = len(tok.encode(render(messages), add_special_tokens=False).ids)
        if count + 512 <= 4096:
            candidates.append((row, messages, count))
    candidates.sort(key=lambda x: sha((str(SEED) + x[0]['id']).encode()))
    selected, groups, conversations = [], set(), set()
    for distinct_group in [True, False]:
        for row, messages, count in candidates:
            if len(selected) >= 32:
                break
            if row['source_conversation_id'] in conversations:
                continue
            if distinct_group and row['source_group_id'] in groups:
                continue
            selected.append((row, messages, count))
            conversations.add(row['source_conversation_id']); groups.add(row['source_group_id'])
    assert len(selected) == 32
    specs = []
    for i, (row, messages, count) in enumerate(selected, 1):
        specs.append({'case_id': f'DEV{i:03}', 'split': 'legacy_validation_development',
                      'task': 'response', 'messages': messages, 'source_id': row['id'],
                      'source_group_id': row['source_group_id'],
                      'source_conversation_id': row['source_conversation_id'],
                      'source_target_sha256': row['target_sha256'],
                      'source_quality_status': row['quality_status'], 'input_tokens_preflight': count})
    regression_path = prefix + 'verification_source/docs/support_agent/adversarial_cases.jsonl'
    regression = [json.loads(x) for x in z.read(regression_path).splitlines()]
    excluded = []
    for row in regression:
        for scenario in row['scenarios']:
            sid = scenario['scenario_id']
            if row['kind'] != 'response':
                excluded.append({'case_id': sid, 'reason': 'data_production_pipeline_not_model_response'})
                continue
            source_messages = scenario['input']['messages']
            response_messages = [{'role': 'system', 'content': SUPPORT_PROMPT}] + source_messages
            classification_messages = [{'role': 'system', 'content': action_prompt},
                {'role': 'user', 'content': json.dumps(source_messages, ensure_ascii=False, separators=(',', ':'))}]
            counts = {task: len(tok.encode(render(messages), add_special_tokens=False).ids)
                      for task, messages in [('response', response_messages), ('action', classification_messages)]}
            if any(counts[task] + options(task)['num_predict'] > 4096 for task in counts):
                excluded.append({'case_id': sid, 'reason': 'pre_generation_context_limit', 'tokens': counts})
                continue
            for task, messages in [('response', response_messages), ('action', classification_messages)]:
                specs.append({'case_id': sid, 'split': 'synthetic_public_regression', 'task': task,
                    'messages': messages, 'public_input_messages': source_messages,
                    'source_id': row['case_id'], 'source_group_id': row['scenario_group_id'],
                    'source_conversation_id': sid, 'category': row['category'],
                    'source_quality_status': 'synthetic_public_regression_not_human_approved',
                    'input_tokens_preflight': counts[task],
                    'required_conditions': row['required_conditions'],
                    'forbidden_conditions': row['forbidden_conditions']})
    manifest, jobs = [], []
    for spec in specs:
        task, cid = spec['task'], spec['case_id']
        input_obj = {'case_id': cid, 'task': task, 'messages': spec['messages']}
        input_path = f'private/inputs/{task}_{cid}.json'
        write_json(WORK / input_path, input_obj)
        payload = {'model': MODEL, 'messages': spec['messages'], 'think': False, 'stream': False,
                   'options': options(task), 'keep_alive': '15m'}
        request_path = f'private/requests/{task}_{cid}.json'
        write_json(WORK / request_path, payload)
        spec.pop('messages')
        spec.update({'input_file': input_path, 'input_sha256': sha(canonical(input_obj)),
            'request_file': request_path, 'request_sha256': file_sha(WORK / request_path),
            'prompt_sha256': sha(payload['messages'][0]['content'].encode()),
            'generation_config_sha256': sha(canonical({'options': options(task), 'think': False})),
            'expected_rendered_prompt_sha256': sha(render(payload['messages']).encode()),
            'criterion_applicability': {k: True for k in ['request_resolution', 'actionable_support',
                                                         'subject_evidence', 'question_necessity']},
            'human_review_status': 'pending', 'eligible_for_final_test': False})
        manifest.append(spec)
        jobs.append({'case_id': cid, 'task': task, 'request_file': request_path})
    write_jsonl(WORK / 'case_manifest.jsonl', manifest)
    write_json(WORK / 'jobs.json', jobs)
    overlap = {}
    for key in ['id', 'source_conversation_id', 'source_group_id']:
        overlap[key] = len({r[key] for r in train} & {r[key] for r in val})
    assert not any(overlap.values())
    write_json(WORK / 'dataset_audit.json', {'observed_at': now(), 'archive': str(archive),
        'archive_sha256': file_sha(archive), 'validation_member': prefix + 'data/validation.jsonl.gz',
        'validation_member_sha256': sha(raw_val), 'validation_population': len(val),
        'common_candidate_rows': len(common), 'native_length_eligible_rows': len(candidates),
        'selected_source_rows': 32, 'selected_source_groups': len(groups),
        'selected_source_conversations': len(conversations), 'selection_seed': SEED,
        'selection_rule': 'sha256(seed+id) order; one per group first, then distinct conversations',
        'last_target_removed_from_all_source_inputs': True,
        'legacy_train_validation_overlap_counts': overlap,
        'independent_test': False, 'full_current_train_dev_overlap_audit': None,
        'pre_generation_exclusions': excluded, 'task_counts': dict(Counter(x['task'] for x in specs))})
    tags = json.loads((WORK / 'tags.json').read_text())
    model = next(m for m in tags['models'] if m['name'] == MODEL)
    write_json(WORK / 'run_manifest.json', {'run_id': 'BASE12_MAC_' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'),
        'frozen_at': now(), 'model': model, 'condition': 'BASE12', 'trained_adapter': False,
        'upstream_model_id': 'google/gemma-4-12B-it', 'upstream_revision_binding': None,
        'model_scope': 'Ollama MLX NVFP4 distribution; no project fine tuning; not BF16 original weights',
        'runtime': 'Ollama 0.40.0 / MLX', 'hardware': {'chip': 'Apple M5', 'unified_memory_gib': 32},
        'case_manifest_sha256': file_sha(WORK / 'case_manifest.jsonl'),
        'collector_sha256': file_sha(__file__), 'attempts_per_case': 1, 'concurrency': 1,
        'response_max_new_tokens': 512, 'classification_max_new_tokens': 32, 'context_tokens': 4096,
        'thinking': False, 'seed': SEED, 'temperature': 0,
        'human_review_status': 'pending', 'comparison_ready': False,
        'comparison_limitations': ['development/public regression only', 'BASE31 and FT31 outputs absent',
                                   'BASE31/FT31 tokenizer length not verified', 'human reviews absent']})
    print(json.dumps({'status': 'frozen', 'cases': len(manifest), 'tasks': dict(Counter(s['task'] for s in specs)),
                      'exclusions': excluded}, ensure_ascii=False), flush=True)


def classify_status(response, task, expected_tokens):
    content = response.get('message', {}).get('content', '')
    if response.get('prompt_eval_count') != expected_tokens:
        return 'input_token_mismatch'
    if not response.get('done'):
        return 'incomplete'
    if response.get('done_reason') == 'length':
        return 'length_limit'
    if response.get('done_reason') != 'stop':
        return 'unverified_termination'
    if response.get('message', {}).get('thinking', '').strip():
        return 'unexpected_thinking'
    if not content.strip():
        return 'empty_output'
    if task == 'action' and content.strip() not in LABELS:
        return 'format_error'
    return 'valid'


def run():
    manifest = json.loads((WORK / 'run_manifest.json').read_text())
    assert manifest['case_manifest_sha256'] == file_sha(WORK / 'case_manifest.jsonl')
    verification = json.loads((WORK / 'model_verification.json').read_text())
    assert verification['verified'] is True, 'Model blob verification failed'
    cases = read_jsonl(WORK / 'case_manifest.jsonl')
    ledger = WORK / 'generations.jsonl'
    existing = read_jsonl(ledger) if ledger.exists() else []
    done = {(r['task'], r['case_id']) for r in existing}
    assert len(done) == len(existing)
    for case in cases:
        task, cid = case['task'], case['case_id']
        if (task, cid) in done:
            continue
        request_path = WORK / case['request_file']
        assert file_sha(request_path) == case['request_sha256']
        payload = json.loads(request_path.read_text())
        reservation = payload['options']['num_predict']
        assert case['input_tokens_preflight'] + reservation <= 4096
        generation_id = f"{manifest['run_id']}_{task}_{cid}"
        started = now(); timer = time.monotonic()
        response_path = f'private/responses/{task}_{cid}.txt'
        raw_path = f'private/raw/{task}_{cid}.json'
        # An interrupted network request must not be silently retried as a first attempt.
        attempt_path = WORK / f'private/raw/{task}_{cid}.attempt.json'
        if attempt_path.exists():
            raise RuntimeError(f'Interrupted attempt requires explicit error recovery: {task}/{cid}')
        write_json(attempt_path, {'generation_id': generation_id, 'started_at': started})
        error = None
        try:
            response = api('/api/chat', payload)
            write_json(WORK / raw_path, response)
            status = classify_status(response, task, case['input_tokens_preflight'])
        except Exception as exc:
            response = {}; error = f'{type(exc).__name__}: {exc}'; status = 'generation_error'
            write_json(WORK / raw_path, {'error': error})
        elapsed = time.monotonic() - timer
        content = response.get('message', {}).get('content', '')
        (WORK / response_path).write_text(content)
        row = {'run_id': manifest['run_id'], 'generation_id': generation_id, 'timestamp': started,
            'completed_at': now(), 'condition': 'BASE12', 'model_condition': 'BASE12',
            'model_digest': manifest['model']['digest'], 'adapter_sha256': None,
            'case_id': cid, 'task': task, 'split': case['split'], 'attempt_index': 1,
            'source_group_id': case['source_group_id'], 'input_sha256': case['input_sha256'],
            'prompt_sha256': case['prompt_sha256'], 'generation_config_sha256': case['generation_config_sha256'],
            'request_sha256': case['request_sha256'], 'seed': SEED,
            'input_tokens_preflight': case['input_tokens_preflight'],
            'input_tokens': response.get('prompt_eval_count'), 'generated_tokens': response.get('eval_count'),
            'max_new_tokens': reservation, 'status': status, 'termination': response.get('done_reason'),
            'input_token_count_matches': response.get('prompt_eval_count') == case['input_tokens_preflight'],
            'prefill_exact_match': None, 'prefill_exact_match_limitation': 'Ollama API does not return input token IDs',
            'response_sha256': sha(content.encode()), 'private_response_file': response_path,
            'raw_response_file': raw_path, 'raw_response_sha256': file_sha(WORK / raw_path),
            'latency_seconds': elapsed, 'total_duration_ns': response.get('total_duration'),
            'load_duration_ns': response.get('load_duration'),
            'prompt_eval_duration_ns': response.get('prompt_eval_duration'),
            'eval_duration_ns': response.get('eval_duration'),
            'prompt_eval_cached_count': response.get('prompt_eval_cached_count'),
            'predicted_label': content.strip() if task == 'action' and status == 'valid' else None,
            'peak_gpu_memory_bytes': None, 'error': error}
        with ledger.open('ab') as f:
            f.write(canonical(row) + b'\n'); f.flush(); os.fsync(f.fileno())
        write_json(WORK / 'ps_latest.json', api('/api/ps'))
        print(json.dumps({'case': cid, 'task': task, 'status': status, 'input_tokens': row['input_tokens'],
                          'output_tokens': row['generated_tokens'], 'seconds': round(elapsed, 2)}, ensure_ascii=False), flush=True)
        if status in {'input_token_mismatch', 'unexpected_thinking', 'generation_error'}:
            raise RuntimeError('Runtime gate failed; retain evidence and diagnose before continuing')
    write_json(WORK / 'COLLECTION_COMPLETE.json', {'run_id': manifest['run_id'], 'completed_at': now(),
        'attempted': len(read_jsonl(ledger)), 'assigned': len(cases),
        'generations_sha256': file_sha(ledger), 'semantic_scores_verified': False})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'run'])
    args = parser.parse_args()
    {'prepare': prepare, 'run': run}[args.command]()
