#!/usr/bin/env python3
"""Separate 12B event curriculum and targeted gates; never modify a 31B artifact."""
import argparse
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import random
import shutil
from datetime import date, timedelta

import event_review_curriculum as c
import evaluate_event_review as e

VERSION = 'local12b-event-review-v2'
TIME_MODES = ('value_as_time', 'person_as_time', 'none_as_time', 'stale_same_value_time')


def source(seed, number):
    events, _ = c.make_source(seed, number)
    rng=random.Random(f'{VERSION}:{seed}:{number}')
    keys=sorted({(f['person'],f['attribute']) for f in events})
    key = rng.choice(keys)
    last = int(events[-1]['time'])
    first=date(2027,1,1)+timedelta(days=rng.randrange(1400))
    later=first+timedelta(days=rng.randrange(1,60))
    previous, current_value=first.isoformat()+' 오전',later.isoformat()+' 오후'
    for offset, value in ((7, previous), (19, current_value), (33, current_value)):
        events.append(dict(person=key[0], attribute=key[1], value=value, time=str(last+offset),
                           negated='false', certainty='reported'))
    # The latest fact for the selected slot is often NOT the globally last event.
    others=rng.sample([k for k in keys if k!=key],rng.randrange(5))
    for index,other in enumerate(others):
        events.append(dict(person=other[0],attribute=other[1],value=rng.choice(c.VALUES),
            time=str(last+47+index*11),negated='false',certainty='reported'))
    # Forward construction is checked with the independent reverse-scan oracle.
    current = {}
    for fact in events:
        current[fact['person'], fact['attribute']] = fact
    return events, [current[k] for k in sorted(current)]


def repeated_pair(events):
    pairs=[(a,b) for a,b in zip(events,events[1:])
           if all(a[f]==b[f] for f in c.FIELDS if f!='time')]
    e.require(bool(pairs),'Missing same-value repeat')
    return pairs[-1]


