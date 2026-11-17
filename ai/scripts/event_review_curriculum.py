#!/usr/bin/env python3
"""Build and audit a supplemental synthetic event curriculum; never train a model."""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import random
import shutil

import role_dataset as d

VERSION = 'event-review-curriculum-v1'
FIELDS = ('person', 'attribute', 'value', 'time', 'negated', 'certainty')
SPLITS = ('train', 'validation', 'test')
GRAMMAR = 'time|person|attribute|value|negated|certainty'
ATTRIBUTES = ('meeting', 'location', 'availability', 'channel', 'appointment', 'role')
VALUES = ('월요일', '금요일', '오전', '오후', '18일', '23일', '온라인', '전화', '사무실', '외부')
SYSTEM = '입력의 공개 규칙과 자료만 사용하세요. output_schema에 맞는 JSON 객체 하나만 출력하세요. 설명이나 코드블록은 출력하지 마세요.'
STATE_RULE = ('같은 person/attribute의 마지막 이벤트가 현재 사실이다. required_current_slots 전부를 facts에 포함한다. '
              'time은 날짜나 사람 ID가 아니라 선택한 이벤트의 사건 순서 문자열이다. '
              '값이 반복되어도 마지막 이벤트의 time을 복사하고 여섯 필드를 그대로 보존한다.')
REVIEW_RULE = ('이벤트에서 현재 사실을 계산한 뒤 제공된 draft를 대조한다. draft의 순서는 의미가 없다. '
               '모두 정확하면 approved=true,issues=[]. 실제로 틀린 필드만 approved=false와 issues로 보고한다. '
               'index는 draft의 0부터 시작하는 위치, actual은 반드시 draft[index][field] 값, expected는 최신 사실의 값이다. '
               '원문 이력에 과거 값이 있어도 draft가 이미 최신 값이면 오류가 아니다. '
               'actual과 expected가 같으면 오류가 아니다. rule은 latest_supported_tuple이다. time은 사건 순서 문자열이다.')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def read_rows(path):
    return list(d.read_rows(path))


def write_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as handle:
        for row in rows:
            handle.write(canonical(row)+'\n')


def obj(properties):
    return dict(type='object', properties=properties, required=list(properties), additionalProperties=False)


def schema(task):
    string = dict(type='string', minLength=1, maxLength=100)
    facts = dict(type='array', minItems=1, maxItems=16, items=obj({f: string for f in FIELDS}))
    if task == 'event_state':
        return obj({'facts': facts})
    issue = obj(dict(index=dict(type='integer', minimum=0, maximum=15),
                     field=dict(type='string', enum=list(FIELDS)), expected=string, actual=string,
                     rule=dict(type='string', enum=['latest_supported_tuple'])))
    return obj(dict(approved=dict(type='boolean'), issues=dict(type='array', minItems=0, maxItems=16, items=issue)))


def parse_events(data):
    """Independent reverse scan, unlike the generator's forward state accumulator."""
    events = data['events']
    d.require(events and data['event_grammar'] == GRAMMAR, 'Missing event grammar')
    kind = type(events[0])
    d.require(kind in (str, dict) and all(type(x) is kind for x in events), 'Mixed event encoding')
    parsed = []
    for event in events:
        if kind is str:
            parts = event.split('|')
            d.require(len(parts) == 6, 'Wrong pipe arity')
            time, person, attribute, value, negated, certainty = parts
            fact = dict(time=time, person=person, attribute=attribute, value=value, negated=negated, certainty=certainty)
        else:
            fact = dict(event)
        d.require(set(fact) == set(FIELDS) and all(type(v) is str and 0 < len(v) <= 100 for v in fact.values()), 'Bad fact fields')
        d.require(fact['time'].isascii() and fact['time'].isdigit() and int(fact['time']) > 0, 'Bad sequence')
        d.require(fact['negated'] in ('true', 'false') and fact['certainty'] in ('reported', 'unknown'), 'Bad enum')
        parsed.append(fact)
    times = [int(f['time']) for f in parsed]
    d.require(all(a < b for a, b in zip(times, times[1:])), 'Ambiguous or unordered event sequence')
    selected = {}
    for fact in reversed(parsed):
        selected.setdefault((fact['person'], fact['attribute']), fact)
    return [selected[k] for k in sorted(selected)]


