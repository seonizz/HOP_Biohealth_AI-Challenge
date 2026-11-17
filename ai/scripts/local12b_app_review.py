#!/usr/bin/env python3
"""Separate 12B review training supplement and development panel; no model calls.

Existing frozen training/validation sources stay in their original split.
answer_review is a dataset-only contract; memory_review uses current app callbacks.
score accepts {request_id,status:'ok',finish_reason:'stop',text:'JSON'} JSONL.
"""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

import chat_role_expansion as expansion
import role_dataset as dataset

VERSION = 'local12b-app-review-v2'
ROOT = Path(__file__).resolve().parents[2]
NODE = Path(__file__).with_name('local12b_app_contract_check.mjs')
TASKS = ('answer_review', 'memory_review')
APP_FILES = ('relationship-agent.js', 'relationship-turn.js', 'relationship-prompts.js', 'grounding-audit.js', 'agent-state.js')


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
    return json.loads(text, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_rows(path):
    return [strict_json(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def fresh_training_destination(output):
    output=Path(output).absolute()
    require(not output.exists() and not output.is_symlink(), 'Output must be a new directory')
    require(output.parent.resolve(strict=True)==output.parent==ROOT/'training_data', 'Use the original local training_data parent without symlinks')
    ignored=subprocess.run(['git','check-ignore','--quiet','--',str(output/'data/train.jsonl')],cwd=ROOT)
    require(ignored.returncode==0,'Training data destination must be Git ignored')
    return output


def write_report(path, value, bundle, protected=()):
    path=Path(path).absolute()
    require(path.parent.resolve(strict=True)==path.parent,'Report parent must exist without symlinks')
    resolved=path.resolve()
    require(not resolved.is_relative_to(Path(bundle).resolve()),'Report must be outside frozen bundle')
    require(all(resolved!=Path(item).resolve() for item in protected),'Do not overwrite raw outputs or baseline reports')
    with path.open('x') as handle:
        handle.write(json.dumps(value,ensure_ascii=False,indent=2)+'\n')


def write_rows(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as handle:
        for row in rows:
            handle.write(canonical(row)+'\n')


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def contract_hashes():
    paths = [ROOT/'app/src'/name for name in APP_FILES] + [NODE, Path(__file__),
        Path(__file__).with_name('project_memory_review_cases.mjs'), Path(__file__).with_name('project_answer_review_cases.py')]
    return {str(p.relative_to(ROOT)): file_hash(p) for p in paths}


def node_call(payload):
    result = subprocess.run(['node', str(NODE)], input=canonical(payload), text=True, capture_output=True, timeout=180, check=True)
    return strict_json(result.stdout)


def judge(task, target):
    return target if task == 'answer_review' else target['state']


def row_target(row):
    return strict_json(row['messages'][-1]['content'])


def build(source, output):
    source, output = Path(source).resolve(strict=True), fresh_training_destination(output)
    review = source/'provenance/review_expansion'
    admitted = expansion.admitted(review/'source_cases')
    cases = {key: value[0] for key, value in admitted.items()}
    answers = read_rows(review/'answer_projections.jsonl')
    memories = node_call({'mode':'project', 'cases':[cases[key] for key in sorted(cases)]})
    rows = []
    require(len(answers) == len(memories) == len(cases), 'Source inventory mismatch')
    for task, entries in zip(TASKS, (answers, memories)):
        require({entry['case_id'] for entry in entries} == set(cases), 'Source identities mismatch')
        for entry in entries:
            case = cases[entry['case_id']]
            require(entry['case_sha256'] == digest(case), 'Projection source hash mismatch')
            require(case['split'] in ('train','validation'), 'Unexpected source split')
            labels = Counter()
            for raw in entry['rows']:
                row = deepcopy(raw)
                target = row_target(row)
                metadata = row['review_metadata']
                labels[metadata['stage'], judge(task,target)['approved']] += 1
                require(row['task'] == task and metadata['approved'] is judge(task,target)['approved'], 'Label mismatch')
                lineage = 'synthetic:chat-expansion-20261031:'+case['case_id']
                identity = digest([VERSION, task, case['case_id'], row['variant']])[:24]
                row.update(row_id=identity, request_id=identity, split=case['split'],
                    source_root_ids=[lineage], source_group_ids=[lineage], loss_message_mask=[0,0,1],
                    target_sha256=hashlib.sha256(row['messages'][-1]['content'].encode()).hexdigest(),
                    weight={'numerator':1,'denominator':1},
                    contract_scope='dataset_only_answer_review' if task=='answer_review' else 'current_app_memory_review',
                    semantic_validation='inherited_source_review_not_new_full_projection_review')
                rows.append(row)
            require(labels == {(1,True):1,(1,False):1,(2,True):1,(2,False):1}, 'Unbalanced case pairs')
    validation = [dict(task=row['task'], payload=strict_json(row['messages'][1]['content']), value=row_target(row)) for row in rows]
    checks = node_call({'mode':'validate','items':validation})
    require(all(check['valid'] for check in checks) and len(checks)==len(rows), 'Current schema/callback validation failed')
    for item in validation:
        if item['task']=='answer_review':
            require(answer_grounded(item['payload'],item['value']), 'Answer reference evidence is not grounded')
    output.mkdir(parents=True)
    for split in ('train','validation'):
        write_rows(output/'data'/f'{split}.jsonl', [row for row in rows if row['split']==split])
    held = [row for row in rows if row['split']=='validation']
    inputs = [dict(request_id=row['request_id'],task=row['task'],messages=row['messages'][:-1],source_root_ids=row['source_root_ids'],contract_scope=row['contract_scope']) for row in held]
    refs = [dict(request_id=row['request_id'],task=row['task'],target=row_target(row),source_root_ids=row['source_root_ids'],
                 error_type=row['review_metadata']['error_type'],stage=row['review_metadata']['stage']) for row in held]
    write_rows(output/'evaluation/validation.inputs.jsonl', inputs)
    write_rows(output/'evaluation/validation.references.jsonl', refs)
    write_rows(output/'provenance/source_cases.jsonl', [cases[key] for key in sorted(cases)])
    counts = Counter(f"{row['split']}/{row['task']}/{judge(row['task'],row_target(row))['approved']}" for row in rows)
    source_files = ['answer_projections.jsonl','memory_projections.jsonl','source_cases/SPLITS.json']
    manifest = dict(version=VERSION,model_family='12B',training_started=False,training_ready=False,tokenized=False,
        source=str(source),source_files_sha256={name:file_hash(review/name) for name in source_files},
        source_roots=len(cases),new_independent_source_cases=0,split_policy='original_train_validation_preserved_no_test',
        evaluation_scope='development_reused_validation_not_independent_test',counts=dict(sorted(counts.items())),
        current_contract_sha256=contract_hashes(),structural_validated_rows=len(rows),
        memory_app_callback_validated_rows=sum(row['task']=='memory_review' for row in rows),
        answer_is_app_production_contract=False,independent_semantic_review_complete=False,
        files={str(p.relative_to(output)):file_hash(p) for p in sorted(output.rglob('*')) if p.is_file()})
    write_json(output/'MANIFEST.json',manifest)
    result=verify(output)
    write_json(output/'VERIFICATION.json',result)
    return result


def verify(bundle):
    bundle=Path(bundle)
    manifest=strict_json((bundle/'MANIFEST.json').read_text())
    require(manifest['version']==VERSION and manifest['current_contract_sha256']==contract_hashes(), 'Stale app or scorer contract')
    for name, expected in manifest['files'].items():
        path=(bundle/name).resolve(strict=True)
        require(path.is_relative_to(bundle.resolve()) and file_hash(path)==expected,'Bundle artifact mismatch')
    split_rows={split:read_rows(bundle/'data'/f'{split}.jsonl') for split in ('train','validation')}
    ids={split:{row['request_id'] for row in rows} for split,rows in split_rows.items()}
    roots={split:{root for row in rows for root in row['source_root_ids']} for split,rows in split_rows.items()}
    prompts={split:{digest(row['messages'][:-1]) for row in rows} for split,rows in split_rows.items()}
    require(not(ids['train']&ids['validation']) and not(roots['train']&roots['validation']) and not(prompts['train']&prompts['validation']), 'Cross-split leakage')
    for split,rows in split_rows.items():
        require(len(ids[split])==len(rows) and all(row['split']==split for row in rows),'Duplicate or reassigned rows')
    inputs=read_rows(bundle/'evaluation/validation.inputs.jsonl')
    refs=read_rows(bundle/'evaluation/validation.references.jsonl')
    require({r['request_id'] for r in inputs}=={r['request_id'] for r in refs}==ids['validation'],'Evaluation inventory mismatch')
    require(len(inputs)==len(refs)==len(ids['validation']),'Duplicate evaluation identities')
    source_cases=read_rows(bundle/'provenance/source_cases.jsonl')
    frozen={'synthetic:chat-expansion-20261031:'+case['case_id']:case['split'] for case in source_cases}
    require(len(frozen)==len(source_cases)==manifest['source_roots'],'Source inventory changed')
    for split,rows in split_rows.items():
        balance=Counter()
        for row in rows:
            require(len(row['source_root_ids'])==1 and frozen.get(row['source_root_ids'][0])==split,'Source split reassigned')
            require(row['loss_message_mask']==[0,0,1] and row['target_sha256']==hashlib.sha256(row['messages'][-1]['content'].encode()).hexdigest(),'Target or loss binding changed')
            balance[row['source_root_ids'][0],row['task'],row['review_metadata']['stage'],judge(row['task'],row_target(row))['approved']]+=1
        require(all(balance[root,task,stage,label]==1 for root in roots[split] for task in TASKS for stage in (1,2) for label in (True,False)),'Missing normal/error task pair')
    held={row['request_id']:row for row in split_rows['validation']}
    for row in inputs:
        original=held[row['request_id']]
        require(row['messages']==original['messages'][:-1] and row['task']==original['task'] and row['source_root_ids']==original['source_root_ids'],'Evaluation input no longer matches training-format validation')
    for row in refs:
        original=held[row['request_id']]
        require(row['target']==row_target(original) and row['task']==original['task'] and row['source_root_ids']==original['source_root_ids'],'Evaluation reference no longer matches validation')
    return dict(status='passed',training_ready=False,new_independent_source_cases=0,
        training_rows=len(split_rows['train']),validation_rows=len(inputs),tasks=list(TASKS),
        root_overlap=0,prompt_overlap=0,current_contract_hashes_match=True,
        semantic_review_complete=False,scope=manifest['evaluation_scope'])


def answer_grounded(payload, target):
    data=payload['data']
    turns=[row['content'] for row in data['conversation'] if row['role']=='user']
    for issue in target['issues']:
        if not issue['excerpt'] or issue['excerpt'] not in data['candidate_reply']:
            return False
        for proof in issue['evidence']:
            if type(proof['turn']) is not int or not 1<=proof['turn']<=len(turns) or not proof['quote'] or proof['quote'] not in turns[proof['turn']-1]:
                return False
    return True


def quote_grounded(payload, target):
    # A narrow mechanical check, not a semantic judge: invented quoted spans fail.
    source=canonical(payload['data'])
    quoted=re.findall(r'“([^”]+)”', canonical(target))
    return all(quote in source for quote in quoted)


def anchors(task, target):
    value=judge(task,target)
    if task=='answer_review':
        return sorted(canonical(dict(code=i['code'],excerpt=i['excerpt'],evidence=sorted(i['evidence'],key=canonical))) for i in value['issues'])
    return sorted((audit['id'],audit['verdict']) for audit in value['audits'])


def metric(num,den):
    return dict(numerator=num,denominator=den,value=num/den if den else None)


def score_rows(inputs, refs, outputs, baseline=None):
    def index(rows):
        result={row['request_id']:row for row in rows}
        require(len(result)==len(rows),'Duplicate request identity')
        return result
    requests,gold,received=map(index,(inputs,refs,outputs))
    require(requests and requests.keys()==gold.keys() and received.keys()<=requests.keys(),'Request inventory mismatch')
    parsed, validation=[],[]
    for request_id,request in requests.items():
        require(request['task'] in TASKS and gold[request_id]['task']==request['task'],'Task mismatch')
        payload=strict_json(request['messages'][-1]['content'])
        row=received.get(request_id)
        value=None
        if row and row.get('status')=='ok' and row.get('finish_reason')=='stop':
            try:value=strict_json(row['text'])
            except (KeyError,TypeError,ValueError):pass
        parsed.append((request_id,payload,value))
        validation.append(dict(task=request['task'],payload=payload,value=value))
    checks=node_call({'mode':'validate','items':validation})
    require(type(checks) is list and len(checks)==len(parsed) and all(type(check) is dict and type(check.get('valid')) is bool for check in checks),'Node validation response inventory mismatch')
    counts={task:Counter() for task in TASKS}
    records=[]
    for (request_id,payload,value),check in zip(parsed,checks):
        task=requests[request_id]['task'];target=gold[request_id]['target'];normal=judge(task,target)['approved'];c=counts[task]
        c['assigned']+=1;c['normal_assigned' if normal else 'bad_assigned']+=1
        valid=check['valid'] and type(value) is dict
        if valid:
            decision=judge(task,value)
            valid=type(decision['approved']) is bool and decision['approved']==(not decision['issues'])
            if task=='memory_review':
                audits=decision['audits'];valid=valid and len({a['id'] for a in audits})==len(audits)
        c['schema_complete']+=valid
        grounded=False;exact=False
        if valid:
            decision=judge(task,value)
            grounded=quote_grounded(payload,value) and (answer_grounded(payload,value) if task=='answer_review' else True)
            exact=anchors(task,value)==anchors(task,target) and grounded
            c['normal_approved']+=normal and decision['approved']
            c['normal_false_rejection']+=normal and not decision['approved']
            c['bad_rejected']+=not normal and not decision['approved']
            c['bad_anchors_exact']+=not normal and not decision['approved'] and exact
            c['normal_audits_exact']+=normal and decision['approved'] and exact
            c['grounded_complete']+=grounded
            c['reference_issues_verbatim']+=not normal and decision['issues']==judge(task,target)['issues']
        records.append(dict(request_id=request_id,task=task,normal=normal,complete=valid,grounded=grounded,anchors_exact=exact))
    metrics={}
    for task,c in counts.items():
        metrics[task]={'schema_completion':metric(c['schema_complete'],c['assigned']),
            'normal_approval':metric(c['normal_approved'],c['normal_assigned']),
            'normal_false_rejection':metric(c['normal_false_rejection'],c['normal_assigned']),
            'bad_rejection':metric(c['bad_rejected'],c['bad_assigned']),
            'bad_anchors_exact':metric(c['bad_anchors_exact'],c['bad_assigned']),
            'normal_audits_exact':metric(c['normal_audits_exact'],c['normal_assigned']),
            'grounded_completion':metric(c['grounded_complete'],c['assigned'])}
    gates={'schema_completion':1,'normal_approval':.95,'bad_rejection':.95,'bad_anchors_exact':.95,'normal_audits_exact':.95,'grounded_completion':.95}
    failed=[task+'/'+key for task in TASKS for key,threshold in gates.items() if metrics[task][key]['value'] is None or metrics[task][key]['value']<threshold]
    cohort=digest({'inputs':sorted(inputs,key=lambda row:row['request_id']),'references':sorted(refs,key=lambda row:row['request_id'])})
    provenance=dict(contract_sha256=contract_hashes(),outputs_sha256=digest(sorted(outputs,key=lambda row:row['request_id'])))
    regressions=[]
    if baseline is not None:
        require(baseline.get('version')==VERSION and baseline.get('split')=='validation' and baseline.get('cohort_sha256')==cohort,
                'Baseline cohort, version or split differs')
        require(baseline.get('provenance',{}).get('contract_sha256')==provenance['contract_sha256'],'Baseline app/scorer contract differs')
        for task in TASKS:
            for key,current in metrics[task].items():
                before=baseline['metrics'][task][key]['value'];after=current['value']
                require(type(before) in (int,float) and math.isfinite(before) and 0<=before<=1,'Invalid baseline metric')
                if after is None or (after>before if key=='normal_false_rejection' else after<before):regressions.append(task+'/'+key)
    return dict(version=VERSION,scope='development_reused_validation',split='validation',cohort_sha256=cohort,provenance=provenance,
        metrics=metrics,counts={k:dict(v) for k,v in counts.items()},
        gate=dict(passed=not failed and not regressions,failed=failed,thresholds=gates,regressions=regressions),records=records,
        limitations=['No semantic judge for free-form reason/repair prose','Memory grounding checks quoted spans only; audit verdicts match references','Answer contract is dataset-only, not production app turn review'])


def controls(bundle):
    verify(bundle)
    inputs=read_rows(Path(bundle)/'evaluation/validation.inputs.jsonl');refs=read_rows(Path(bundle)/'evaluation/validation.references.jsonl')
    results={}
    for mode in ('perfect','always_reject','always_approve','hallucinated_evidence'):
        outputs=[]
        for ref in refs:
            value=deepcopy(ref['target']);decision=judge(ref['task'],value)
            if mode=='always_reject' and decision['approved']:
                decision['approved']=False
                decision['issues']=[{'reason':'합성 대조 오류','repair':'합성 대조 수정'}] if ref['task']=='memory_review' else [dict(code='unsupported_fact',excerpt='없는 후보',reason='합성 대조',evidence=[dict(turn=1,quote='없는 인용')],repair='합성 대조')]
            elif mode=='always_approve':
                decision.update(approved=True,issues=[])
                if ref['task']=='memory_review':
                    request=next(r for r in inputs if r['request_id']==ref['request_id'])
                    claims=strict_json(request['messages'][-1]['content'])['data']['review_target']['claims']
                    by_id={claim['id']:claim for claim in claims}
                    for audit in decision['audits']:audit['verdict']='still_unknown' if by_id[audit['id']]['kind']=='unresolved_information' else 'supported'
            elif mode=='hallucinated_evidence':
                if ref['task']=='answer_review' and decision['issues']:decision['issues'][0]['evidence'][0]['quote']='검증 자료에 존재하지 않는 인용 XYZ'
                elif ref['task']=='memory_review':decision['audits'][0]['reason']='“검증 자료에 존재하지 않는 인용 XYZ”가 근거다.'
            outputs.append(dict(request_id=ref['request_id'],status='ok',finish_reason='stop',text=canonical(value)))
        results[mode]=score_rows(inputs,refs,outputs)
    require(results['perfect']['gate']['passed'],'Perfect reference control failed')
    require(all(not results[mode]['gate']['passed'] for mode in results if mode!='perfect'),'Broken control passed')
    return results


def evaluate(bundle, outputs, baseline=None):
    proof=verify(bundle)
    result=score_rows(read_rows(Path(bundle)/'evaluation/validation.inputs.jsonl'),read_rows(Path(bundle)/'evaluation/validation.references.jsonl'),outputs,baseline)
    result['bundle_verification']=proof
    result['provenance']['bundle_manifest_sha256']=file_hash(Path(bundle)/'MANIFEST.json')
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('build');p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    for command in ('verify','score','controls'):
        p=sub.add_parser(command);p.add_argument('--bundle',type=Path,required=True)
        if command in ('score','controls'):p.add_argument('--report',type=Path,required=True)
        if command=='score':
            p.add_argument('--outputs',type=Path,required=True)
            p.add_argument('--baseline-report',type=Path)
    args=parser.parse_args(argv)
    if args.command=='build':result=build(args.source,args.output)
    elif args.command=='verify':result=verify(args.bundle)
    elif args.command=='controls':result=controls(args.bundle);write_report(args.report,result,args.bundle)
    else:
        baseline=strict_json(args.baseline_report.read_text()) if args.baseline_report else None
        result=evaluate(args.bundle,read_rows(args.outputs),baseline)
        result['provenance']['raw_outputs_file_sha256']=file_hash(args.outputs)
        write_report(args.report,result,args.bundle,[args.outputs]+([args.baseline_report] if args.baseline_report else []))
    print(canonical(result if args.command in ('build','verify') else {'status':'written','report':str(args.report)}))
    return 2 if args.command=='score' and not result['gate']['passed'] else 0


if __name__=='__main__':raise SystemExit(main())
