#!/usr/bin/env python3
"""12B-only fixed-cohort review evaluation. Never trains, repairs output, or selects on test."""
import argparse
from collections import Counter, defaultdict
from pathlib import Path

import evaluate_event_review as event
import review_pair_evaluation as paired

VERSION = 'local12b-repair-evaluation-v1'
COVERAGE_VERSION = 'local12b-repair-coverage-v1'
CHALLENGES = ('value_as_time', 'person_as_time', 'none_as_time', 'stale_same_value_time',
              'person', 'attribute', 'value', 'negated', 'certainty')
ENCODINGS = {'pipe', 'object'}
DIRECTIONS = {'negated': {'false->true', 'true->false'},
              'certainty': {'reported->unknown', 'unknown->reported'}}
LIMITS = {'bad_false_approval': .05, 'normal_false_rejection': .05, 'time_error': .02}
BUCKET_LIMITS = {'bad_false_approval': .05, 'normal_false_rejection': .05, 'invalid': 0.0}
BUCKET_EVIDENCE_MINIMUM = .95


def require(ok, message):
    if not ok:
        raise ValueError(message)


def _inventory(inputs, references):
    requests = event.index_rows(inputs, 'inputs'); gold = event.index_rows(references, 'references')
    require(requests.keys() == gold.keys(), 'Input/reference inventory differs')
    attributes, pairs = {}, defaultdict(list)
    for identity, request in requests.items():
        roots = request['source_root_ids']
        require(len(roots) == 1, '12B repair event rows require one source root')
        payload = event.strict_json(request['messages'][-1]['content'])
        history = payload['data']['events']
        require(history and all(isinstance(x, str) for x in history) or
                history and all(type(x) is dict for x in history), 'Mixed or missing event encoding')
        encoding = 'pipe' if isinstance(history[0], str) else 'object'
        for value in (request, gold[identity]):
            if 'encoding' in value:
                require(value['encoding'] == encoding, 'Encoding metadata differs from model input')
        private = [identity, *roots] + ([request['pair_id']] if request.get('pair_id') else [])
        require(all(secret not in message['content'] for secret in private for message in request['messages']),
                'Private evaluation identity leaked into model input')
        attributes[identity] = dict(root=roots[0], encoding=encoding)
        if request['task'] == 'event_review':
            pairs[request['pair_id']].append(identity)
    for identities in pairs.values():
        require(len(identities) == 2, 'Broken review pair')
        negative = next((identity for identity in identities if gold[identity]['target']['approved'] is False), None)
        require(negative is not None, 'Pair lacks negative member')
        ref = gold[negative]; issue = ref['target']['issues'][0]
        challenge = ref.get('challenge', 'unclassified')
        direction = issue['actual'] + '->' + issue['expected']
        bucket_direction = direction if issue['field'] in DIRECTIONS else 'any'
        for identity in identities:
            require(all(attributes[identity][k] == attributes[negative][k] for k in ('root', 'encoding')), 'Pair root/encoding differs')
            for value in (requests[identity], gold[identity]):
                if 'challenge' in value:
                    require(value['challenge'] == challenge, 'Pair challenge differs')
                if 'mutation_direction' in value:
                    require(value['mutation_direction'] == bucket_direction, 'Mutation direction metadata differs')
            for field_key in ('changed_field', 'contrast_field'):
                if field_key in requests[identity]:
                    require(requests[identity][field_key] == issue['field'], 'Request changed-field metadata differs')
            attributes[identity].update(challenge=challenge, direction=bucket_direction,
                                       bucket='|'.join((challenge, attributes[identity]['encoding'], bucket_direction)))
    return requests, gold, attributes


def make_coverage(inputs, references):
    """Freeze a declared cohort before inference; callers must preserve this file."""
    requests, gold, attributes = _inventory(inputs, references)
    splits = {r['split'] for r in inputs + references}
    require(len(splits) == 1 and next(iter(splits)) in ('validation', 'test'), 'Coverage split must be held out')
    buckets = Counter(attributes[k]['bucket'] for k in requests
                      if requests[k]['task'] == 'event_review' and not gold[k]['target']['approved'])
    return dict(schema=COVERAGE_VERSION, split=next(iter(splits)),
                expected_request_ids=sorted(requests),
                expected_source_roots=sorted({a['root'] for a in attributes.values()}),
                required_challenges=list(CHALLENGES), expected_bucket_counts=dict(sorted(buckets.items())),
                inputs_sha256=event.digest(sorted(inputs, key=lambda r: r['request_id'])),
                references_sha256=event.digest(sorted(references, key=lambda r: r['request_id'])))


