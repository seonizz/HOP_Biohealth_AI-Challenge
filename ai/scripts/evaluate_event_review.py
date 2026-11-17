#!/usr/bin/env python3
"""Score a frozen supplemental event curriculum; never repair model outputs.

CLI: --bundle ROOT --outputs responses.jsonl --report report.json
Responses: {request_id,status:"ok",finish_reason:"stop",text:"<JSON>"}.
Missing, failed, truncated and invalid responses retain their assigned denominator.
Thresholds are proposed research gates, not evidence of deployment readiness.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


VERSION = 'event-review-evaluation-v1'
FIELDS = ('person', 'attribute', 'value', 'time', 'negated', 'certainty')
ISSUE_FIELDS = ('index', 'field', 'expected', 'actual', 'rule')
DEFAULT_THRESHOLDS = {
    'schema_completion': 1.0, 'normal_approval': .95, 'bad_rejection': .95,
    'bad_issues_exact': .95, 'fact_exact': .95, 'time_accuracy': .98,
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def read_rows(path):
    return [strict_json(line) for line in Path(path).read_text().splitlines() if line.strip()]


def require(value, message):
    if not value:
        raise ValueError(message)


def schema_valid(value, schema):
    allowed = {'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
               'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum'}
    require(not set(schema) - allowed, 'Unsupported output schema keyword')
    kind = schema.get('type')
    kinds = {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'integer': int}
    require(kind in kinds, 'Unsupported output schema type')
    if type(value) is not kinds[kind] or ('enum' in schema and value not in schema['enum']):
        return False
    if kind == 'object':
        props = schema.get('properties', {})
        return (set(schema.get('required', [])) <= value.keys()
                and (schema.get('additionalProperties') is not False or value.keys() <= props.keys())
                and all(schema_valid(v, props[k]) for k, v in value.items() if k in props))
    if kind == 'array':
        return (schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', float('inf'))
                and all(schema_valid(v, schema['items']) for v in value))
    if kind == 'string':
        return schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', float('inf'))
    if kind == 'integer':
        return schema.get('minimum', -float('inf')) <= value <= schema.get('maximum', float('inf'))
    return True


def fact_valid(fact):
    return (type(fact) is dict and set(fact) == set(FIELDS)
            and all(type(fact[k]) is str and bool(fact[k]) for k in FIELDS))


def valid_output(task, value, schema):
    if not schema_valid(value, schema):
        return False
    if task == 'event_state':
        if type(value) is not dict or set(value) != {'facts'} or type(value['facts']) is not list:
            return False
        facts = value['facts']
        if not all(fact_valid(f) for f in facts):
            return False
        return len({(f['person'], f['attribute']) for f in facts}) == len(facts)
    if type(value) is not dict or set(value) != {'approved', 'issues'}:
        return False
    if type(value['approved']) is not bool or type(value['issues']) is not list:
        return False
    issues = value['issues']
    if value['approved'] != (not issues):
        return False
    for issue in issues:
        if (type(issue) is not dict or set(issue) != set(ISSUE_FIELDS)
                or type(issue['index']) is not int or issue['index'] < 0
                or issue['field'] not in FIELDS
                or any(type(issue[k]) is not str or not issue[k] for k in ('expected', 'actual'))
                or issue['rule'] != 'latest_supported_tuple'):
            return False
    return len({(i['index'], i['field']) for i in issues}) == len(issues)


def tuples(rows, fields):
    return Counter(tuple(row[k] for k in fields) for row in rows)


def metric(num, den):
    return {'numerator': num, 'denominator': den, 'value': num / den if den else None}


def index_rows(rows, label):
    result = {}
    for row in rows:
        require(type(row) is dict and type(row.get('request_id')) is str and row['request_id'],
                'Missing request identity in ' + label)
        require(row['request_id'] not in result, 'Duplicate request identity in ' + label)
        result[row['request_id']] = row
    return result


def score_rows(inputs, references, outputs, baseline=None, thresholds=None, split='validation'):
    """Pure evaluator; bundle entry point additionally verifies frozen source artifacts."""
    requests = index_rows(inputs, 'inputs')
    gold = index_rows(references, 'references')
    received = index_rows(outputs, 'outputs')
    require(requests and requests.keys() == gold.keys(), 'Input/reference inventory mismatch')
    require(received.keys() <= requests.keys(), 'Unknown output request identity')
    require(split in ('validation', 'test'), 'Only held-out evaluation splits are supported')
    counters = Counter(assigned=len(inputs))
    strata = {field: Counter() for field in FIELDS}
    records = []
    for request_id, request in requests.items():
        ref = gold[request_id]
        task = request['task']
        require(task in ('event_state', 'event_review') and ref['task'] == task, 'Task mismatch')
        payload = strict_json(request['messages'][-1]['content'])
        schema, data, target = payload['output_schema'], payload['data'], ref['target']
        require(valid_output(task, target, schema), 'Invalid reference target')
        expected = target.get('facts', [])
        is_normal = task == 'event_review' and target['approved']
        is_bad = task == 'event_review' and not target['approved']
        if task == 'event_state':
            counters['state_assigned'] += 1
            counters['gold_slots'] += len(expected)
        elif is_normal:
            counters['normal_assigned'] += 1
        else:
            counters['bad_assigned'] += 1
            counters['gold_issues'] += len(target['issues'])
            require(ref.get('changed_field') in FIELDS, 'Missing negative field stratum')
            strata[ref['changed_field']]['assigned'] += 1
        output = received.get(request_id)
        value, eligible, reason = None, False, 'missing'
        if output is not None:
            if output.get('status') != 'ok':
                reason = 'execution_error'
            elif output.get('finish_reason') != 'stop':
                reason = 'incomplete'
            elif type(output.get('text')) is not str:
                reason = 'invalid_json'
            else:
                try:
                    value = strict_json(output['text'])
                except (ValueError, TypeError):
                    reason = 'invalid_json'
                else:
                    eligible = valid_output(task, value, schema)
                    reason = 'eligible' if eligible else 'invalid_schema'
        counters[reason] += 1
        record = {'request_id': request_id, 'task': task, 'eligible': eligible, 'status': reason}
        if not eligible:
            if is_normal:
                counters['normal_invalid'] += 1
            if is_bad:
                strata[ref['changed_field']]['invalid'] += 1
            records.append(record)
            continue
        if task == 'event_state':
            facts = value['facts']
            exact = tuples(facts, FIELDS) == tuples(expected, FIELDS)
            counters['fact_exact'] += exact
            actual = {(f['person'], f['attribute']): f for f in facts}
            for fact in expected:
                got = actual.get((fact['person'], fact['attribute']))
                counters['latest_values_correct'] += got is not None and got['value'] == fact['value']
                counters['time_correct'] += got is not None and got['time'] == fact['time']
            record['fact_exact'] = exact
        else:
            approved, issues = value['approved'], value['issues']
            record['approved'] = approved
            if is_normal:
                counters['normal_approved'] += approved
                counters['normal_rejected'] += not approved
            else:
                exact = tuples(issues, ISSUE_FIELDS) == tuples(target['issues'], ISSUE_FIELDS)
                counters['bad_rejected'] += not approved
                counters['bad_issues_exact'] += exact
                strata[ref['changed_field']]['rejected'] += not approved
                strata[ref['changed_field']]['issues_exact'] += exact
                record['issues_exact'] = exact
                predicted = {(i['index'], i['field']): i for i in issues}
                for expected_issue in target['issues']:
                    got = predicted.get((expected_issue['index'], expected_issue['field']))
                    index, field = expected_issue['index'], expected_issue['field']
                    draft = data['draft']
                    counters['actual_grounded'] += (got is not None and index < len(draft)
                                                   and got['actual'] == draft[index][field])
                    counters['expected_grounded'] += got is not None and got['expected'] == expected_issue['expected']
            for issue in issues:
                counters['predicted_issues'] += 1
                index, field = issue['index'], issue['field']
                counters['predicted_actual_grounded'] += (index < len(data['draft'])
                                                          and issue['actual'] == data['draft'][index][field])
                counters['equal_actual_expected_issues'] += issue['actual'] == issue['expected']
        records.append(record)
    definitions = {
        'schema_completion': ('eligible', 'assigned'), 'normal_approval': ('normal_approved', 'normal_assigned'),
        'normal_false_rejection': ('normal_rejected', 'normal_assigned'),
        'normal_invalid': ('normal_invalid', 'normal_assigned'), 'bad_rejection': ('bad_rejected', 'bad_assigned'),
        'bad_issues_exact': ('bad_issues_exact', 'bad_assigned'), 'fact_exact': ('fact_exact', 'state_assigned'),
        'latest_value_accuracy': ('latest_values_correct', 'gold_slots'), 'time_accuracy': ('time_correct', 'gold_slots'),
        'actual_grounding': ('actual_grounded', 'gold_issues'), 'expected_grounding': ('expected_grounded', 'gold_issues'),
        'predicted_issue_actual_grounding': ('predicted_actual_grounded', 'predicted_issues'),
    }
    metrics = {name: metric(counters[num], counters[den]) for name, (num, den) in definitions.items()}
    positive, negative = metrics['normal_approval']['value'], metrics['bad_rejection']['value']
    metrics['balanced_decision_accuracy'] = {'value': (positive + negative) / 2 if positive is not None and negative is not None else None}
    cohort = digest({'split': split, 'inputs': sorted(inputs, key=lambda r:r['request_id']),
                     'references': sorted(references, key=lambda r:r['request_id'])})
    limits = dict(DEFAULT_THRESHOLDS)
    if thresholds is not None:
        require(not set(thresholds) - limits.keys(), 'Unknown gate threshold')
        require(all(type(v) in (int, float) and 0 <= v <= 1 for v in thresholds.values()), 'Invalid gate threshold')
        limits.update(thresholds)
    failures = [name for name, limit in limits.items()
                if metrics[name]['value'] is None or metrics[name]['value'] < limit]
    regressions = []
    if baseline is not None:
        require(baseline.get('schema') == VERSION and baseline.get('cohort_sha256') == cohort
                and baseline.get('split') == split, 'Baseline must use the same evaluator and frozen cohort')
        for name in limits:
            before, after = baseline['metrics'][name]['value'], metrics[name]['value']
            require(before is not None and type(before) in (int, float) and 0 <= before <= 1,
                    'Baseline critical metric is absent/invalid')
            if after is None or after < before:
                regressions.append(name)
    return {'schema': VERSION, 'split': split, 'cohort_sha256': cohort,
            'outputs_sha256': digest(sorted(outputs, key=lambda r:r['request_id'])),
            'counts': dict(counters), 'metrics': metrics,
            'negative_field_strata': {field: {'assigned': c['assigned'], 'invalid': c['invalid'],
                'rejection': metric(c['rejected'], c['assigned']),
                'issues_exact': metric(c['issues_exact'], c['assigned'])} for field, c in strata.items()},
            'gate': {'passed': not failures and not regressions, 'thresholds': limits,
                     'failed_thresholds': failures, 'regressions': regressions,
                     'policy': 'proposed_research_gate_not_deployment_approval'},
            'records': records,
            'notes': ['All request metrics use assigned denominators; invalid and missing responses never count as successes.',
                      'Fact field metrics use all gold slots with one-to-one person/attribute matching.',
                      'actual_grounding and expected_grounding use all gold issues; predicted_issue_actual_grounding describes returned issues only.',
                      'A rejected faulty draft counts only as a correct decision; exact issue correctness is scored separately.',
                      'No output is repaired, fence-stripped, regenerated, or filled from the reference.']}


def evaluate(bundle, output_path, split='validation', baseline=None, thresholds=None):
    import event_review_curriculum as curriculum
    bundle = Path(bundle)
    verification = curriculum.verify(bundle)
    folder = bundle / 'evaluation' / split
    report = score_rows(read_rows(folder/'inputs.jsonl'), read_rows(folder/'references.jsonl'),
                        read_rows(output_path), baseline=baseline, thresholds=thresholds, split=split)
    report['bundle_verification'] = verification
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--outputs', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--split', choices=('validation', 'test'), default='validation')
    parser.add_argument('--baseline-report', type=Path)
    args = parser.parse_args()
    baseline = strict_json(args.baseline_report.read_text()) if args.baseline_report else None
    report = evaluate(args.bundle, args.outputs, args.split, baseline)
    # A report may contain generated responses only as diagnostic booleans/counts,
    # but must never overwrite frozen data or the immutable response evidence.
    destination = args.report.resolve()
    require(not destination.is_relative_to(args.bundle.resolve()), 'Keep reports outside the frozen bundle')
    require(destination != args.outputs.resolve(), 'Report would overwrite response evidence')
    if args.baseline_report:
        require(destination != args.baseline_report.resolve(), 'Report would overwrite baseline')
    with args.report.open('x') as handle:
        handle.write(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    print(json.dumps({'report': str(args.report), 'gate': report['gate']}, ensure_ascii=False))
    return 0 if report['gate']['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