def review_target(data):
    """Match exact rows first, so reordered drafts and wrong person/attribute work."""
    current = parse_events(data)
    draft = data['draft']
    remaining = deepcopy(current)
    unmatched = []
    for index, fact in enumerate(draft):
        d.require(set(fact) == set(FIELDS) and all(type(v) is str and v for v in fact.values()), 'Malformed draft')
        if fact in remaining:
            remaining.remove(fact)
        else:
            unmatched.append((index, fact))
    if not remaining and not unmatched:
        return dict(approved=True, issues=[])
    d.require(len(remaining) == len(unmatched) == 1, 'Not a single-field draft perturbation')
    index, actual = unmatched[0]
    expected = remaining[0]
    differences = [f for f in FIELDS if actual[f] != expected[f]]
    d.require(len(differences) == 1, 'Not a single-field change')
    field = differences[0]
    return dict(approved=False, issues=[dict(index=index, field=field, expected=expected[field],
                                          actual=actual[field], rule='latest_supported_tuple')])


def structure_fingerprint(events):
    """Strip names, scalar sequence gaps and literal values; preserve equality graph."""
    maps = {k: {} for k in ('person', 'attribute', 'value')}
    normalized = []
    for fact in events:
        row = []
        for key, mapping in maps.items():
            row.append(mapping.setdefault(fact[key], len(mapping)))
        normalized.append(row + [fact['negated'], fact['certainty']])
    return digest(normalized)


def make_source(seed, number):
    rng = random.Random(f'{VERSION}:{seed}:{number}')
    people = [digest([VERSION, seed, number, p])[:16] for p in range(rng.randint(3, 4))]
    slots = [(p, a) for p in people for a in rng.sample(ATTRIBUTES, rng.randint(2, 3))]
    rng.shuffle(slots)
    events, current = [], {}
    time = rng.randint(13, 500)

    def append(key, value=None, negated=None, certainty=None):
        nonlocal time
        time += rng.randint(2, 9)
        fact = dict(person=key[0], attribute=key[1], value=value or rng.choice(VALUES), time=str(time),
                    negated=negated or rng.choice(('true', 'false')),
                    certainty=certainty or rng.choice(('reported', 'unknown')))
        events.append(fact)
        current[key] = fact

    for key in slots:
        append(key)
    for _ in range(rng.randint(4, 9)):
        key = rng.choice(slots)
        append(key, rng.choice([v for v in VALUES if v != current[key]['value']]))
    # Same value reasserted at a later sequence: value copying alone cannot pass time.
    key = rng.choice(slots)
    previous = current[key]
    append(key, previous['value'], previous['negated'], previous['certainty'])
    append(slots[0], certainty='unknown')
    append(slots[1], negated='true', certainty='reported')
    facts = [current[key] for key in sorted(current)]
    return events, facts


