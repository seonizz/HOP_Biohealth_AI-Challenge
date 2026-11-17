#!/usr/bin/env python3
"""CPU-only 12B contrast repair. Writes a fresh ignored bundle; never trains."""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import random
import subprocess

import event_review_curriculum as event
import local12b_event_review as enhanced
import local12b_repair_evaluation as repair_evaluation
import review_bias_curriculum as objective

ROOT = Path(__file__).resolve().parents[2]
VERSION = 'local12b-contrast-repair-v2'
SEED = 15112026
ROOTS_PER_FIELD = {'train': 96, 'validation': 32, 'test': 32}
REVIEW_RULE = event.REVIEW_RULE + (
    ' 반드시 person, attribute, value, time, negated, certainty 여섯 필드를 각각 정확히 비교한다.'
    ' value가 같아도 negated의 true/false 또는 certainty의 reported/unknown이 다르면 승인하지 않는다.'
    ' 두 방향의 차이를 똑같이 오류로 취급한다. 사람·속성·순서도 다른 필드가 맞다는 이유로 무시하지 않는다.'
    ' 여섯 필드가 모두 현재 사실과 일치할 때만 승인한다. 추측으로 필드를 보완하거나 오류를 만들지 않는다.')

require = objective.require
read = objective.read
rows = objective.rows
save = objective.save
write_rows = objective.write_rows
sha = objective.sha


def specs(per_field):
    require(per_field > 0 and per_field % 4 == 0, 'Field quota must divide by four')
    result = []
    for field in event.FIELDS:
        for ordinal in range(per_field):
            challenge = enhanced.TIME_MODES[ordinal % 4] if field == 'time' else field
            expected = ('true', 'false')[ordinal % 2] if field == 'negated' else (
                ('reported', 'unknown')[ordinal % 2] if field == 'certainty' else None)
            result.append(dict(field=field, challenge=challenge, expected=expected,
                               position=('first', 'middle', 'last')[ordinal % 3], ordinal=ordinal))
    return result


def forward_state(events):
    current = {}
    for fact in events:
        current[fact['person'], fact['attribute']] = fact
    return [deepcopy(current[k]) for k in sorted(current)]