def _coverage(inputs, references, outputs, attributes, gold, spec):
    roots = defaultdict(lambda: dict(states=set(), normal=set(), bad=set()))
    challenges = set(); directions = defaultdict(set); buckets = Counter()
    for request in inputs:
        identity = request['request_id']; a = attributes[identity]; root = roots[a['root']]
        if request['task'] == 'event_state':
            root['states'].add(a['encoding'])
        else:
            normal = gold[identity]['target']['approved']
            root['normal' if normal else 'bad'].add(a['encoding'])
            if not normal:
                challenges.add(a['challenge']); buckets[a['bucket']] += 1
                directions[a['challenge']].add(a['direction'])
    reasons = []
    if challenges != set(CHALLENGES): reasons.append('nine_challenge_coverage')
    if any(any(root[key] != ENCODINGS for key in ('states', 'normal', 'bad')) for root in roots.values()):
        reasons.append('every_root_both_encodings_state_and_pair')
    for name, required in DIRECTIONS.items():
        if directions[name] != required: reasons.append(name + '_both_mutation_directions')
    ids = {r['request_id'] for r in inputs}; received = {r['request_id'] for r in outputs}
    if received != ids: reasons.append('missing_outputs')
    if spec is None:
        reasons.append('missing_frozen_coverage')
    else:
        require(type(spec) is dict and spec.get('schema') == COVERAGE_VERSION, 'Unknown coverage contract')
        require(set(spec.get('required_challenges', [])) == set(CHALLENGES), 'Coverage may not weaken challenges')
        expected_ids, expected_roots = spec.get('expected_request_ids', []), spec.get('expected_source_roots', [])
        require(expected_ids and len(expected_ids) == len(set(expected_ids)) and expected_roots
                and len(expected_roots) == len(set(expected_roots)), 'Invalid frozen inventory')
        require(type(spec.get('expected_bucket_counts')) is dict and all(type(n) is int and n > 0
                for n in spec['expected_bucket_counts'].values()), 'Invalid frozen bucket counts')
        if set(expected_ids) != ids: reasons.append('frozen_request_inventory')
        if set(expected_roots) != set(roots): reasons.append('frozen_source_inventory')
        if spec['expected_bucket_counts'] != dict(buckets): reasons.append('frozen_bucket_counts')
        if {r['split'] for r in inputs + references} != {spec.get('split')}: reasons.append('frozen_split')
        for name, values in [('inputs', inputs), ('references', references)]:
            if spec.get(name + '_sha256') != event.digest(sorted(values, key=lambda r: r['request_id'])):
                reasons.append('frozen_' + name + '_digest')
    return dict(verified=not reasons, failed=sorted(reasons), assigned=len(inputs), received=len(outputs),
                source_roots=len(roots), challenges=sorted(challenges), bucket_counts=dict(sorted(buckets.items())),
                source_variants_are_independent=False)


def _metrics(c):
    result = {name: event.metric(c[num], c[den]) for name, num, den in (
        ('normal_false_rejection', 'normal_rejected', 'normal_assigned'),
        ('normal_approval', 'normal_approved', 'normal_assigned'),
        ('normal_invalid', 'normal_invalid', 'normal_assigned'),
        ('bad_false_approval', 'bad_approved', 'bad_assigned'),
        ('bad_rejection', 'bad_rejected', 'bad_assigned'),
        ('bad_invalid', 'bad_invalid', 'bad_assigned'),
        ('bad_issues_exact', 'bad_issues_exact', 'bad_assigned'),
        ('time_error', 'time_errors', 'time_slots'))}
    result['invalid'] = event.metric(c['normal_invalid'] + c['bad_invalid'], c['normal_assigned'] + c['bad_assigned'])
    recalls = [result[n]['value'] for n in ('normal_approval', 'bad_rejection')]
    result['balanced_decision_recall'] = dict(value=sum(recalls) / 2 if None not in recalls else None)
    return result