def project(events, facts, root_id, split, field, seed):
    rng = random.Random(f'{seed}:{root_id}:projection')
    draft = deepcopy(facts)
    rng.shuffle(draft)
    if draft == facts:
        draft = draft[1:] + draft[:1]
    index = rng.randrange(len(draft))
    actual = deepcopy(draft)
    original = actual[index][field]
    alternatives = {'person': sorted({f['person'] for f in facts}), 'attribute': list(ATTRIBUTES),
                    'value': list(VALUES), 'time': [f['time'] for f in facts],
                    'negated': ['true', 'false'], 'certainty': ['reported', 'unknown']}
    actual[index][field] = rng.choice([x for x in alternatives[field] if x != original])
    error = dict(approved=False, issues=[dict(index=index, field=field, expected=original,
                                             actual=actual[index][field], rule='latest_supported_tuple')])
    result = []
    for encoding in ('pipe', 'object'):
        encoded = (['|'.join(f[k] for k in ('time', 'person', 'attribute', 'value', 'negated', 'certainty')) for f in events]
                   if encoding == 'pipe' else deepcopy(events))
        for variant, task, target, selected in [('state', 'event_state', {'facts': facts}, None),
                                               ('normal', 'event_review', {'approved': True, 'issues': []}, draft),
                                               ('error', 'event_review', error, actual)]:
            data = dict(event_grammar=GRAMMAR, events=encoded)
            if selected is None:
                data['required_current_slots'] = [dict(person=f['person'], attribute=f['attribute']) for f in draft]
            else:
                data['draft'] = selected
            payload = dict(data=data, rules=STATE_RULE if task == 'event_state' else REVIEW_RULE, output_schema=schema(task))
            messages = [dict(role='system', content=SYSTEM), dict(role='user', content=canonical(payload))]
            request_id = digest([root_id, encoding, variant])[:24]
            input_row = dict(request_id=request_id, task=task, messages=messages, source_root_ids=[root_id])
            reference = dict(request_id=request_id, task=task, target=deepcopy(target),
                             changed_field=field if variant == 'error' else None, source_root_ids=[root_id])
            training = dict(row_id=request_id, task=task, split=split, source_root_ids=[root_id],
                            source_group_ids=[root_id], weight=dict(numerator=1, denominator=1),
                            messages=messages+[dict(role='assistant', content=canonical(target))],
                            loss_message_mask=[0, 0, 1], target_sha256=d.digest(canonical(target)),
                            origin_type='independent_synthetic_closed_contract', variant=f'{encoding}:{variant}')
            result.append((input_row, reference, training))
    return result


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        d.require(not path.is_symlink(), 'Symlink in bundle')
        if path.is_file() and path.name not in ('MANIFEST.json', 'VERIFICATION.json'):
            result[str(path.relative_to(root))] = d.file_hash(path)
    return result


