#!/usr/bin/env python3
"""Counterfactual review pairs: approving normals alone is never improvement.

No models are invoked. Existing event/app schema and evidence scorers remain the
source of eligibility. Pair metadata is private evaluation data, never a prompt.
"""
import argparse
from collections import Counter, defaultdict
import math
from pathlib import Path

import evaluate_event_review as event
import local12b_app_review as app

VERSION = 'review-pair-evaluation-v1'
LOWER_IS_BETTER = {'normal_false_rejection', 'normal_invalid'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def finite_tree(value):
    if isinstance(value, float):
        require(math.isfinite(value), 'Nonfinite report/data value')
    elif isinstance(value, dict):
        for child in value.values():
            finite_tree(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            finite_tree(child)


def decision(task, target):
    value = target if task == 'event_review' else app.judge(task, target)
    require(type(value) is dict and type(value.get('approved')) is bool,
            'Reference/output lacks a boolean review decision')
    return value['approved']


def paired_inventory(inputs, references, outputs, domain, split):
    require(domain in ('event', 'app') and split in ('validation', 'test', 'diagnostic'),
            'Unsupported evaluation domain/split')
    requests = event.index_rows(inputs, 'inputs')
    gold = event.index_rows(references, 'references')
    received = event.index_rows(outputs, 'outputs')
    require(requests and requests.keys() == gold.keys() and received.keys() <= requests.keys(),
            'Input/reference/output inventory mismatch')
    tasks = ('event_state', 'event_review') if domain == 'event' else app.TASKS
    pairs = defaultdict(list)
    for identity, request in requests.items():
        ref = gold[identity]
        task = request.get('task')
        require(task in tasks and task == ref.get('task'), 'Pair task mismatch')
        roots = request.get('source_root_ids')
        require(type(roots) is list and roots and all(type(r) is str and r for r in roots)
                and len(set(roots)) == len(roots) and roots == ref.get('source_root_ids'),
                'Missing/mismatched pair source identity')
        require(request.get('split') == ref.get('split'), 'Input/reference split metadata mismatch')
        for row in (request, ref):
            require('split' not in row or split == 'diagnostic' or row['split'] == split,
                    'Pair split metadata mismatch')
        if task == 'event_state':
            require(not request.get('pair_id') and not ref.get('pair_id'), 'State row cannot masquerade as review pair')
            continue
        pair = request.get('pair_id')
        require(type(pair) is str and pair and pair == ref.get('pair_id'), 'Missing/mismatched pair identity')
        messages = request.get('messages')
        require(type(messages) is list and messages and all(type(m) is dict for m in messages),
                'Missing/malformed model messages')
        # No literal private pair ID may be supplied to the model in any message.
        require(all(type(m.get('content')) is str and pair not in m['content']
                    for m in messages), 'Pair identity leaked into model input')
        pairs[pair].append((identity, task, tuple(roots), decision(task, ref['target']), request.get('split')))
    require(pairs, 'No review counterfactual pairs')
    for pair, rows in pairs.items():
        require(len(rows) == 2 and len({r[1] for r in rows}) == 1
                and len({r[2] for r in rows}) == 1 and {r[3] for r in rows} == {False, True}
                and len({r[4] for r in rows}) == 1,
                'Each pair needs two same-task/source rows with opposite decisions: ' + pair)
    return requests, gold, received, pairs


def metric_value(metric):
    require(type(metric) is dict and 'value' in metric, 'Malformed metric')
    value = metric['value']
    require(value is None or (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1),
            'Invalid metric value')
    return value


def flatten_metrics(base, pair_metrics, domain, challenge_strata=None):
    result = {}
    if domain == 'event':
        for name, metric in base['metrics'].items():
            if name == 'predicted_issue_actual_grounding':
                continue  # Output-conditional denominator is diagnostic, never a fixed-cohort regression gate.
            result['event/' + name] = metric_value(metric)
        for field, bucket in base['negative_field_strata'].items():
            for name in ('rejection', 'issues_exact'):
                result['event/field_' + field + '/' + name] = metric_value(bucket[name])
    else:
        for task, metrics in base['metrics'].items():
            for name, metric in metrics.items():
                result[task + '/' + name] = metric_value(metric)
    for task, metrics in pair_metrics.items():
        for name, metric in metrics.items():
            result['pairs/' + task + '/' + name] = metric_value(metric)
    for challenge, bucket in (challenge_strata or {}).items():
        for name in ('rejection', 'issues_exact'):
            result['event/challenge_' + challenge + '/' + name] = metric_value(bucket[name])
    return result


def evaluate_rows(inputs, references, outputs, domain='event', split='validation', baseline=None):
    """Score fixed denominators and require both members of each pair to succeed."""
    finite_tree([inputs, references, outputs])
    requests, gold, received, pairs = paired_inventory(inputs, references, outputs, domain, split)
    cohort = event.digest(dict(domain=domain, split=split,
        inputs=sorted(inputs, key=lambda r: r['request_id']),
        references=sorted(references, key=lambda r: r['request_id'])))
    if baseline is not None:
        finite_tree(baseline)
        require(type(baseline) is dict and baseline.get('schema') == VERSION
                and baseline.get('domain') == domain and baseline.get('split') == split
                and baseline.get('cohort_sha256') == cohort, 'Baseline cohort/domain/split differs')
        require(type(baseline.get('base_report')) is dict and type(baseline.get('pair_metrics')) is dict,
                'Missing baseline scorer evidence')
    old_base = baseline['base_report'] if baseline is not None else None
    if domain == 'event':
        base = event.score_rows(inputs, references, outputs, baseline=old_base,
                                split=split if split != 'diagnostic' else 'validation')
    else:
        base = app.score_rows(inputs, references, outputs, baseline=old_base)
    records = {r['request_id']: r for r in base['records']}
    evaluated = {}
    decisions = defaultdict(Counter)
    for pair_rows in pairs.values():
        for identity, task, _, normal, _ in pair_rows:
            record = records[identity]
            valid = record['eligible'] if domain == 'event' else record['complete']
            approved = None
            if valid:
                value = event.strict_json(received[identity]['text'])
                approved = decision(task, value)
            exact = (bool(valid and (approved if normal else not approved))
                     and (True if domain == 'event' and normal else
                          bool(record.get('issues_exact')) if domain == 'event' else
                          bool(record['anchors_exact'] and record['grounded'])))
            evaluated[identity] = dict(valid=valid, correct=bool(valid and approved == normal), exact=exact)
            counts = decisions[task]
            counts['assigned'] += 1
            counts['valid'] += valid
            counts['approved'] += valid and approved
            counts['rejected'] += valid and not approved
    counts = defaultdict(Counter)
    pair_records = []
    for identity, rows in sorted(pairs.items()):
        task = rows[0][1]
        correct = all(evaluated[row[0]]['correct'] for row in rows)
        exact = all(evaluated[row[0]]['exact'] for row in rows)
        for key in (task, 'overall'):
            counts[key]['assigned'] += 1
            counts[key]['decision_correct'] += correct
            counts[key]['exact'] += exact
        pair_records.append(dict(pair_id=identity, task=task, source_root_ids=list(rows[0][2]),
                                 decision_correct=correct, evidence_exact=exact))
    pair_metrics = {task: dict(decision_success=event.metric(c['decision_correct'], c['assigned']),
                               evidence_exact=event.metric(c['exact'], c['assigned']))
                    for task, c in sorted(counts.items())}
    collapse = {task: dict(assigned=c['assigned'], eligible=c['valid'], approved=c['approved'],
                           rejected=c['rejected'], invalid=c['assigned']-c['valid'],
                           all_valid_approve=bool(c['valid'] and c['approved'] == c['valid']),
                           all_valid_reject=bool(c['valid'] and c['rejected'] == c['valid']),
                           complete_constant_decision=bool(c['valid'] == c['assigned'] and
                               (c['approved'] == c['assigned'] or c['rejected'] == c['assigned'])))
                for task, c in sorted(decisions.items())}
    challenge_counts = defaultdict(Counter)
    if domain == 'event':
        for identity, result in evaluated.items():
            ref = gold[identity]
            if not ref['target']['approved'] and ref.get('challenge') is not None:
                challenge = ref['challenge']
                require(type(challenge) is str and challenge, 'Invalid challenge metadata')
                bucket = challenge_counts[challenge]
                bucket['assigned'] += 1
                bucket['rejected'] += result['correct']
                bucket['exact'] += result['exact']
    challenge_strata = {name:dict(assigned=c['assigned'],
        rejection=event.metric(c['rejected'], c['assigned']),
        issues_exact=event.metric(c['exact'], c['assigned'])) for name,c in sorted(challenge_counts.items())}
    root_groups = defaultdict(list)
    for pair in pair_records:
        root_groups[tuple(pair['source_root_ids'])].append(pair)
    root_summary = dict(unique_source_roots=len({root for group in root_groups for root in group}),
        root_groups=len(root_groups), pair_count=len(pair_records), descriptive_only=True,
        macro_pair_decision_success=sum(sum(p['decision_correct'] for p in ps)/len(ps)
            for ps in root_groups.values())/len(root_groups),
        macro_pair_evidence_exact=sum(sum(p['evidence_exact'] for p in ps)/len(ps)
            for ps in root_groups.values())/len(root_groups))
    flat = flatten_metrics(base, pair_metrics, domain, challenge_strata)
    failed = list(base['gate'].get('failed_thresholds', base['gate'].get('failed', [])))
    for task, metrics in pair_metrics.items():
        for name, metric in metrics.items():
            if metric['value'] is None or metric['value'] < .95:
                failed.append('pairs/' + task + '/' + name)
    if domain == 'event':
        for field, bucket in base['negative_field_strata'].items():
            if bucket['assigned']:
                for name in ('rejection', 'issues_exact'):
                    if bucket[name]['value'] is None or bucket[name]['value'] < .95:
                        failed.append('event/field_' + field + '/' + name)
        for challenge, bucket in challenge_strata.items():
            for name in ('rejection', 'issues_exact'):
                if bucket[name]['value'] is None or bucket[name]['value'] < .95:
                    failed.append('event/challenge_' + challenge + '/' + name)
    regressions = list(base['gate']['regressions'])
    changes = {}
    if baseline is not None:
        old_flat = flatten_metrics(baseline['base_report'], baseline['pair_metrics'], domain,
                                   baseline.get('challenge_strata'))
        require(old_flat.keys() == flat.keys(), 'Baseline metric inventory differs')
        for name, current in flat.items():
            previous = old_flat[name]
            require((current is None) == (previous is None), 'Baseline metric denominator changed')
            if current is None:
                continue
            delta = current-previous
            changes[name] = dict(before=previous, after=current, delta=delta)
            lower = name.rsplit('/', 1)[-1] in LOWER_IS_BETTER
            if (delta > 0 if lower else delta < 0):
                regressions.append(name)
    failures, regressions = sorted(set(failed)), sorted(set(regressions))
    passed = not failures and not regressions
    any_improvement = any((v['delta'] < 0 if k.rsplit('/', 1)[-1] in LOWER_IS_BETTER else v['delta'] > 0)
                          for k, v in changes.items())
    if regressions:
        verdict = 'regression_detected'
    elif not passed:
        verdict = 'insufficient_joint_quality'
    elif baseline is not None and any_improvement:
        verdict = 'joint_research_gate_passed_with_improvement'
    else:
        verdict = 'joint_research_gate_passed'
    report = dict(schema=VERSION, domain=domain, split=split, cohort_sha256=cohort,
        base_report=base, pair_metrics=pair_metrics, pair_records=pair_records, collapse=collapse,
        challenge_strata=challenge_strata, root_summary=root_summary,
        descriptive_changes=changes, verdict=verdict,
        gate=dict(passed=passed, failed_thresholds=failures, regressions=regressions,
                  pair_threshold=.95, research_only=True, deployment_approved=False),
        limitations=['Marginal approval or time gains do not override any critical regression.',
                    'Pair/representation variants sharing a source are not independent samples.',
                    'Event is symbolic; app is reused development validation, not independent product validation.'])
    finite_tree(report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['score'])
    for name in ('inputs', 'references', 'outputs', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--domain', choices=['event', 'app'], required=True)
    parser.add_argument('--split', choices=['validation', 'test', 'diagnostic'], default='validation')
    parser.add_argument('--baseline-report', type=Path)
    args = parser.parse_args()
    protected = [args.inputs, args.references, args.outputs]
    if args.baseline_report:
        protected.append(args.baseline_report)
    require(not args.report.exists() and not args.report.is_symlink()
            and args.report.resolve() not in {p.resolve() for p in protected}, 'Report would overwrite source evidence')
    baseline = event.strict_json(args.baseline_report.read_text()) if args.baseline_report else None
    result = evaluate_rows(event.read_rows(args.inputs), event.read_rows(args.references),
                           event.read_rows(args.outputs), args.domain, args.split, baseline)
    with args.report.open('x') as handle:
        handle.write(event.canonical(result)+'\n')
    print(event.canonical(dict(report=str(args.report), verdict=result['verdict'], gate=result['gate'])))
    return 0 if result['gate']['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
