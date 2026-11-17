#!/usr/bin/env python3
"""Independent declared-fact and symbolic oracles; not a clinical/NLI judge.

This module does not import either curriculum generator or its oracle.
Natural-language sampled reading is a separate, hash-bound agent receipt.
"""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

FIELDS = ('person', 'attribute', 'value', 'time', 'negated', 'certainty')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def memory_row(row, case):
    """Judge polarity/claim verdict from source labels and visible candidate alone."""
    stage = row['review_metadata']['stage']
    payload = json.loads(row['messages'][1]['content'])
    target = json.loads(row['messages'][-1]['content'])['state']
    review = payload['data']['review_target']
    source = review['input']['reported_dialogue']
    require(source == [dict(turn=i, role='user', content=case['turn'+str(i)])
                       for i in range(1, stage+1)], 'Future/missing dialogue')
    active = case['facts'] if stage == 2 else [f for f in case['facts']+case['superseded'] if f['turn']==1]
    active_set = {(f['subject'], f['quote']) for f in active}
    known = {f['quote'] for f in active}
    for fact in case['facts']+case['superseded']:
        require(fact['quote'] in case['turn'+str(fact['turn'])], 'Annotated quote absent from source')
    expected = {}
    for claim in review['claims']:
        if claim['kind'] == 'unresolved_information':
            scope = claim['claim']
            if scope.startswith('확인되지 않은 정보: “') and scope.endswith('”'):
                scope = scope[len('확인되지 않은 정보: “'):-1]
            if stage==2 and scope in case['unknowns']:
                verdict = 'still_unknown'
            elif scope in known:
                verdict = 'already_answered'
            else:
                raise ValueError('Unknown-scope semantics needs independent judgment')
        else:
            require(claim['kind']=='reported_excerpt', 'Unexpected claim class')
            group = claim['id'].split('.')[0]
            evidence = claim['evidence']
            cited = [e['quote'] for e in evidence]
            quoted = re.findall('“([^”]+)”', claim['claim'])
            # A supported reported excerpt must preserve exact quotes, role and
            # currently supported source spans; a true quote with a wrong role fails.
            supported = (bool(evidence) and cited==quoted and all(e['subject']==group
                and (e['subject'], e['quote']) in active_set for e in evidence))
            verdict = 'supported' if supported else 'unsupported'
        require(claim['id'] not in expected, 'Duplicate candidate claim')
        expected[claim['id']] = verdict
    actual = {a['id']:a['verdict'] for a in target['audits']}
    require(len(actual)==len(target['audits']) and actual==expected, 'Independent claim verdict mismatch')
    approve = all(v in ('supported','still_unknown') for v in expected.values())
    require(type(target['approved']) is bool and target['approved']==approve, 'Independent approval mismatch')
    require(bool(target['issues']) == (not approve), 'Issue/polarity mismatch')
    # This fixture has exactly one changed claim per negative, checked without
    # consulting the generator's failed_claim_id or error_type metadata.
    failing = [key for key,value in expected.items() if value not in ('supported','still_unknown')]
    require(len(failing)==(0 if approve else 1), 'Unexpected perturbation cardinality')
    return dict(row_id=row['row_id'], row_sha256=digest(row), independently_computed_approved=approve,
                failed_claim_ids=failing, status='passed')


def event_target(request):
    payload = json.loads(request['messages'][-1]['content']); data=payload['data']
    events=[]
    for raw in data['events']:
        event = dict(raw) if type(raw) is dict else dict(zip(('time','person','attribute','value','negated','certainty'),raw.split('|')))
        require(set(event)==set(FIELDS) and all(type(v) is str for v in event.values()), 'Bad event')
        events.append(event)
    require(all(int(a['time'])<int(b['time']) for a,b in zip(events,events[1:])), 'Nonmonotone time')
    keys={(x['person'],x['attribute']) for x in events}
    latest=[max((x for x in events if (x['person'],x['attribute'])==key),key=lambda x:int(x['time'])) for key in sorted(keys)]
    if request['task']=='event_state':
        return dict(facts=latest)
    draft=data['draft']
    gold_counts=Counter(canonical(x) for x in latest)
    if Counter(canonical(x) for x in draft)==gold_counts:
        return dict(approved=True,issues=[])
    # Search a one-field edit that makes the whole draft multiset equal to gold.
    # Unlike the generator, this does not use the recorded changed slot/field.
    candidates=[]
    for index,fact in enumerate(draft):
        for expected in latest:
            difference=[key for key in FIELDS if fact[key]!=expected[key]]
            if len(difference)!=1:continue
            candidate=deepcopy(draft);candidate[index]=expected
            if Counter(canonical(x) for x in candidate)==gold_counts:
                field=difference[0]
                candidates.append(dict(index=index,field=field,actual=fact[field],expected=expected[field],rule='latest_supported_tuple'))
    require(len(candidates)==1,'Ambiguous/non-single-field semantic edit')
    return dict(approved=False,issues=candidates)


def check_memory(bundle):
    bundle=Path(bundle)
    cases={r['case_id']:r for r in rows(bundle/'provenance/source_cases.jsonl')}
    records=[]; failures=[]
    for split in ('train','validation'):
        for row in rows(bundle/f'data/{split}.jsonl'):
            if row['task']!='memory_review':continue
            try:records.append(memory_row(row,cases[row['review_metadata']['source_case_id']]))
            except (ValueError,KeyError,TypeError) as error:failures.append(dict(row_id=row['row_id'],error=str(error)))
    return dict(status='passed' if not failures else 'failed',checked_rows=len(records)+len(failures),
                records=records,failures=failures,
                scope='source_annotation_and_candidate_semantic_predicates_not_full_free_prose_entailment')


def check_events(bundle):
    bundle=Path(bundle);records=[];failures=[];counts=Counter()
    for split in ('train','validation','test'):
        inputs=rows(bundle/f'evaluation/{split}/inputs.jsonl')
        refs={r['request_id']:r for r in rows(bundle/f'evaluation/{split}/references.jsonl')}
        for request in inputs:
            try:
                expected=event_target(request)
                require(expected==refs[request['request_id']]['target'],'Independent event target mismatch')
                records.append(dict(row_id=request['request_id'],input_sha256=digest(request),
                    reference_sha256=digest(refs[request['request_id']]),status='passed',split=split))
                counts[split+'/'+request['task']]+=1
            except (ValueError,KeyError,TypeError) as error:failures.append(dict(row_id=request['request_id'],error=str(error)))
    return dict(status='passed' if not failures else 'failed',checked_rows=len(records)+len(failures),
                records=records,failures=failures,counts=dict(counts),
                scope='exhaustive_symbolic_contract_semantics_not_natural_dialogue')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind',choices=['memory','event']);parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True);args=parser.parse_args()
    report=check_memory(args.bundle) if args.kind=='memory' else check_events(args.bundle)
    require(not args.report.resolve().is_relative_to(args.bundle.resolve()),'Report must be outside frozen bundle')
    with args.report.open('x') as handle:json.dump(report,handle,ensure_ascii=False,indent=2)
    print(json.dumps({k:v for k,v in report.items() if k!='records'},ensure_ascii=False))
    return 0 if report['status']=='passed' else 2


if __name__=='__main__':raise SystemExit(main())