def verify(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root/'MANIFEST.json').read_text())
    d.require(manifest['schema'] == VERSION, 'Wrong curriculum version')
    for name in manifest['files']:
        d.safe_path(root, name)
    d.require(manifest['files'] == inventory(root), 'Bundle changed')
    d.require(manifest['generator_sha256'] == manifest['files']['scripts/event_review_curriculum.py'], 'Generator provenance mismatch')
    course = json.loads((root/'COURSE_PROPOSAL.json').read_text())
    d.require(course['training_started'] is False and course['training_ready'] is False, 'Unexpected training admission')
    d.require(set(course['data']) == {'train', 'validation'}, 'Test entered training course')
    groups, prompts, structures = {}, {}, {}
    report = {}
    source_rows = read_rows(root/'sources.jsonl')
    sources = {r['source_root_id']: r for r in source_rows}
    d.require(len(sources) == len(source_rows), 'Duplicate source')
    seen = set()
    for split in SPLITS:
        inputs = read_rows(root/f'evaluation/{split}/inputs.jsonl')
        refs = read_rows(root/f'evaluation/{split}/references.jsonl')
        d.require(len(inputs) == len(refs), 'Input/reference inventory mismatch')
        lookup = {r['request_id']: r for r in refs}
        d.require(len(lookup) == len(refs), 'Duplicate reference ID')
        groups[split], prompts[split], structures[split] = set(), set(), set()
        counts, per_root = Counter(), {}
        train_rows = read_rows(d.safe_path(root, course['data'][split]['path'])) if split != 'test' else []
        d.require(split == 'test' or len(train_rows) == len(inputs), 'Training/evaluation inventory mismatch')
        if split != 'test':
            d.require(course['data'][split]['rows'] == len(train_rows), 'Course row count mismatch')
        for offset, row in enumerate(inputs):
            request_id = row['request_id']
            d.require(request_id not in seen and request_id in lookup, 'Duplicate/unknown input ID')
            seen.add(request_id)
            ref = lookup[request_id]
            d.require(row['task'] in ('event_state', 'event_review'), 'Unsupported task')
            d.require(len(row['messages']) == 2 and [m['role'] for m in row['messages']] == ['system', 'user']
                      and row['messages'][0]['content'] == SYSTEM, 'Input role or system drift')
            d.require(len(row['source_root_ids']) == 1 and row['source_root_ids'] == ref['source_root_ids'], 'Lineage mismatch')
            lineage = row['source_root_ids'][0]
            source = sources[lineage]
            d.require(source['split'] == split and ref['task'] == row['task'], 'Split/task mismatch')
            payload = json.loads(row['messages'][-1]['content'])
            data = payload['data']
            facts = parse_events(data)
            d.require(payload['output_schema'] == schema(row['task']), 'Schema drift')
            d.require(payload['rules'] == (STATE_RULE if row['task'] == 'event_state' else REVIEW_RULE), 'Instruction drift')
            d.require(len(facts) >= 6 and len({f['person'] for f in facts}) >= 3, 'Old small panel topology reused')
            expected = dict(facts=facts) if row['task'] == 'event_state' else review_target(data)
            d.require(expected == ref['target'], 'Incorrect semantic label')
            event_dicts = data['events'] if isinstance(data['events'][0], dict) else [
                dict(zip(('time', 'person', 'attribute', 'value', 'negated', 'certainty'), x.split('|'))) for x in data['events']]
            d.require(event_dicts == source['events'], 'Source representation drift')
            fingerprint = structure_fingerprint(event_dicts)
            d.require(fingerprint == source['structure_sha256'], 'Structure fingerprint mismatch')
            d.require(lineage == VERSION+':'+digest(event_dicts)[:24], 'Source identity mismatch')
            d.require(SPLITS[int(fingerprint[:8], 16) % 3] == split, 'Content-based split reassigned')
            groups[split].add(lineage); structures[split].add(fingerprint)
            prompt = digest(row['messages'])
            d.require(prompt not in prompts[split], 'Duplicate prompt')
            prompts[split].add(prompt)
            encoding = 'object' if isinstance(data['events'][0], dict) else 'pipe'
            label = ('state' if row['task'] == 'event_state' else 'normal' if expected['approved'] else 'error')
            per_root.setdefault(lineage, Counter())[(encoding, label)] += 1
            counts[row['task']] += 1; counts[label] += 1
            if label == 'error':
                d.require(ref['changed_field'] == expected['issues'][0]['field'], 'Wrong mutation stratum')
                counts['error_'+ref['changed_field']] += 1
            else:
                d.require(ref['changed_field'] is None, 'Label metadata drift')
            if row['task'] == 'event_state':
                d.require(Counter((x['person'], x['attribute']) for x in data['required_current_slots']) ==
                          Counter((x['person'], x['attribute']) for x in facts), 'Required slots mismatch')
            if split != 'test':
                training = train_rows[offset]
                d.check_row(training)
                d.require(training['row_id'] == request_id and training['split'] == split and
                          training['source_root_ids'] == [lineage] and training['source_group_ids'] == [lineage] and
                          training['messages'][:-1] == row['messages'] and
                          json.loads(training['messages'][-1]['content']) == expected, 'Training projection mismatch')
        expected_pairs = Counter({(e, label): 1 for e in ('pipe', 'object') for label in ('state', 'normal', 'error')})
        d.require(all(c == expected_pairs for c in per_root.values()), 'Incomplete positive/negative/encoding pairs')
        d.require(len(groups[split]) == manifest['root_counts'][split], 'Root inventory mismatch')
        d.require(len(structures[split]) == len(groups[split]), 'Duplicate normalized source structure')
        d.require(all(counts['error_'+f] == len(groups[split])//3 for f in FIELDS), 'Unbalanced error fields')
        report[split] = dict(rows=len(inputs), roots=len(groups[split]), counts=dict(counts))
    for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')]:
        d.require(not(groups[a] & groups[b] or prompts[a] & prompts[b] or structures[a] & structures[b]), 'Cross-split leakage')
    d.require(set(sources) == set.union(*groups.values()), 'Unreferenced source inventory')
    return dict(status='passed', partitions=report, cross_split_lineage_collisions=0,
                normalized_structure_collisions=0, training_started=False, training_ready=False,
                scope='synthetic_closed_contract_only_not_app_or_natural_dialogue_validation')


def build(output, counts=None, seed=20261112, base_course=None):
    output = Path(output).absolute()
    counts = counts or dict(train=120, validation=36, test=36)
    d.require(set(counts) == set(SPLITS) and all(type(n) is int and n > 0 and n % 6 == 0 for n in counts.values()), 'Root counts must be positive multiples of six')
    d.require(not output.exists() and output.parent.resolve().name == 'training_data', 'Use fresh ignored training_data directory')
    d.require(output.parent.resolve() == output.parent, 'Symlink output parent')
    base_binding = None
    if base_course:
        base_course = Path(base_course).resolve(strict=True)
        base_binding = dict(path=str(base_course), sha256=d.file_hash(base_course))
    records = {s: [] for s in SPLITS}
    sources, fingerprints, filled = [], set(), Counter()
    number = 0
    while any(filled[s] < counts[s] for s in SPLITS):
        events, facts = make_source(seed, number)
        number += 1
        fingerprint = structure_fingerprint(events)
        split = SPLITS[int(fingerprint[:8], 16) % 3]
        if fingerprint in fingerprints or filled[split] >= counts[split]:
            continue
        fingerprints.add(fingerprint)
        root_id = VERSION+':'+digest(events)[:24]
        field = FIELDS[filled[split] % len(FIELDS)]
        records[split].extend(project(events, facts, root_id, split, field, seed))
        sources.append(dict(source_root_id=root_id, split=split, events=events, structure_sha256=fingerprint))
        filled[split] += 1
    output.mkdir(mode=0o700)
    (output/'scripts').mkdir()
    for source in (Path(__file__), Path(d.__file__), Path(__file__).with_name('evaluate_event_review.py')):
        shutil.copyfile(source, output/'scripts'/source.name)
    write_rows(output/'sources.jsonl', sources)
    parts = {}
    for split in SPLITS:
        entries = records[split]
        write_rows(output/f'evaluation/{split}/inputs.jsonl', [x[0] for x in entries])
        write_rows(output/f'evaluation/{split}/references.jsonl', [x[1] for x in entries])
        if split != 'test':
            path = f'data/{split}.jsonl'
            write_rows(output/path, [x[2] for x in entries])
            parts[split] = dict(path=path, rows=len(entries))
    d.save(output/'COURSE_PROPOSAL.json', dict(schema=VERSION, proposed_phase='event_state_and_review', data=parts,
        base_course_binding=base_binding, training_started=False, training_ready=False,
        admission_requirements=['model-specific tokenization and numeric audit', 'explicit future training scope',
                                'validation gate at base and each phase boundary', 'test reserved for final frozen selection'],
        loss_message_mask='last_assistant_only', evaluation_only_test='evaluation/test',
        role_scope='benchmark_structured_supplement_not_app_review', existing_course_modified=False))
    d.save(output/'MANIFEST.json', dict(schema=VERSION, seed=seed, root_counts=counts, files=inventory(output),
        generator_sha256=d.file_hash(Path(__file__)), existing_evaluation_reused=False,
        semantic_independence_from_same_generator_not_established=True, real_dialogue_validation=False))
    report = verify(output)
    d.save(output/'VERIFICATION.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build')
    b.add_argument('--output', type=Path, required=True)
    b.add_argument('--seed', type=int, default=20261112)
    b.add_argument('--base-course', type=Path)
    for split, count in [('train', 120), ('validation', 36), ('test', 36)]:
        b.add_argument('--'+split+'-roots', type=int, default=count)
    v = sub.add_parser('verify'); v.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    result = (build(args.output, {s: getattr(args,s+'_roots') for s in SPLITS}, args.seed, args.base_course)
              if args.command == 'build' else verify(args.bundle))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
