#!/usr/bin/env python3
"""12B-only state contract diagnostics layered over the unchanged strict v2 gates."""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from pathlib import Path

import local12b_repair_evaluation as legacy

event = legacy.event
require = legacy.require
make_coverage = legacy.make_coverage
VERSION = 'local12b-state-evaluation-v1'
STATE_LIMITS = {'state_invalid_rate': 0.0, 'duplicate_slot_rate': 0.0}


def state_reasons(value):
    """Diagnose violations without repairing, coercing or deduplicating output."""
    reasons = set()
    if type(value) is not dict or set(value) != {'facts'} or type(value.get('facts')) is not list:
        return {'root_structure'}
    keys = []
    for fact in value['facts']:
        if type(fact) is not dict:
            reasons.add('fact_not_object'); continue
        if set(fact) != set(event.FIELDS): reasons.add('fact_keys')
        if all(type(fact.get(k)) is str for k in ('person', 'attribute')):
            keys.append((fact['person'], fact['attribute']))
        for key in event.FIELDS:
            if type(fact.get(key)) is not str or not fact[key]: reasons.add(key + '_type_or_empty')
        if fact.get('negated') not in ('true', 'false'): reasons.add('negated_enum')
        if fact.get('certainty') not in ('reported', 'unknown'): reasons.add('certainty_enum')
    if len(set(keys)) != len(keys): reasons.add('duplicate_person_attribute_slot')
    return reasons


def _state_metrics(counts):
    return {name: event.metric(counts[num], counts[den]) for name, num, den in (
        ('state_invalid_rate', 'invalid_states', 'assigned_states'),
        ('duplicate_slot_rate', 'duplicate_states', 'assigned_states'),
        ('time_error', 'time_errors', 'gold_slots'),
        ('invalid_state_time_penalty', 'invalid_time_slots', 'gold_slots'),
        ('eligible_time_error', 'eligible_time_errors', 'eligible_gold_slots'))}