def project(source):
    """One source, one contrast, two representations; no ninefold normal replay."""
    facts = forward_state(source['events']); spec = source['contrast']
    rng = random.Random(source['source_root_id']); field = spec['field']
    if field == 'time':
        prior, current = enhanced.repeated_pair(source['events'])
        chosen = next(f for f in facts if (f['person'], f['attribute']) == (current['person'], current['attribute']))
    else:
        eligible = [f for f in facts if spec['expected'] is None or f[field] == spec['expected']]
        require(eligible, 'Source lacks planned flag direction'); chosen = rng.choice(eligible)
    rest = [deepcopy(f) for f in facts if f != chosen]; rng.shuffle(rest)
    index = {'first': 0, 'middle': len(facts)//2, 'last': len(facts)-1}[spec['position']]
    draft = rest; draft.insert(index, deepcopy(chosen)); corrupt = deepcopy(draft)
    if field == 'time':
        wrong = {'value_as_time': chosen['value'], 'person_as_time': chosen['person'],
                 'none_as_time': 'none', 'stale_same_value_time': prior['time']}[spec['challenge']]
    else:
        choices = {'person': sorted({f['person'] for f in facts}), 'attribute': event.ATTRIBUTES,
                   'value': event.VALUES, 'negated': ('true', 'false'),
                   'certainty': ('reported', 'unknown')}[field]
        wrong = rng.choice([v for v in choices if v != chosen[field]])
    corrupt[index][field] = wrong
    require(wrong != chosen[field], 'No-op contrast')
    direction = wrong + '->' + chosen[field] if field in ('negated', 'certainty') else 'any'
    result = []
    for encoding in ('pipe', 'object'):
        encoded = ['|'.join(f[k] for k in ('time','person','attribute','value','negated','certainty'))
                   for f in source['events']] if encoding == 'pipe' else deepcopy(source['events'])
        pair = event.digest([VERSION, source['source_root_id'], encoding])[:24]
        for kind, selected in [('state', None), ('normal', draft), ('error', corrupt)]:
            task = 'event_state' if kind == 'state' else 'event_review'
            data = dict(event_grammar=event.GRAMMAR, events=encoded)
            if selected is None:
                data['required_current_slots'] = [{k:f[k] for k in ('person','attribute')} for f in draft]
                target = {'facts': facts}
            else:
                data['draft'] = deepcopy(selected)
                target = {'approved': True, 'issues': []} if kind == 'normal' else {
                    'approved': False, 'issues': [dict(index=index, field=field, actual=wrong,
                    expected=chosen[field], rule='latest_supported_tuple')]}
            payload = dict(data=data, rules=event.STATE_RULE if kind == 'state' else REVIEW_RULE,
                           output_schema=event.schema(task))
            require(objective.oracle(payload, task) == target, 'Independent semantic oracle mismatch')
            req, ref, train = objective.make_record(task, payload, target, source['source_root_id'],
                source['split'], encoding+':'+kind, pair if selected is not None else None,
                spec['challenge'] if selected is not None else None)
            # Private grouping is not added to messages or assistant targets.
            for value in (req, ref, train):
                value.update(encoding=encoding, mutation_direction=direction,
                             contrast_field=field, draft_position=spec['position'])
            result.append((req, ref, train))
    return result


def protected_files(source):
    names = ['sources.jsonl', 'MANIFEST.json', 'ORIGINAL_MANIFEST.json', 'TOKENIZATION.json']
    for split in ('train', 'validation'):
        names += [f'data/app/{split}.jsonl', f'evaluation/app/{split}/inputs.jsonl',
                  f'evaluation/app/{split}/references.jsonl']
    names += [str(p.relative_to(source)) for p in sorted((source/'tokenizer').iterdir()) if p.is_file()]
    return {str(source/n): sha(source/n) for n in names}


def build(output, source):
    output = Path(output).absolute(); source = Path(source).resolve(strict=True)
    require(output.parent == ROOT/'training_data' and not output.exists(), 'Fresh training_data output required')
    require(subprocess.run(['git','check-ignore','-q',str(output/'data.jsonl')],cwd=ROOT).returncode == 0,
            'Training data must be ignored')
    bindings = protected_files(source)
    dependencies = {str(Path(m.__file__).resolve()):sha(Path(m.__file__)) for m in (event, enhanced, objective, repair_evaluation)}
    historical = {event.structure_fingerprint(s['events']) for s in rows(source/'sources.jsonl')}
    older = ROOT/'training_data/gemma4_12b_additional_training_ready_20261112_v1/panels/event/sources.jsonl'
    if older.exists():
        bindings[str(older)] = sha(older)
        historical.update(event.structure_fingerprint(s['events']) for s in rows(older))
    output.mkdir(mode=0o700); seen = set(historical); number = 0; sources = []; data = {}
    for split, quota in ROOTS_PER_FIELD.items():
        projected = []
        for spec in specs(quota):
            while True:
                number += 1; events, facts = enhanced.source(SEED, number)
                fingerprint = event.structure_fingerprint(events)
                if fingerprint in seen: continue
                if spec['expected'] is not None and not any(f[spec['field']] == spec['expected'] for f in facts):continue
                break
            seen.add(fingerprint)
            source_row = dict(source_root_id=VERSION+':'+event.digest([SEED,number])[:24], split=split,
                events=events, structure_sha256=fingerprint, contrast=spec, seed=SEED, number=number)
            sources.append(source_row); projected.extend(project(source_row))
        inputs, refs, training = map(list, zip(*projected))
        write_rows(output/f'evaluation/event/{split}/inputs.jsonl', inputs)
        write_rows(output/f'evaluation/event/{split}/references.jsonl', refs)
        if split != 'train':save(output/f'evaluation/event/{split}/COVERAGE.json', repair_evaluation.make_coverage(inputs, refs))
        if split != 'test':
            write_rows(output/f'data/event/{split}.jsonl', training); data[split] = training
    write_rows(output/'sources.jsonl', sources)
    for split in ('train','validation'):
        inherited = rows(source/f'data/app/{split}.jsonl')
        write_rows(output/f'data/app/{split}.jsonl', inherited)
        for name in ('inputs','references'):
            write_rows(output/f'evaluation/app/{split}/{name}.jsonl', rows(source/f'evaluation/app/{split}/{name}.jsonl'))
        data[split] += inherited; write_rows(output/f'data/12b/{split}.jsonl', data[split])
    schedule = objective.fair_schedule(data['train'], SEED)
    objective.verify_schedule(data['train'], schedule); save(output/'schedules/12b.json', schedule)
    tokenization = objective.encode(output,'12b',source/'tokenizer',data['train'],data['validation'])
    save(output/'TOKENIZATION.json', {'12b':tokenization})
    save(output/'SOURCE_BINDING.json', dict(source_files=bindings,dependencies=dependencies,
        historical_structures=sorted(historical),source_bundle=str(source),exposed_old_event_test='diagnostic_only_never_train_or_select',
        code_sha256=sha(Path(__file__)),old_31b_artifacts_modified=False))
    policy = dict(schema='12b-validation-selection-policy-v2',training_started=False,trainer_hook_connected=False,
        require_baseline=True,require_app_gate=True,allow_test_selection=False,
        checkpoints=[0,25,50,100,200,300,400,500,len(schedule['windows'])],
        required_event_validation='all1152 rows; exact COVERAGE.json; all6fields,9challenges,2formats,bothflagdirections',
        required_app_validation='all320 inherited development rows; original pair/schema/evidence gates',
        selection='only complete validation reports; all event and app gates pass; no baseline regressions; otherwise no candidate',
        monitoring='after each scheduled checkpoint, pause further updates for review if bad false approval exceeds5% or increases over validation baseline; never use test for this decision',
        test='new1152row test used once after validation selection; old exposed test diagnostic only',
        inference_settings='freeze same tokenizer/template/greedy settings for both arms; no output repair or adaptive retry by semantic result')
    save(output/'CHECKPOINT_POLICY.json',policy)
    save(output/'COURSE_PROPOSAL.json',dict(schema=VERSION,model='12b',design_ready=True,
        training_ready=False,execution_ready=False,training_started=False,trainer_hook_connected=False,
        purpose='field-balanced independent-source contrasts and complete validation; efficacy untested',
        counts=dict(train=len(data['train']),validation=len(data['validation']),event_test=ROOTS_PER_FIELD['test']*36),
        row_budget=dict(previous_train=4520,new_train=len(data['train']),updates=len(schedule['windows']),accumulation=8),
        loss=dict(unchanged_from_verified_v1=True,decision_mass=.5,event_time_mass=.5,prompt_mass=0,
                  note='No evidence of weight application bug; no unvalidated negative-weight increase'),
        pending=['Connect full-validation stop/selection policy to12B trainer and test before any training',
                 'Preregister matched-budget ablation: rule only; source/field balance; both changes',
                 'Verify CPU/CUDA objective and task budget for a future explicitly requested run'],
        limitations=['Synthetic source generator; no independent real-language product guarantee',
                    'App validation is reused development data', 'New model improvement has not been measured']))
    require(all(sha(Path(p))==h for p,h in bindings.items()),'Original12B artifact changed')
    save(output/'MANIFEST.json',dict(schema=VERSION,files=objective.inventory(output)))
    report=verify(output);save(output/'VERIFICATION.json',report);return report


def verify(root):
    from transformers import AutoTokenizer
    root=Path(root).resolve(strict=True); manifest=read(root/'MANIFEST.json')
    require(manifest['schema']==VERSION and manifest['files']==objective.inventory(root),'Bundle inventory/hash drift')
    contract=read(root/'COURSE_PROPOSAL.json');require(contract['model']=='12b' and not any(contract[k] for k in
        ('training_ready','execution_ready','training_started','trainer_hook_connected')),'Unexpected execution admission')
    require(not (root/'data/31b').exists() and not (root/'encoded/31b').exists(),'Unexpected31B output')
    binding=read(root/'SOURCE_BINDING.json')
    for path,h in {**binding['source_files'],**binding['dependencies']}.items():require(sha(Path(path))==h,'Source/dependency drift')
    require(sha(Path(__file__))==binding['code_sha256'],'Builder drift')
    source=Path(binding['source_bundle']); values=rows(root/'sources.jsonl')
    historical={event.structure_fingerprint(s['events']) for s in rows(source/'sources.jsonl')}
    for path in binding['source_files']:
        if path.endswith('/panels/event/sources.jsonl'):
            historical.update(event.structure_fingerprint(s['events']) for s in rows(Path(path)))
    require(historical==set(binding['historical_structures']),'Historical exclusion inventory drift')
    policy=read(root/'CHECKPOINT_POLICY.json')
    require(policy['require_baseline'] and policy['require_app_gate'] and not policy['allow_test_selection']
            and not policy['trainer_hook_connected'] and not policy['training_started'],'Selection policy weakened')
    all_structures=set(); prompts=set(); partition_roots={}; stats={}; event_training={}
    for split,quota in ROOTS_PER_FIELD.items():
        selected=[s for s in values if s['split']==split];require(len(selected)==quota*6,'Source quota mismatch')
        require([s['contrast'] for s in selected]==specs(quota),'Field/direction quota drift')
        expected=[];partition_roots[split]=set()
        for s in selected:
            fingerprint=event.structure_fingerprint(s['events'])
            require(fingerprint==s['structure_sha256'] and fingerprint not in all_structures
                    and fingerprint not in binding['historical_structures'],'Historical or cross-split structure leakage')
            original_events,_=enhanced.source(s['seed'],s['number']);require(original_events==s['events'],'Source reproducibility mismatch')
            all_structures.add(fingerprint);partition_roots[split].add(s['source_root_id']);expected.extend(project(s))
        inputs=rows(root/f'evaluation/event/{split}/inputs.jsonl');refs=rows(root/f'evaluation/event/{split}/references.jsonl')
        require(inputs==[r[0] for r in expected] and refs==[r[1] for r in expected],'Projection/label/metadata drift')
        for req,ref in zip(inputs,refs):
            h=event.digest(req['messages']);require(h not in prompts,'Duplicate model prompt');prompts.add(h)
            payload=json.loads(req['messages'][-1]['content'])
            require(objective.oracle(payload,req['task'])==ref['target'],'Independent label oracle failed')
            require(not any(k in payload for k in ('challenge','mutation_direction','pair_id','source_root_ids')),'Private labels leaked')
            if req['task']=='event_review':require(payload['rules']==REVIEW_RULE,'Public six-field rule mismatch')
        if split != 'train':require(read(root/f'evaluation/event/{split}/COVERAGE.json')==repair_evaluation.make_coverage(inputs,refs),'Coverage contract changed')
        if split!='test':
            event_training[split]=[r[2] for r in expected]
            require(rows(root/f'data/event/{split}.jsonl')==event_training[split],'Training differs from verified labels')
        stats[split]=dict(rows=len(inputs),source_roots=len(selected),fields=dict(Counter(s['contrast']['field'] for s in selected)))
    require(len(values)==sum(ROOTS_PER_FIELD.values())*6,'Orphan source')
    require(all(not partition_roots[a]&partition_roots[b] for a,b in [('train','validation'),('train','test'),('validation','test')]),'Root leakage')
    require(not (root/'data/event/test.jsonl').exists() and not (root/'data/12b/test.jsonl').exists(),'Test entered training')
    tok=read(root/'TOKENIZATION.json')['12b']; tokdir=Path(tok['tokenizer_path'])
    require(all(sha(tokdir/n)==h for n,h in tok['tokenizer_sha256'].items()),'Tokenizer drift')
    tokenizer=AutoTokenizer.from_pretrained(str(tokdir),local_files_only=True);encoded_rows=0
    for split in ('train','validation'):
        app_data=rows(root/f'data/app/{split}.jsonl');require(app_data==rows(source/f'data/app/{split}.jsonl'),'Inherited app drift')
        for name in ('inputs','references'):
            require(rows(root/f'evaluation/app/{split}/{name}.jsonl')==rows(source/f'evaluation/app/{split}/{name}.jsonl'),'App evaluation drift')
        actual=rows(root/f'data/12b/{split}.jsonl');require(actual==event_training[split]+app_data,'12B composition changed')
        require(contract['counts'][split]==len(actual),'Declared data count differs')
        if split=='train':
            schedule=read(root/'schedules/12b.json');objective.verify_schedule(actual,schedule)
            require(contract['row_budget']['new_train']==len(actual) and contract['row_budget']['updates']==len(schedule['windows']),'Declared training budget differs')
            require(policy['checkpoints']==[0,25,50,100,200,300,400,500,len(schedule['windows'])],'Validation boundaries changed')
        indexes=rows(root/f'encoded/12b/{split}.index.jsonl');tokens=(root/f'encoded/12b/{split}.tokens.bin').read_bytes();weights=(root/f'encoded/12b/{split}.weights.bin').read_bytes();offset=0
        require(len(indexes)==len(actual),'Encoded row count')
        for row,item in zip(actual,indexes):
            n=item['sequence_length'];require(item['offset_tokens']==offset,'Token offset mismatch')
            t=tokens[offset*4:(offset+n)*4];w=weights[offset*4:(offset+n)*4]
            require(hashlib.sha256(t).hexdigest()==item['token_sha256'] and hashlib.sha256(w).hexdigest()==item['weight_sha256'],'Encoded artifact mismatch')
            objective.verify_encoded_row(row,item,t,w,tokenizer,split);offset+=n;encoded_rows+=1
        require(offset*4==len(tokens)==len(weights),'Extra or missing token bytes')
    return dict(status='passed',model='12b',event=stats,encoded_rows=encoded_rows,training_started=False,
        training_ready=False,execution_ready=False,all_event_labels_independently_checked=True,
        prompt_and_structure_leakage=0,source_artifacts_preserved=True,app_data_preserved=True,
        decision_weights_unchanged_and_recomputed=True,old_test_quarantined=True,model_improvement_measured=False)


def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['build','verify']);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--source',type=Path,default=ROOT/'runtime/ubuntu12b-evalresume-20261115-1269/data')
    a=p.parse_args();print(json.dumps(build(a.output,a.source) if a.command=='build' else verify(a.output),ensure_ascii=False))


if __name__=='__main__':main()
