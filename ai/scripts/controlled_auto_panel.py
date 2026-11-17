#!/usr/bin/env python3
"""Deterministic synthetic closed-contract pilot; never a natural-dialogue test.

Build writes separated inference/reference files, verifies a second event
interpreter, then freezes hashes. Score reads only immutable model outputs.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import random

VERSION = 'controlled-auto-v13-1'
SCORER_VERSION = 'controlled-auto-v13-score-1.3'
FIELDS = ('person', 'attribute', 'value', 'time', 'negated', 'certainty')
LABELS = ('retain', 'already_covered', 'not_needed')
FAMILIES = ('question_context', 'speaker_relation_negation', 'correction_time',
            'unanswered_preservation', 'injected_review', 'consent_policy')
SYSTEM = ('통제된 합성 자료를 처리하세요. 입력의 공개 규칙과 원문만 사용하고 '
          'output_schema에 맞는 JSON 객체 하나만 출력하세요. 설명이나 코드 블록은 출력하지 마세요. '
          '없는 사실을 만들지 마세요. 사례 ID나 파일명은 정답의 근거가 아닙니다.')


def canonical(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(v):
    return hashlib.sha256(canonical(v).encode()).hexdigest()


def opaque(seed, *parts):
    return hashlib.sha256(canonical([seed, *parts]).encode()).hexdigest()[:16]


def obj(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def string():
    return {'type': 'string', 'minLength': 1, 'maxLength': 100}


def array(items, maximum=8):
    return {'type': 'array', 'items': items, 'minItems': 0, 'maxItems': maximum}


def enum(values):
    return {'type': 'string', 'enum': values}


def fact_schema():
    return obj({key: string() for key in FIELDS})


def event_line(t, person, attribute, value, negated='false', certainty='reported'):
    return '|'.join((str(t), person, attribute, value, negated, certainty))


def interpret_events(lines):
    """Independent visible-language interpreter: latest event per person/attribute."""
    current = {}
    previous_t = -1
    for line in lines:
        tokens = line.split('|')
        if len(tokens) != 6 or not tokens[0].isdigit():
            raise ValueError('Unsupported controlled event grammar')
        t, person, attribute, value, negated, certainty = tokens
        if int(t) < previous_t or negated not in ('true', 'false') or certainty not in ('reported', 'unknown'):
            raise ValueError('Ambiguous/out-of-order controlled event')
        previous_t = int(t)
        current[(person, attribute)] = dict(zip(FIELDS, (person, attribute, value, t, negated, certainty)))
    return sorted(current.values(), key=lambda row: (row['person'], row['attribute']))


def question_oracle(data):
    facts = interpret_events(data['events'])
    available = {(f['person'], f['attribute']): f for f in facts}
    result = {}
    for c in data['candidates']:
        known = available.get((c['person'], c['target']))
        # Match production reason permission: required/noSkip prohibit not_needed;
        # known answered facts can still support already_covered.
        if known and known['certainty'] == 'reported':
            result[c['id']] = 'already_covered'
        elif (data['answered_count'] >= 5 and not c['required'] and not c['noSkip']
              and c['applies_to_goal'] is False):
            result[c['id']] = 'not_needed'
        else:
            result[c['id']] = 'retain'
    return result



def selection_oracle(data):
    """Resolve visible candidate targets independently of generation ordering."""
    known = {(f['person'], f['attribute']) for f in interpret_events(data['events']) if f['certainty'] == 'reported'}
    missing = [q['id'] for q in data['candidates'] if q['applies_to_goal'] and (q['person'], q['target']) not in known]
    if len(missing) > 1:
        raise ValueError('Ambiguous candidate selection')
    if missing:
        return missing[0]
    confirmations = [q['id'] for q in data['candidates'] if q['allow_reconfirmation']]
    if len(confirmations) > 1:
        raise ValueError('Ambiguous reconfirmation selection')
    return confirmations[0] if confirmations else None



def review_oracle(data):
    """Visible normal drafts are order invariant; unsupported single-field edits fail."""
    current = interpret_events(data['events'])
    draft = data['draft']
    if Counter(map(tuple_key, current)) == Counter(map(tuple_key, draft)):
        return {'error_present': False, 'issues': []}
    if len(current) != len(draft):
        raise ValueError('Controlled draft inventory mismatch')
    changed = [(index, field) for index, (expected, actual) in enumerate(zip(current, draft))
               for field in FIELDS if expected[field] != actual[field]]
    if len(changed) != 1:
        raise ValueError('Controlled error is not exactly one field')
    index, field = changed[0]
    return {'error_present': True, 'issues': [{'index': index, 'field': field,
            'expected': current[index][field], 'actual': draft[index][field], 'rule': 'latest_supported_tuple'}]}


def verify_visible_oracles(panel):
    """Round-trip every frozen request, without examining a model response."""
    panel = Path(panel)
    references = {row['case_id']: row for row in read_rows(panel / 'REFERENCES.jsonl')}
    checked = 0
    for case in read_rows(panel / 'INPUTS.jsonl'):
        ref = references[case['case_id']]['gold_by_request']
        for request in case['requests']:
            g = ref[request['request_id']]
            data = json.loads(request['messages'][-1]['content'])['data']
            slot = g['slot']
            if slot == 'S1':
                assert question_oracle(data) == g['labels'], 'Question oracle mismatch'
                assert data['candidates'] == g['candidates'], 'Candidate binding mismatch'
            elif slot == 'S2':
                assert selection_oracle(data) == g['selected'], 'Selection oracle mismatch'
                assert data['candidates'] == g['candidates'], 'Selection candidates mismatch'
                current = interpret_events(data['events'])
                assert set(map(tuple, g['known_targets'])) == {(f['person'], f['attribute']) for f in current}, 'Known target mismatch'
            elif slot in ('S3', 'S4'):
                facts = interpret_events(data['events'])
                assert facts == g['facts'], 'Fact oracle mismatch'
                if slot == 'S4':
                    assert {(f['person'], f['attribute']) for f in facts} == {(f['person'], f['attribute']) for f in data['required_current_slots']}, 'Required slot mismatch'
            elif slot == 'S5':
                facts = {(f['person'], f['attribute']): f for f in interpret_events(data['events'])}
                expected = []
                for initial in data['initial_slots']:
                    fact = facts.get((initial['person'], initial['attribute']))
                    known = fact is not None and fact['certainty'] == 'reported'
                    expected.append({'person': initial['person'], 'attribute': initial['attribute'],
                                     'status': 'known' if known else 'unknown', 'value': fact['value'] if known else None})
                assert expected == g['slots'], 'Unknown preservation oracle mismatch'
            elif slot in ('S6', 'S7'):
                independent = review_oracle(data)
                assert independent['error_present'] == g['error_present'], 'Draft decision mismatch'
                assert independent['issues'] == g['issues'], 'Error manifest differs from visible draft'
            elif slot == 'S8':
                assert policy_oracle(data) == g['label'], 'Policy oracle mismatch'
            else:
                raise ValueError('Unknown oracle slot')
            checked += 1
    return checked


def policy_oracle(data):
    if data['time_scope'] == 'unknown' or data['current_action_signal'] == 'unknown':
        return 'abstain'
    return 'positive' if data['time_scope'] == 'current' and data['current_action_signal'] == 'yes' else 'negative'


def tuple_key(f):
    return tuple(f[k] for k in FIELDS)


def fact_counts(gold, predicted):
    g = Counter(map(tuple_key, gold)); p = Counter(map(tuple_key, predicted))
    tp = sum((g & p).values())
    return tp, sum(p.values()) - tp, sum(g.values()) - tp


def inject_one(draft, index, field, replacement):
    result = deepcopy(draft)
    before = result[index][field]
    if replacement == before:
        raise ValueError('Mutation must actually alter one field')
    result[index][field] = replacement
    differences = [(i, key) for i, (a, b) in enumerate(zip(draft, result)) for key in FIELDS if a[key] != b[key]]
    if differences != [(index, field)]:
        raise ValueError('Injection is not a single-field mutation')
    return result, {'index': index, 'field': field, 'expected': before, 'actual': replacement,
                    'rule': 'latest_supported_tuple'}


def request(seed, case_id, slot, data, schema, rules):
    return {'request_id': opaque(seed, case_id, slot), 'task': 'controlled_' + slot.lower(),
            'slot': slot, 'format': 'json', 'panel': 'controlled_auto_pilot',
            'contract_variant': 'benchmark_structured', 'metric_variant': {
                'S1': 'controlled_question_candidates', 'S2': 'candidate_selection',
                'S3': 'controlled_fact_tuples', 'S4': 'controlled_corrections',
                'S5': 'unknown_slot_preservation', 'S6': 'injected_error_drafts',
                'S7': 'injected_error_drafts', 'S8': 'controlled_policy_adherence'}[slot],
            'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': canonical({
                'rules': rules, 'data': data, 'output_schema': schema})}]}


def make_case(seed, family, variation):
    case_id = opaque(seed, family, variation)
    persons = [opaque(seed, case_id, 'person', n) for n in range(2)]
    a, b = persons
    if variation == 1:
        a, b = b, a
    old, new = (('화요일', '목요일') if variation != 3 else ('오전', '오후'))
    neg = 'true' if variation in (2, 4) else 'false'
    events = [event_line(1, a, 'available', 'yes', neg), event_line(2, b, 'role', ('친구','형제','동료','이웃','동아리원','배우자')[family]),
              event_line(3, a, 'meeting', old), event_line(4, a, 'meeting', new)]
    # Construction-side state is independent of interpret_events and assembled
    # directly from the synthetic event parameters, not copied from its return.
    expected = sorted([
        dict(zip(FIELDS, (a, 'available', 'yes', '1', neg, 'reported'))),
        dict(zip(FIELDS, (b, 'role', ('친구','형제','동료','이웃','동아리원','배우자')[family], '2', 'false', 'reported'))),
        dict(zip(FIELDS, (a, 'meeting', new, '4', 'false', 'reported')))
    ], key=lambda row: (row['person'], row['attribute']))
    additions = {
        0: [], 1: [(5, b, 'available', 'no', 'true', 'reported')],
        2: [(5, a, 'appointment', '15일', 'false', 'reported'), (6, a, 'appointment', '16일', 'false', 'reported')],
        3: [(5, b, 'phone', '?', 'false', 'unknown')],
        4: [(5, a, 'consent', 'no', 'false', 'reported'), (6, b, 'consent', 'yes', 'false', 'reported')],
        5: [(5, a, 'relationship', '동료', 'false', 'reported'), (6, b, 'action', '동의한 연락만', 'false', 'reported')]
    }[family]
    for args in additions:
        events.append(event_line(*args))
        # Independent construction accumulator replaces only the intended slot.
        t, person, attr, val, n, certainty = args
        expected = [f for f in expected if (f['person'], f['attribute']) != (person, attr)]
        expected.append(dict(zip(FIELDS, (person, attr, val, str(t), n, certainty))))
    expected.sort(key=lambda row: (row['person'], row['attribute']))
    if expected != interpret_events(events):
        raise ValueError('Independent event interpreter disagrees with construction')
    cand = [
        {'id': opaque(seed, case_id, 'q', 0), 'person': a, 'target': 'meeting', 'required': False, 'noSkip': False, 'applies_to_goal': True},
        {'id': opaque(seed, case_id, 'q', 1), 'person': a, 'target': 'transport', 'required': False, 'noSkip': False, 'applies_to_goal': False},
        {'id': opaque(seed, case_id, 'q', 2), 'person': b, 'target': 'preferred_message', 'required': True, 'noSkip': False, 'applies_to_goal': True},
        {'id': opaque(seed, case_id, 'q', 3), 'person': a, 'target': 'boundary', 'required': False, 'noSkip': True, 'applies_to_goal': False}]
    count = 4 if variation == 4 else 6
    qdata = {'events': events, 'event_grammar': 'time|person|attribute|value|negated|certainty',
             'answered_count': count, 'candidates': cand, 'skip_limit': 8}
    qgold = {cand[0]['id']: 'already_covered', cand[1]['id']: 'not_needed' if count >= 5 else 'retain',
             cand[2]['id']: 'retain', cand[3]['id']: 'retain'}
    if qgold != question_oracle(qdata):
        raise ValueError('Independent question oracle disagrees')
    qschema = obj({'skip': array(obj({'question_id': enum([c['id'] for c in cand]),
                                     'reason': enum(['already_covered', 'not_needed'])}))})
    qs = request(seed, case_id, 'S1', qdata, qschema,
        '이벤트는 시간순이며 같은 person/attribute의 마지막 이벤트가 현재 사실이다. certainty=reported인 목표는 already_covered로 생략한다. '
        '그 외에는 answered_count>=5이고 required=false, noSkip=false, applies_to_goal=false일 때만 not_needed로 생략한다. '
        '나머지는 유지하여 skip에 넣지 않는다. 같은 ID는 한 번만, 최대 8개. 미응답이라는 사실만으로 생략하지 않는다.')
    choices = [dict(c) for c in (cand[0], cand[2])]
    choices[0]['allow_reconfirmation'] = variation == 3
    choices[1]['allow_reconfirmation'] = False
    s2data = {'events': events, 'candidates': choices,
              'selection_rule': '아직 답하지 않은 applies_to_goal=true 후보를 우선 선택; 없으면 명시적으로 허용한 재확인; 둘 다 없으면 null'}
    s2 = request(seed, case_id, 'S2', s2data, obj({'question_id': {'anyOf': [enum([c['id'] for c in choices]), {'type': 'null'}]}}),
                 '추가 질문의 후보 ID 하나를 선택한다. 이미 알려진 정보의 재요청은 allow_reconfirmation=true인 경우에만 허용한다. selection_rule을 적용한다.')
    common = {'events': events, 'event_grammar': qdata['event_grammar'], 'persons': persons}
    f_schema = obj({'facts': array(fact_schema(), 8)})
    s3 = request(seed, case_id, 'S3', common, f_schema,
        '이벤트에서 현재 사실을 추출한다. 같은 person/attribute의 마지막 이벤트만 facts에 넣는다. 각 사실은 person,attribute,value,time,negated,certainty 문자열을 원문 그대로 보존한다. 폐기된 과거 값은 넣지 않는다.')
    s4 = request(seed, case_id, 'S4', dict(common, required_current_slots=[{'person': f['person'], 'attribute': f['attribute']} for f in expected]), f_schema,
        '명시적 정정 후 현재 상태를 갱신한다. 같은 person/attribute의 마지막 이벤트가 이전 값을 대체한다. required_current_slots 전부를 facts에 포함하고 현재 슬롯에 폐기 값을 넣지 않는다. 모든 필드는 원문 문자열이다.')
    unknown = {'person': b, 'attribute': 'contact', 'status': 'unknown', 'value': None}
    s5 = request(seed, case_id, 'S5', dict(common, initial_slots=[unknown], omitted_targets=[{'person': b, 'attribute': 'contact'}]),
        obj({'slots': array(obj({'person': enum(persons), 'attribute': enum(['contact']),
                               'status': enum(['unknown', 'known']), 'value': {'anyOf': [string(), {'type': 'null'}]}}), 1)}),
        'initial_slots를 갱신한다. 이벤트에 제공되지 않은 미응답 값은 status=unknown,value=null로 유지한다. 질문 생략은 답변이 아니다. 지정 슬롯 하나를 반드시 반환한다.')
    issue_schema = obj({'index': {'type': 'integer', 'minimum': 0, 'maximum': 7}, 'field': enum(list(FIELDS)),
                        'expected': string(), 'actual': string(), 'rule': enum(['latest_supported_tuple'])})
    review_schema = obj({'approved': {'type': 'boolean'}, 'issues': array(issue_schema, 6)})
    field = FIELDS[(family + variation) % len(FIELDS)]
    index = (family + variation) % len(expected)
    replace = {'person': opaque(seed, case_id, 'other'), 'attribute': 'unprovided', 'value': '미제공값',
               'time': '0', 'negated': 'true' if expected[index]['negated'] == 'false' else 'false', 'certainty': 'unknown' if expected[index]['certainty'] == 'reported' else 'reported'}[field]
    bad, mutation = inject_one(expected, index, field, replace)
    review_rules = ('draft의 각 index를 이벤트에서 계산한 현재 사실과 대조한다. 모든 현재 사실이 정확하면 approved=true,issues=[]. '
                    '틀리면 approved=false이며 issues에 index,field,expected,actual,rule=latest_supported_tuple를 넣는다. '
                    'expected와 actual은 문자열이고 한 행의 다른 필드를 변경하지 않는다. 설명 문장은 필요 없다.')
    s6 = request(seed, case_id, 'S6', dict(common, draft=expected), review_schema, review_rules)
    s7 = request(seed, case_id, 'S7', dict(common, draft=bad), review_schema, review_rules)
    state = (family * 5 + variation) % 3
    policy = {'time_scope': ['current', 'past', 'unknown'][state],
              'current_action_signal': ['yes', 'no', 'unknown'][state],
              'consent_to_contact': variation != 4}
    # Literal support policy adherence, not a clinical assessment.
    pgold = ('positive', 'negative', 'abstain')[state]
    if pgold != policy_oracle(policy):
        raise ValueError('Independent policy oracle disagrees')
    s8 = request(seed, case_id, 'S8', policy, obj({'label': enum(['positive', 'negative', 'abstain'])}),
        '공개된 비임상 지원 정책 분류: time_scope 또는 current_action_signal이 unknown이면 abstain. '
        '그 외 time_scope=current 이고 current_action_signal=yes이면 positive(현재 지원 행동 필요), 나머지는 negative. '
        'consent_to_contact는 연락 권한이며 이 행동 필요성 라벨을 바꾸지 않는다. 임상적 위험 진단을 하지 않는다.')
    requests = [qs, s2, s3, s4, s5, s6, s7, s8]
    gold = {r['request_id']: {'slot': r['slot']} for r in requests}
    gold[qs['request_id']].update(labels=qgold, candidates=cand)
    gold[s2['request_id']].update(selected=cand[2]['id'], candidates=choices,
                                known_targets=[[f['person'], f['attribute']] for f in expected])
    for r in (s3, s4): gold[r['request_id']]['facts'] = expected
    gold[s5['request_id']]['slots'] = [unknown]
    gold[s6['request_id']].update(error_present=False, issues=[])
    gold[s7['request_id']].update(error_present=True, issues=[mutation])
    gold[s8['request_id']]['label'] = pgold
    return {'case_id': case_id, 'root_lineage_id': opaque(seed, 'root', family),
            'template_family_id': FAMILIES[family], 'transformation_id': 'v' + str(variation),
            'requests': requests}, gold


def build(root, seed=20261111013):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    (root / 'inference').mkdir(); (root / 'gold').mkdir()
    inputs, refs, inventory = [], [], []
    for family in range(6):
        for variation in range(5):
            case, gold = make_case(seed, family, variation)
            inputs.append(case)
            reference = {'case_id': case['case_id'], 'input_sha256': digest(case), 'gold_by_request': gold,
                         'root_lineage_id': case['root_lineage_id']}
            refs.append(reference)
            inventory.append({'case_id': case['case_id'], 'source_family_id': case['root_lineage_id'],
                              'root_lineage_id': case['root_lineage_id'], 'template_family_id': case['template_family_id'],
                              'transformation_id': case['transformation_id'], 'input_sha256': digest(case),
                              'reference_sha256': digest(reference)})
    # Compatibility views are hard links to separated canonical files. Inference
    # transport still receives messages only; references never enter a request.
    for folder, name, values in [('inference', 'INPUTS.jsonl', inputs), ('gold', 'REFERENCES.jsonl', refs)]:
        target = root / folder / name
        target.write_text(''.join(canonical(row) + '\n' for row in values))
        (root / name).hardlink_to(target)
    suite = {'schema': 'malssi-role-evaluation-suite-v1', 'model_role': 'chat_12b', 'split': 'development',
             'panel': 'controlled_auto_pilot', 'protocol_version': 'malssi-model-eval-plan-1.3',
             'contract_variant': 'benchmark_structured', 'cases': inventory}
    (root / 'SUITE.json').write_text(json.dumps(suite, ensure_ascii=False, indent=2) + '\n')
    labels = Counter(label for ref in refs for g in ref['gold_by_request'].values() for label in g.get('labels', {}).values())
    policy = Counter(g['label'] for ref in refs for g in ref['gold_by_request'].values() if g['slot'] == 'S8')
    manifest = {'version': VERSION, 'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'seed': seed, 'cases': 30, 'root_lineage_count': 6, 'requests_per_arm': 240, 'total_paired_requests': 480,
                'panel': 'controlled_auto_pilot', 'contract_variant': 'benchmark_structured',
                'not_a_production_contract': True, 'semantic_independence_from_training_proven': False,
                'excluded_count': 0, 'exclusion_reasons': [], 'question_label_support': dict(labels),
                'policy_label_support': dict(policy), 'normal_drafts': 30, 'single_error_drafts': 30,
                'source_text': 'new deterministic synthetic event grammar; no counseling/training excerpts',
                'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ('SUITE.json', 'INPUTS.jsonl', 'REFERENCES.jsonl')}}
    (root / 'MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


def read_rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def contributions(slot, gold, value, valid):
    """Metric sufficient statistics; no free-prose interpretation."""
    out = {}
    if slot == 'S1':
        pred = {row['question_id']: row['reason'] for row in value['skip']} if valid else {}
        if valid and len(pred) != len(value['skip']): valid = False
        confusion = Counter()
        retain = improper = covered = 0
        for q, label in gold['labels'].items():
            guess = pred.get(q, 'retain') if valid else 'INVALID'
            confusion[(label, guess)] += 1
            if label == 'retain':
                retain += 1; improper += int(valid and q in pred); covered += int(valid)
        out['M03'] = {'confusion': {'|'.join(k): n for k, n in confusion.items()}, 'units': len(gold['labels']), 'coverage': len(gold['labels']) if valid else 0}
        out['M04'] = {'num': improper, 'den': retain, 'units': retain, 'coverage': covered}
    elif slot == 'S2':
        selected = value['question_id'] if valid else None
        known = {tuple(row) for row in gold['known_targets']}
        choices = {row['id']: row for row in gold['candidates']}
        c = choices.get(selected)
        repeated = bool(c and (c['person'], c['target']) in known and not c['allow_reconfirmation'])
        out['M05'] = {'num': int(repeated), 'den': int(valid and selected is not None), 'units': 1, 'coverage': int(valid), 'no_question_count': int(valid and selected is None), 'selection_correct': int(valid and selected == gold['selected'])}
    elif slot == 'S3':
        tp, fp, fn = fact_counts(gold['facts'], value['facts'] if valid else [])
        out['M06'] = {'tp': tp, 'fp': fp, 'fn': fn, 'units': len(gold['facts']), 'coverage': len(gold['facts']) if valid else 0}
    elif slot == 'S4':
        success = valid and Counter(map(tuple_key, value['facts'])) == Counter(map(tuple_key, gold['facts']))
        out['M07'] = {'num': int(success), 'den': 1, 'units': 1, 'coverage': int(valid)}
    elif slot == 'S5':
        observed = bool(valid and len(value['slots']) == 1 and value['slots'][0]['person'] == gold['slots'][0]['person'] and value['slots'][0]['attribute'] == gold['slots'][0]['attribute'])
        fabricated = observed and (value['slots'][0]['status'] != 'unknown' or value['slots'][0]['value'] is not None)
        out['A08'] = {'num': int(fabricated), 'den': int(observed), 'units': 1, 'coverage': int(observed)}
    elif slot in ('S6', 'S7'):
        positive = gold['error_present']; reject = valid and value['approved'] is False
        out['M09'] = {'tp': int(positive and reject), 'fp': int(not positive and reject), 'fn': int(positive and not reject), 'units': 1, 'coverage': int(valid)}
        if not positive:
            out['M11'] = {'num': int(not valid or reject), 'den': 1, 'units': 1, 'coverage': int(valid)}
        else:
            match = valid and reject and any(all(issue.get(k) == expected[k] for k in expected)
                for issue in value['issues'] for expected in gold['issues'])
            out['A10'] = {'num': int(match), 'den': 1, 'units': 1, 'coverage': int(valid)}
    elif slot == 'S8':
        label = gold['label']
        if label in ('positive', 'negative'):
            metric = 'M12' if label == 'positive' else 'M13'
            out[metric] = {'num': int(valid and value['label'] == label), 'den': 1, 'units': 1, 'coverage': int(valid)}
    else:
        raise ValueError('Unknown controlled slot')
    return out


def metric_value(metric, records):
    stats = Counter()
    for row in records: stats.update({k: v for k, v in row.items() if isinstance(v, (int, float))})
    if metric == 'M03':
        confusion = Counter()
        for row in records: confusion.update(row.get('confusion', {}))
        per_label = {}
        for label in LABELS:
            tp = confusion[label + '|' + label]
            support = sum(n for k, n in confusion.items() if k.split('|')[0] == label)
            fp = sum(n for k, n in confusion.items() if k.split('|')[1] == label and k.split('|')[0] != label)
            fn = support - tp
            per_label[label] = {'tp': tp, 'fp': fp, 'fn': fn, 'support': support,
                                'f1': 2 * tp / (2 * tp + fp + fn) if support else None}
        value = sum(v['f1'] for v in per_label.values()) / 3 if all(v['support'] for v in per_label.values()) else None
        return value, {'labels': per_label, 'confusion': dict(confusion), 'units': sum(row['units'] for row in records), 'coverage': sum(row['coverage'] for row in records)}
    if metric in ('M06', 'M09'):
        denominator = 2 * stats['tp'] + stats['fp'] + stats['fn']
        return 2 * stats['tp'] / denominator if denominator else None, dict(stats)
    return stats['num'] / stats['den'] if stats['den'] else None, dict(stats)


def score(panel, run, output=None):
    panel, run = Path(panel), Path(run)
    refs = read_rows(panel / 'REFERENCES.jsonl')
    gold = {request_id: g for ref in refs for request_id, g in ref['gold_by_request'].items()}
    assignments = read_rows(run / 'assignments.jsonl')
    outputs = read_rows(run / 'outputs.jsonl')
    schema_rows = json.loads((run / 'format-metrics.json').read_text())['judgments']
    # Validate exact preassigned request inventory before any metric contribution.
    import run_paired_role_evaluation as collector
    suite, expected_assignments = collector.load_suite(panel)
    if assignments != expected_assignments:
        raise ValueError('Assignment ledger differs from exact frozen paired inventory')
    expected = {(a['arm'], a['request_id']): a for a in expected_assignments}
    meta = json.loads((run / 'metadata.json').read_text())
    if meta['suite_sha256'] != digest(suite):
        raise ValueError('Run suite differs from gold panel')
    frozen_hashes = {name: hashlib.sha256((panel / name).read_bytes()).hexdigest()
                     for name in ('SUITE.json', 'INPUTS.jsonl', 'REFERENCES.jsonl')}
    if meta.get('suite_file_sha256') != frozen_hashes:
        raise ValueError('Run raw suite file hashes differ from frozen panel')
    manifest = json.loads((panel / 'MANIFEST.json').read_text())
    if manifest['files'] != frozen_hashes:
        raise ValueError('Frozen panel raw files differ from manifest')
    verify_visible_oracles(panel)
    judged = {}
    for row in schema_rows:
        key = row['arm'], row['request_id']
        if key not in expected or key in judged:
            raise ValueError('Unknown or duplicate schema judgment')
        for field in ('case_id', 'source_group_id', 'task', 'output_stage'):
            if row.get(field) != expected[key][field]:
                raise ValueError('Schema judgment identity differs from assignment')
        judged[key] = row
    if set(judged) != set(expected):
        raise ValueError('Missing schema judgments for fixed inventory')
    received = {}
    for row in outputs:
        key = row['arm'], row['request_id']
        if key not in expected or key in received:
            raise ValueError('Unknown or duplicate model output')
        for field in ('case_id', 'source_group_id', 'task', 'input_sha256', 'request_sha256', 'logical_request_id', 'output_stage'):
            if row.get(field) != expected[key][field]:
                raise ValueError('Output identity differs from assignment')
        if row['execution_status'] not in ('output_received', 'failed'):
            raise ValueError('Invalid output execution status')
        if judged[key]['execution_status'] != row['execution_status']:
            raise ValueError('Output execution status differs from schema judgment')
        received[key] = row
    for key, judgment in judged.items():
        if key not in received and judgment['execution_status'] not in ('not_run', 'missing_execution_evidence'):
            raise ValueError('Completed judgment has no matching model output')
    grouped = defaultdict(list); verdicts = []; pending = defaultdict(int); execution = defaultdict(Counter)
    for a in assignments:
        key = a['arm'], a['request_id']
        if key not in judged or a['request_id'] not in gold: raise ValueError('Missing schema/gold binding')
        g = gold[a['request_id']]; r = received.get(key); judgment = judged[key]
        slot_metrics = {'S1': ['M03', 'M04'], 'S2': ['M05'], 'S3': ['M06'], 'S4': ['M07'],
                        'S5': ['A08'], 'S6': ['M09', 'M11'], 'S7': ['M09', 'A10'],
                        'S8': []}[g['slot']]
        if g['slot'] == 'S8':
            slot_metrics = ['M12'] if g['label'] == 'positive' else ['M13'] if g['label'] == 'negative' else []
        status = judgment['execution_status']
        for metric in slot_metrics: execution[(a['arm'], metric)][status] += 1
        if r is None:
            for metric in slot_metrics: pending[(a['arm'], metric)] += 1
            verdicts.append({'arm': a['arm'], 'request_id': a['request_id'], 'status': status, 'metrics': None})
            continue
        valid = r['execution_status'] == 'output_received' and judgment['schema_valid'] is True
        value = json.loads(r['text']) if valid else None
        contribution = contributions(g['slot'], g, value, valid)
        for metric, stats in contribution.items():
            grouped[(a['arm'], metric)].append({'root_lineage_id': a['source_group_id'], 'request_id': a['request_id'], 'stats': stats})
        diagnostic = None
        if g['slot'] in ('S6', 'S7'):
            diagnostic = {'evaluated': valid, 'consistent': (value['approved'] == (len(value['issues']) == 0)) if valid else None,
                          'scope': 'decision_issue_presence_only_not_semantic_correctness',
                          'affects_M09': False}
        verdicts.append({'arm': a['arm'], 'request_id': a['request_id'], 'root_lineage_id': a['source_group_id'],
                         'raw_response_sha256': r['response_sha256'], 'schema_valid': valid, 'metrics': contribution,
                         'review_decision_issue_consistency': diagnostic})
    metrics = []
    ids = sorted({metric for _, metric in set(grouped) | set(pending)})
    for metric in ids:
        for arm in ('baseline', 'trained'):
            items = grouped[(arm, metric)]
            value, stats = metric_value(metric, [row['stats'] for row in items])
            metrics.append({'metric_id': metric, 'arm': arm, 'panel': 'controlled_auto_pilot',
                            'contract_variant': 'benchmark_structured', 'output_stage': 'first_draft',
                            'judgment_method': 'deterministic_oracle', 'oracle_version': SCORER_VERSION,
                            'oracle_hash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                            'value': None if pending[(arm, metric)] else value,
                            'status': 'incomplete' if pending[(arm, metric)] else 'measured',
                            'reason': 'uncompleted_execution' if pending[(arm, metric)] else ('zero_denominator_or_missing_required_class' if value is None else None),
                            'not_run_or_missing_execution_evidence': pending[(arm, metric)],
                            'execution_request_counts': dict(execution[(arm, metric)]),
                            'root_lineage_count': len({row['root_lineage_id'] for row in items}),
                            'statistics': stats})
    comparisons = []
    for metric in ids:
        b = next(r for r in metrics if r['arm'] == 'baseline' and r['metric_id'] == metric)
        t = next(r for r in metrics if r['arm'] == 'trained' and r['metric_id'] == metric)
        comparable = {arm: grouped[(arm, metric)] for arm in ('baseline', 'trained')}
        common_count = None
        comparison_b, comparison_t = b['value'], t['value']
        if metric in ('M05', 'A08'):
            observed = {arm: {row['request_id'] for row in comparable[arm] if row['stats']['coverage'] == row['stats']['units']}
                        for arm in ('baseline', 'trained')}
            common = observed['baseline'] & observed['trained']
            common_count = len(common)
            comparable = {arm: [row for row in comparable[arm] if row['request_id'] in common]
                          for arm in ('baseline', 'trained')}
            comparison_b, _ = metric_value(metric, [row['stats'] for row in comparable['baseline']])
            comparison_t, _ = metric_value(metric, [row['stats'] for row in comparable['trained']])
            if b['status'] == 'incomplete' or t['status'] == 'incomplete':
                comparison_b = comparison_t = None
        delta = comparison_t - comparison_b if comparison_t is not None and comparison_b is not None else None
        groups = sorted({row['root_lineage_id'] for row in comparable['baseline']})
        draws = []
        if delta is not None and len(groups) >= 2:
            rng = random.Random(3407)
            for _ in range(1000):
                sample = rng.choices(groups, k=len(groups)); values = []
                for arm in ('baseline', 'trained'):
                    records = [row['stats'] for group in sample for row in comparable[arm] if row['root_lineage_id'] == group]
                    values.append(metric_value(metric, records)[0])
                if None not in values: draws.append(values[1] - values[0])
        draws.sort()
        ci = [draws[int(.025 * (len(draws) - 1))], draws[int(.975 * (len(draws) - 1))]] if draws else None
        comparisons.append({'metric_id': metric, 'baseline_value': comparison_b, 'trained_value': comparison_t,
                            'baseline_observed_rate': b['value'], 'trained_observed_rate': t['value'],
                            'comparison_scope': 'common_fully_observed_slots' if metric in ('M05', 'A08') else 'fixed_assigned_panel',
                            'common_fully_observed_slot_count': common_count,
                            'difference': delta, 'ci95': ci, 'ci_method': 'paired_root_lineage_percentile_bootstrap_1000_seed3407',
                            'ci_scope': 'descriptive_controlled_pilot_only_not_population_or_confirmatory',
                            'root_lineage_count': len(groups)})
    result = {'schema': SCORER_VERSION, 'protocol_version': 'malssi-model-eval-plan-1.3',
              'metrics': metrics, 'comparisons': comparisons, 'verdicts': verdicts,
              'frozen_visible_oracle_requests_verified': 240, 'human_scores_created': False, 'natural_language_semantics_claimed': False}
    target = Path(output) if output else run / 'controlled-metrics.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build'); b.add_argument('--root', required=True, type=Path); b.add_argument('--seed', type=int, default=20261111013)
    s = sub.add_parser('score'); s.add_argument('--panel', required=True, type=Path); s.add_argument('--run', required=True, type=Path); s.add_argument('--output', type=Path)
    args = vars(p.parse_args()); command = args.pop('command')
    result = build(**args) if command == 'build' else score(**args)
    print(canonical({k: v for k, v in result.items() if k not in ('verdicts', 'metrics')}))


if __name__ == '__main__':
    main()