def evaluate_rows(inputs, references, outputs, split='validation', baseline=None, coverage=None):
    """Preserve existing strict gates and add explicit error/coverage accounting."""
    if baseline is not None:
        paired.finite_tree(baseline)
        require(baseline.get('schema') == VERSION and baseline.get('split') == split,
                'Baseline wrapper version/split differs')
        require(baseline.get('coverage_spec_sha256') == (event.digest(coverage) if coverage is not None else None),
                'Baseline frozen coverage differs')
    report = paired.evaluate_rows(inputs, references, outputs, 'event', split,
                                  baseline['paired_report'] if baseline is not None else None)
    requests, gold, attributes = _inventory(inputs, references)
    received = event.index_rows(outputs, 'outputs'); records = {r['request_id']: r for r in report['base_report']['records']}
    counts = Counter(); by_root = defaultdict(Counter); by_challenge = defaultdict(Counter); by_bucket = defaultdict(Counter); decisions = []
    for identity, request in requests.items():
        ref = gold[identity]; record = records[identity]; a = attributes[identity]
        item = Counter()
        if request['task'] == 'event_state':
            facts = ref['target']['facts']; item['time_slots'] = len(facts)
            actual = {(f['person'], f['attribute']): f for f in event.strict_json(received[identity]['text'])['facts']} if record['eligible'] else {}
            item['time_errors'] = sum(actual.get((f['person'], f['attribute']), {}).get('time') != f['time'] for f in facts)
        else:
            normal = ref['target']['approved']; kind = 'normal' if normal else 'bad'; item[kind + '_assigned'] = 1
            approved = record.get('approved') if record['eligible'] else None
            item[kind + ('_invalid' if approved is None else '_approved' if approved else '_rejected')] = 1
            if not normal: item['bad_issues_exact'] = int(record['eligible'] and record.get('issues_exact', False))
            by_challenge[a['challenge']].update(item); by_bucket[a['bucket']].update(item)
            decisions.append(dict(request_id=identity, pair_id=request['pair_id'], root=a['root'],
                                  normal=normal, approved=approved))
        counts.update(item); by_root[a['root']].update(item)
    metrics = _metrics(counts); coverage_result = _coverage(inputs, references, outputs, attributes, gold, coverage)
    failed = list(report['gate']['failed_thresholds']); regressions = list(report['gate']['regressions'])
    for name, limit in LIMITS.items():
        if metrics[name]['value'] is None or metrics[name]['value'] > limit: failed.append(name)
    bucket_stats = {key: dict(counts=dict(c), metrics=_metrics(c)) for key, c in sorted(by_bucket.items())}
    for key, bucket in bucket_stats.items():
        for name, limit in BUCKET_LIMITS.items():
            value = bucket['metrics'][name]['value']
            if value is None or value > limit: failed.append('bucket/' + key + '/' + name)
        exact = bucket['metrics']['bad_issues_exact']['value']
        if exact is None or exact < BUCKET_EVIDENCE_MINIMUM: failed.append('bucket/' + key + '/bad_issues_exact')
    failed.extend('coverage/' + reason for reason in coverage_result['failed'])
    flips = Counter(); pair_flips = Counter(); changes = {}
    if baseline is not None:
        require(baseline['cohort_sha256'] == report['cohort_sha256'], 'Baseline cohort differs')
        previous = {r['request_id']: r for r in baseline['decision_records']}
        require(previous.keys() == {r['request_id'] for r in decisions}, 'Baseline decision inventory differs')
        for row in decisions:
            old = previous[row['request_id']]
            require(all(old[k] == row[k] for k in ('pair_id', 'root', 'normal')), 'Baseline decision identity differs')
            require(old['approved'] is None or type(old['approved']) is bool, 'Invalid baseline decision')
            label = lambda value: 'invalid' if value is None else 'approve' if value else 'reject'
            flips[('normal' if row['normal'] else 'bad') + '/' + label(old['approved']) + '->' + label(row['approved'])] += 1
        grouped = defaultdict(dict)
        for row in decisions: grouped[row['pair_id']][row['normal']] = row
        for values in grouped.values():
            ordered = [values[True], values[False]]
            before_profile = '/'.join(label(previous[row['request_id']]['approved']) for row in ordered)
            after_profile = '/'.join(label(row['approved']) for row in ordered)
            pair_flips[before_profile + '->' + after_profile] += 1
        for name in ('bad_false_approval', 'normal_false_rejection', 'normal_invalid', 'bad_invalid', 'time_error'):
            before = baseline['metrics'][name]; after = metrics[name]
            require(before['denominator'] == after['denominator'] and (before['value'] is None) == (after['value'] is None), 'Baseline denominator differs')
            if after['value'] is not None:
                delta = after['value'] - before['value']; changes[name] = dict(before=before['value'], after=after['value'], delta=delta)
                if delta > 0: regressions.append(name)
    if baseline is not None:
        require(type(baseline.get('bucket_stats')) is dict and baseline['bucket_stats'].keys() == bucket_stats.keys(), 'Baseline bucket inventory differs')
        for key, bucket in bucket_stats.items():
            for name in (*BUCKET_LIMITS, 'bad_issues_exact'):
                before = baseline['bucket_stats'][key]['metrics'][name]; after = bucket['metrics'][name]
                require(before['denominator'] == after['denominator'] and (before['value'] is None) == (after['value'] is None), 'Baseline bucket denominator differs')
                if after['value'] is not None:
                    delta = after['value'] - before['value']
                    metric = 'bucket/' + key + '/' + name
                    changes[metric] = dict(before=before['value'], after=after['value'], delta=delta)
                    worsened = delta < 0 if name == 'bad_issues_exact' else delta > 0
                    if worsened: regressions.append(metric)
    passed = not failed and not regressions
    validation_complete = split == 'validation' and coverage_result['verified']
    baseline_complete = bool(baseline is not None and baseline.get('coverage', {}).get('verified') is True
                             and baseline['coverage'].get('assigned') == len(inputs)
                             and baseline['coverage'].get('received') == len(inputs))
    verdict = 'regression_detected' if regressions else 'insufficient_joint_quality' if not passed else 'joint_research_gate_passed'
    root_metrics = {root: dict(counts=dict(c), metrics=_metrics(c)) for root, c in sorted(by_root.items())}
    macro = {}
    for name in ('normal_false_rejection', 'bad_false_approval', 'time_error'):
        values = [v['metrics'][name]['value'] for v in root_metrics.values() if v['metrics'][name]['value'] is not None]
        macro[name] = sum(values) / len(values) if values else None
    result = dict(schema=VERSION, domain='event', split=split, cohort_sha256=report['cohort_sha256'],
                  coverage_spec_sha256=event.digest(coverage) if coverage is not None else None,
                  counts=dict(counts), metrics=metrics, challenge_stats={k: dict(counts=dict(c), metrics=_metrics(c)) for k, c in sorted(by_challenge.items())},
                  bucket_stats=bucket_stats, source_stats=root_metrics, source_macro=dict(descriptive_only=True, unique_source_roots=len(root_metrics), metrics=macro),
                  decision_records=decisions, decision_flips=dict(sorted(flips.items())),
                  pair_decision_transitions=dict(order='normal/bad', counts=dict(sorted(pair_flips.items()))), descriptive_changes=changes,
                  coverage=coverage_result, paired_report=report, verdict=verdict,
                  gate=dict(passed=passed, failed_thresholds=sorted(set(failed)), regressions=sorted(set(regressions)),
                            maximum_error_rates=LIMITS, bucket_maximum_error_rates=BUCKET_LIMITS,
                            bucket_minimum_issues_exact=BUCKET_EVIDENCE_MINIMUM, existing_pair_gate_preserved=True, deployment_approved=False),
                  evaluation_complete_for_selection=validation_complete, baseline_verified_for_selection=baseline_complete,
                  checkpoint_selection_allowed=validation_complete and baseline_complete and passed,
                  selection_scope='event_validation_only', requires_separate_app_validation_gate=True,
                  model_selection_ready=False,
                  training_started=False, ready_for_deployment=False,
                  limits=['Only frozen full validation with a full-coverage baseline may select checkpoints; test/diagnostic never selects.',
                          'Invalid outputs are separate failures on fixed assigned denominators, not approvals or rejections.',
                          'Source variants are correlated; source macro metrics are descriptive, not confidence estimates.'])
    paired.finite_tree(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('command', choices=['score'])
    for name in ('inputs', 'references', 'outputs', 'report'): parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--domain', choices=['event'], default='event')
    parser.add_argument('--split', choices=['validation', 'test', 'diagnostic'], default='validation')
    parser.add_argument('--coverage', type=Path); parser.add_argument('--baseline-report', type=Path)
    args = parser.parse_args(); protected = [args.inputs, args.references, args.outputs, args.coverage, args.baseline_report]
    require(not args.report.exists() and not args.report.is_symlink() and args.report.resolve() not in {p.resolve() for p in protected if p}, 'Report would overwrite evidence')
    result = evaluate_rows(event.read_rows(args.inputs), event.read_rows(args.references), event.read_rows(args.outputs), args.split,
                           event.strict_json(args.baseline_report.read_text()) if args.baseline_report else None,
                           event.strict_json(args.coverage.read_text()) if args.coverage else None)
    with args.report.open('x') as handle: handle.write(event.canonical(result) + '\n')
    print(event.canonical(dict(report=str(args.report), verdict=result['verdict'], gate=result['gate'], checkpoint_selection_allowed=result['checkpoint_selection_allowed'])))
    return 0 if result['gate']['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