def evaluate_rows(inputs, references, outputs, split='validation', baseline=None, coverage=None):
    """Same call contract as v2; only this new report version can be a baseline."""
    if baseline is not None:
        require(baseline.get('schema') == VERSION, 'Baseline must use new state evaluator schema; v2 reports require rescoring')
        require(baseline.get('split') == split, 'Baseline split differs')
        require(type(baseline.get('legacy_report')) is dict and type(baseline.get('state_records')) is list,
                'Baseline lacks full state accounting')
    base = legacy.evaluate_rows(inputs, references, outputs, split,
                                baseline['legacy_report'] if baseline else None, coverage)
    requests, gold, attributes = legacy._inventory(inputs, references)
    output_map = event.index_rows(outputs, 'outputs')
    original = {r['request_id']: r for r in base['paired_report']['base_report']['records']}
    counts = Counter(); roots = defaultdict(Counter); encodings = defaultdict(Counter)
    reason_counts = Counter(); records = []
    for identity, req in requests.items():
        if req['task'] != 'event_state': continue
        rec = original[identity]; expected = gold[identity]['target']['facts']; output = output_map.get(identity)
        value = None
        if output and type(output.get('text')) is str:
            try: value = event.strict_json(output['text'])
            except (ValueError, TypeError): pass
        reasons = state_reasons(value) if value is not None else set()
        if not rec['eligible']: reasons.add(rec['status'])
        # A future base change may not silently weaken this independent contract.
        eligible = rec['eligible'] and not reasons
        actual = {(f['person'], f['attribute']): f for f in value['facts']} if eligible else {}
        errors = [actual.get((f['person'], f['attribute']), {}).get('time') != f['time'] for f in expected]
        c = Counter(assigned_states=1, invalid_states=int(not eligible), gold_slots=len(expected),
                    duplicate_states=int('duplicate_person_attribute_slot' in reasons),
                    time_errors=sum(errors), invalid_time_slots=0 if eligible else len(expected),
                    eligible_time_errors=sum(errors) if eligible else 0,
                    eligible_gold_slots=len(expected) if eligible else 0)
        counts.update(c); roots[attributes[identity]['root']].update(c); encodings[attributes[identity]['encoding']].update(c)
        reason_counts.update(reasons)
        records.append(dict(request_id=identity, root=attributes[identity]['root'], encoding=attributes[identity]['encoding'],
                            eligible=eligible, gold_slots=len(expected), time_slot_errors=errors,
                            invalid_reasons=sorted(reasons)))
    metrics = _state_metrics(counts)
    require(metrics['time_error']['denominator'] == base['metrics']['time_error']['denominator']
            and metrics['time_error']['numerator'] >= base['metrics']['time_error']['numerator'],
            'New state contract may only strengthen preserved full-denominator accounting')
    failed = list(base['gate']['failed_thresholds']); regressions = list(base['gate']['regressions'])
    for name, limit in STATE_LIMITS.items():
        if metrics[name]['value'] is None or metrics[name]['value'] > limit: failed.append(name)
    changes = {}; matched = None
    if baseline is not None:
        require(baseline.get('cohort_sha256') == base['cohort_sha256'], 'State baseline cohort differs')
        prior = event.index_rows(baseline['state_records'], 'baseline state records')
        require(prior.keys() == {r['request_id'] for r in records}, 'Baseline state inventory differs')
        matched_count = before_errors = after_errors = 0
        for rec in records:
            old = prior[rec['request_id']]
            require(all(old.get(k) == rec[k] for k in ('root', 'encoding', 'gold_slots')), 'Baseline state identity differs')
            require(type(old.get('eligible')) is bool and type(old.get('time_slot_errors')) is list
                    and len(old['time_slot_errors']) == rec['gold_slots']
                    and all(type(v) is bool for v in old['time_slot_errors']), 'Invalid baseline state accounting')
            if old['eligible'] and rec['eligible']:
                matched_count += rec['gold_slots']; before_errors += sum(old['time_slot_errors']); after_errors += sum(rec['time_slot_errors'])
        matched = dict(before=event.metric(before_errors, matched_count), after=event.metric(after_errors, matched_count),
                       descriptive_only=True, post_selection_subset=True,
                       warning='Both-valid subset depends on model outputs; never substitutes for fixed-denominator gate')
        for name in STATE_LIMITS:
            old = baseline['state_metrics'][name]; current = metrics[name]
            require(old['denominator'] == current['denominator'], 'State baseline denominator differs')
            if old['value'] is not None and current['value'] is not None:
                delta = current['value'] - old['value']; changes[name] = dict(before=old['value'], after=current['value'], delta=delta)
                if delta > 0: regressions.append(name)
    passed = not failed and not regressions
    result = deepcopy(base)
    result.update(schema=VERSION, legacy_report=base, state_counts=dict(counts), state_metrics=metrics,
                  state_invalid_reasons=dict(sorted(reason_counts.items())), state_records=records,
                  state_by_encoding={k:dict(counts=dict(c), metrics=_state_metrics(c)) for k,c in sorted(encodings.items())},
                  state_by_source={k:dict(counts=dict(c), metrics=_state_metrics(c)) for k,c in sorted(roots.items())},
                  state_source_count=len(roots), state_metric_changes=changes, matched_valid_time=matched,
                  additional_enum_contract_time_penalties=metrics['time_error']['numerator']-base['metrics']['time_error']['numerator'],
                  flag_direction_stats={k:v for k,v in base['bucket_stats'].items() if k.split('|')[0] in legacy.DIRECTIONS},
                  state_metric_definitions=dict(duplicate_slot_rate='Outputs containing duplicate person/attribute slots / all assigned state outputs',
                    eligible_time_error='Wrong or missing time slots / gold slots of eligible state outputs; conditional denominator changes between models',
                    invalid_state_time_penalty='All gold slots belonging to invalid state outputs / all assigned gold slots'),
                  verdict='regression_detected' if regressions else 'insufficient_joint_quality' if not passed else 'joint_research_gate_passed',
                  checkpoint_selection_allowed=base['checkpoint_selection_allowed'] and passed,
                  requires_separate_app_generation_gate=True, model_selection_ready=False, ready_for_deployment=False)
    result['gate'].update(passed=passed, failed_thresholds=sorted(set(failed)), regressions=sorted(set(regressions)),
                          maximum_state_error_rates=STATE_LIMITS, flag_direction_gate_preserved=True)
    result['limits'] += ['State diagnostic source variants are correlated; source counts are not independent trial counts.',
                         'Conditional eligible-time and matched-valid rates cannot replace fixed assigned denominators.',
                         'Full app generation validation is additionally required; passing this event gate is not deployment approval.']
    legacy.paired.finite_tree(result)
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('command', choices=['score'])
    for name in ('inputs','references','outputs','report'): p.add_argument('--'+name, type=Path, required=True)
    p.add_argument('--split', choices=['validation','test','diagnostic'], default='validation')
    p.add_argument('--coverage', type=Path); p.add_argument('--baseline-report', type=Path)
    a = p.parse_args(); protected = [a.inputs,a.references,a.outputs,a.coverage,a.baseline_report]
    require(not a.report.exists() and not a.report.is_symlink() and a.report.resolve() not in {x.resolve() for x in protected if x}, 'Report would overwrite evidence')
    report = evaluate_rows(event.read_rows(a.inputs),event.read_rows(a.references),event.read_rows(a.outputs),a.split,
        event.strict_json(a.baseline_report.read_text()) if a.baseline_report else None,
        event.strict_json(a.coverage.read_text()) if a.coverage else None)
    with a.report.open('x') as f: f.write(event.canonical(report)+'\n')
    print(event.canonical(dict(schema=VERSION,report=str(a.report),verdict=report['verdict'],gate=report['gate'],checkpoint_selection_allowed=report['checkpoint_selection_allowed'])))
    return 0 if report['gate']['passed'] else 2

if __name__ == '__main__': raise SystemExit(main())