def projections(events, facts, root_id, split, ordinal, seed):
    time_case = ordinal % 2 == 0
    field = 'time' if time_case else tuple(f for f in c.FIELDS if f != 'time')[(ordinal//2) % 5]
    mode = TIME_MODES[(ordinal//2) % 4] if time_case else 'field_'+field
    rows = c.project(events, facts, root_id, split, field, seed)
    for request, ref, train in rows:
        payload = json.loads(request['messages'][-1]['content'])
        if ref['changed_field'] == 'time':
            # Select the deliberately repeated latest value, not an arbitrary slot.
            normal = next(json.loads(x[0]['messages'][-1]['content'])['data']['draft'] for x in rows
                          if x[1]['target'].get('approved') is True)
            draft = deepcopy(normal)
            prior,latest=repeated_pair(events)
            index = next(i for i, f in enumerate(draft) if (f['person'], f['attribute']) ==
                         (latest['person'], latest['attribute']))
            correct = draft[index]['time']
            wrong = {'value_as_time': draft[index]['value'], 'person_as_time': draft[index]['person'],
                     'none_as_time': 'none', 'stale_same_value_time': prior['time']}[mode]
            draft[index]['time'] = wrong
            payload['data']['draft'] = draft
            ref['target'] = dict(approved=False, issues=[dict(index=index, field='time',
                expected=correct, actual=wrong, rule='latest_supported_tuple')])
        request['messages'][-1]['content'] = c.canonical(payload)
        request['request_id'] = c.digest([VERSION, root_id, train['variant']])[:24]
        ref.update(request_id=request['request_id'], challenge=mode)
        train.update(row_id=request['request_id'], challenge=mode,
            messages=deepcopy(request['messages'])+[dict(role='assistant', content=c.canonical(ref['target']))],
            target_sha256=c.d.digest(c.canonical(ref['target'])))
    return rows


def verify(bundle):
    root = Path(bundle).resolve(strict=True)
    manifest = e.strict_json((root/'MANIFEST.json').read_text())
    e.require(manifest['schema'] == VERSION and manifest['files'] == c.inventory(root), 'Bundle hash/version mismatch')
    course = e.strict_json((root/'COURSE_PROPOSAL.json').read_text())
    e.require(set(course['data']) == {'train','validation'} and not course['training_ready']
              and not course['training_started'], 'Training admission/test leakage')
    source_rows = c.read_rows(root/'sources.jsonl')
    sources = {r['source_root_id']: r for r in source_rows}
    e.require(len(sources) == len(source_rows), 'Duplicate root')
    seen, groups, structures, prompts, stats = set(), {}, {}, {}, {}
    for split in c.SPLITS:
        inputs = c.read_rows(root/f'evaluation/{split}/inputs.jsonl')
        refs = c.read_rows(root/f'evaluation/{split}/references.jsonl')
        training = c.read_rows(root/course['data'][split]['path']) if split != 'test' else []
        e.require(len(inputs) == len(refs) and (split == 'test' or len(training) == len(inputs)), 'Inventory mismatch')
        groups[split], structures[split], prompts[split] = set(), set(), set()
        pairs, counts = {}, Counter()
        for index, (req, ref) in enumerate(zip(inputs, refs)):
            rid = req['request_id']; lineage = req['source_root_ids'][0]
            e.require(rid not in seen and rid == ref['request_id'], 'Duplicate/mismatched request')
            seen.add(rid)
            src = sources[lineage]
            e.require(src['split'] == split and ref['source_root_ids'] == [lineage], 'Split/lineage mismatch')
            payload = e.strict_json(req['messages'][-1]['content'])
            data = payload['data']; facts = c.parse_events(data)
            encoded = data['events'] if isinstance(data['events'][0],dict) else [
                dict(zip(('time','person','attribute','value','negated','certainty'), x.split('|'))) for x in data['events']]
            e.require(encoded == src['events'], 'Source binding mismatch')
            e.require(c.structure_fingerprint(encoded) == src['structure_sha256'], 'Structure mismatch')
            e.require(lineage == VERSION+':'+c.digest(encoded)[:24], 'Root identity mismatch')
            e.require(c.SPLITS[int(src['structure_sha256'][:8],16)%3] == split, 'Reassigned structure split')
            e.require(req['task'] == ref['task'] and payload['output_schema'] == c.schema(req['task']), 'Task/schema mismatch')
            target = dict(facts=facts) if req['task']=='event_state' else c.review_target(data)
            e.require(target == ref['target'], 'Independent semantic oracle mismatch')
            expected_rows = projections(encoded, facts, lineage, split, src['ordinal'], manifest['seed'])
            expected = next(x for x in expected_rows if x[0]['request_id'] == rid)
            e.require((req,ref) == expected[:2], 'Prompt/challenge projection drift')
            if split != 'test':
                c.d.check_row(training[index])
                e.require(training[index] == expected[2], 'Training/mask/target mismatch')
            variant = expected[2]['variant']
            pairs.setdefault(lineage,Counter())[variant] += 1
            prompt = c.digest(req['messages'])
            e.require(prompt not in prompts[split], 'Duplicate prompt')
            prompts[split].add(prompt); groups[split].add(lineage); structures[split].add(src['structure_sha256'])
            counts[variant.split(':')[1]] += 1
            if variant.endswith(':error'): counts[ref['challenge']] += 1
        e.require(len(inputs) == manifest['root_counts'][split]*6, 'Wrong row count')
        if split != 'test': e.require(course['data'][split]['rows']==len(training),'Course count mismatch')
        expected_pairs = Counter({f'{encoding}:{kind}':1 for encoding in ('pipe','object') for kind in ('state','normal','error')})
        e.require(len(groups[split]) == len(structures[split]) == manifest['root_counts'][split]
                  and all(x==expected_pairs for x in pairs.values()), 'Pair/root coverage failure')
        e.require(counts['normal']==counts['error'] and all(counts[m] == len(groups[split])//4 for m in TIME_MODES), 'Time/normal balance failure')
        e.require(all(counts['field_'+f] == len(groups[split])//5 for f in c.FIELDS if f!='time'), 'Other-field coverage failure')
        stats[split] = dict(rows=len(inputs), roots=len(groups[split]), counts=dict(counts))
    for a,b in (('train','validation'),('train','test'),('validation','test')):
        e.require(not(groups[a]&groups[b] or structures[a]&structures[b] or prompts[a]&prompts[b]), 'Split leakage')
    e.require(set(sources)==set.union(*groups.values()), 'Orphan source')
    return dict(status='passed', partitions=stats, cross_split_collisions=0, training_ready=False,
                scope='symbolic_12b_diagnostic_not_production_app_contract')


def build(output, seed=12122026, counts=None):
    output=Path(output).absolute(); counts=counts or dict(train=120,validation=40,test=40)
    e.require(set(counts)==set(c.SPLITS) and all(type(n)is int and n>0 and n%40==0 for n in counts.values()), 'Counts must be multiples of 40')
    e.require(not output.exists() and output.parent.resolve()==output.parent and output.parent.name=='training_data', 'Use fresh training_data directory')
    rows={s:[] for s in c.SPLITS}; filled=Counter(); sources=[]; fingerprints=set(); number=0
    while any(filled[s]<counts[s] for s in c.SPLITS):
        events,facts=source(seed,number); number+=1; fingerprint=c.structure_fingerprint(events)
        split=c.SPLITS[int(fingerprint[:8],16)%3]
        if fingerprint in fingerprints or filled[split]>=counts[split]: continue
        fingerprints.add(fingerprint); lineage=VERSION+':'+c.digest(events)[:24]
        sources.append(dict(source_root_id=lineage,split=split,events=events,structure_sha256=fingerprint,ordinal=filled[split]))
        rows[split].extend(projections(events,facts,lineage,split,filled[split],seed)); filled[split]+=1
    output.mkdir(mode=0o700); (output/'scripts').mkdir()
    for module in (Path(__file__),Path(c.__file__),Path(e.__file__),Path(c.d.__file__)):
        shutil.copyfile(module,output/'scripts'/module.name)
    c.write_rows(output/'sources.jsonl',sources); parts={}
    for split in c.SPLITS:
        c.write_rows(output/f'evaluation/{split}/inputs.jsonl',[r[0] for r in rows[split]])
        c.write_rows(output/f'evaluation/{split}/references.jsonl',[r[1] for r in rows[split]])
        if split!='test':
            path=f'data/{split}.jsonl'; c.write_rows(output/path,[r[2] for r in rows[split]])
            parts[split]=dict(path=path,rows=len(rows[split]))
    c.d.save(output/'COURSE_PROPOSAL.json',dict(schema=VERSION,target_family='12B',data=parts,
        training_ready=False,training_started=False,tokenization='pending_exact_12b_tokenizer_and_numeric_audit',
        loss='last_assistant_only',role_scope='symbolic_supplement_not_actual_app_contract',
        admission_requirements=['pinned intended 12B tokenizer and template','numeric mask audit','explicit training request'],
        test_policy='reserved_for_final_frozen_candidate_not_gradient_or_checkpoint_selection'))
    c.d.save(output/'MANIFEST.json',dict(schema=VERSION,seed=seed,root_counts=counts,files=c.inventory(output),
        same_generator_generalization_unproven=True,existing_31b_artifacts_modified=False))
    report=verify(output); c.d.save(output/'VERIFICATION.json',report); return report


def evaluate(bundle, outputs, split='validation', baseline=None):
    proof=verify(bundle); root=Path(bundle)/'evaluation'/split
    inputs=c.read_rows(root/'inputs.jsonl'); refs=c.read_rows(root/'references.jsonl')
    report=e.score_rows(inputs,refs,outputs,split=split)
    reference={r['request_id']:r for r in refs}; categories={k:Counter() for k in TIME_MODES}
    for row in report['records']:
        ref=reference[row['request_id']]
        if ref['changed_field']=='time':
            group=categories[ref['challenge']]; group['assigned']+=1; group['exact']+=row.get('issues_exact',False)
    report['time_error_strata']={k:e.metric(v['exact'],v['assigned']) for k,v in categories.items()}
    failures=[k for k,m in report['time_error_strata'].items() if m['value'] is None or m['value']<.95]
    report['gate']['failed_thresholds'] += ['time_error:'+k for k in failures]
    if baseline is not None:
        e.require(baseline.get('local12b_schema')==VERSION and baseline['cohort_sha256']==report['cohort_sha256']
                  and baseline['split']==split, 'Baseline cohort/version differs')
        for key in report['gate']['thresholds']:
            before=baseline['metrics'][key]['value']; after=report['metrics'][key]['value']
            e.require(type(before) in (int,float) and 0<=before<=1,'Invalid baseline metric')
            if after is None or after<before: report['gate']['regressions'].append(key)
        for key,metric in report['time_error_strata'].items():
            before=baseline['time_error_strata'][key]['value']
            e.require(type(before) in (int,float) and 0<=before<=1,'Invalid baseline time stratum')
            if metric['value'] is None or metric['value']<before:report['gate']['regressions'].append('time_error:'+key)
    report['gate']['passed']=not report['gate']['failed_thresholds'] and not report['gate']['regressions']
    report.update(local12b_schema=VERSION,bundle_verification=proof)
    return report


def controls(bundle):
    """Evaluator fixtures only; never counted as model inference or quality evidence."""
    refs=c.read_rows(Path(bundle)/'evaluation/validation/references.jsonl')
    inputs=c.read_rows(Path(bundle)/'evaluation/validation/inputs.jsonl')
    example_issue=next(r['target'] for r in refs if r['target'].get('approved') is False)
    reports={}
    for name in ('perfect_reference','always_reject','always_approve','time_copies_value',
                 'time_copies_person','time_none','time_stale_same_value','hallucinated_actual','missing'):
        outputs=[]
        for req,ref in zip(inputs,refs):
            value=deepcopy(ref['target'])
            if name=='missing': continue
            if name=='always_reject' and value.get('approved') is True:value=deepcopy(example_issue)
            if name=='always_approve' and 'approved' in value:value=dict(approved=True,issues=[])
            if name.startswith('time_') and ref['task']=='event_state':
                for fact in value['facts']:
                    if name=='time_copies_value':fact['time']=fact['value']
                    elif name=='time_copies_person':fact['time']=fact['person']
                    elif name=='time_none':fact['time']='none'
                if name=='time_stale_same_value':
                    events=json.loads(req['messages'][-1]['content'])['data']['events']
                    if not isinstance(events[0],dict):
                        events=[dict(zip(('time','person','attribute','value','negated','certainty'),x.split('|'))) for x in events]
                    event,_=repeated_pair(events)
                    fact=next(f for f in value['facts'] if (f['person'],f['attribute'])==(event['person'],event['attribute']))
                    fact['time']=event['time']
            if name=='hallucinated_actual' and value.get('approved') is False:
                value['issues'][0]['actual']='invented'
            outputs.append(dict(request_id=ref['request_id'],status='ok',finish_reason='stop',text=c.canonical(value)))
        report=evaluate(bundle,outputs)
        e.require(report['gate']['passed']==(name=='perfect_reference'),'Evaluator control unexpectedly passed/failed: '+name)
        reports[name]={k:report[k] for k in ('metrics','gate','time_error_strata')}
    return dict(status='passed',not_model_inference=True,controls=reports)


def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build'); b.add_argument('--output',type=Path,required=True); b.add_argument('--seed',type=int,default=12122026)
    v=sub.add_parser('verify'); v.add_argument('--bundle',type=Path,required=True)
    ctrl=sub.add_parser('controls');ctrl.add_argument('--bundle',type=Path,required=True);ctrl.add_argument('--report',type=Path,required=True)
    s=sub.add_parser('score'); s.add_argument('--bundle',type=Path,required=True);s.add_argument('--outputs',type=Path,required=True)
    s.add_argument('--report',type=Path,required=True);s.add_argument('--split',choices=['validation','test'],default='validation')
    s.add_argument('--baseline-report',type=Path)
    args=p.parse_args()
    if args.command=='build': report=build(args.output,args.seed)
    elif args.command=='verify':report=verify(args.bundle)
    elif args.command=='controls':
        report=controls(args.bundle)
        e.require(not args.report.resolve().is_relative_to(args.bundle.resolve()),'Report must be outside frozen bundle')
        with args.report.open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
    else:
        report=evaluate(args.bundle,e.read_rows(args.outputs),args.split,
                        e.strict_json(args.baseline_report.read_text()) if args.baseline_report else None)
        e.require(not args.report.resolve().is_relative_to(args.bundle.resolve()),'Report must be outside frozen bundle')
        e.require(args.report.resolve()!=args.outputs.resolve(),'Do not overwrite raw outputs')
        with args.report.open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
    print(json.dumps(report.get('gate',report),ensure_ascii=False,indent=2))
    return 2 if args.command=='score' and not report['gate']['passed'] else 0


if __name__=='__main__':raise SystemExit(main())
