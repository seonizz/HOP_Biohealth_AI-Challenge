#!/usr/bin/env python3
"""CPU-only paired curriculum and length-independent objective proposal. Never trains."""
import argparse
from array import array
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys

import event_review_curriculum as event
import local12b_event_review as enhanced
import local12b_app_review as app

ROOT=Path(__file__).resolve().parents[2]
VERSION='paired-review-objective-v1'
CHALLENGES=enhanced.TIME_MODES+('person','attribute','value','negated','certainty')
SIZES={'train':60,'validation':20,'test':20}
SEED=13112026

def require(ok,message):
    if not ok:raise ValueError(message)
def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def canonical(value):return event.canonical(value)
def digest(value):return event.digest(value)
def rows(path):return [json.loads(line) for line in Path(path).read_text().splitlines()]
def save(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def write_rows(path,values):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x') as f:
        for value in values:f.write(canonical(value)+'\n')
def inventory(root):
    result={}
    for p in sorted(root.rglob('*')):
        require(not p.is_symlink(),'Linked bundle artifact')
        if p.is_file() and p.name not in ('MANIFEST.json','VERIFICATION.json'):result[str(p.relative_to(root))]=sha(p)
    return result

def oracle(payload,task):
    """Independent reverse scan and exact multiset subtraction, no generator oracle."""
    data=payload['data'];latest={};previous=None
    parsed=[]
    for raw in data['events']:
        fact=dict(zip(('time','person','attribute','value','negated','certainty'),raw.split('|'))) if isinstance(raw,str) else dict(raw)
        require(set(fact)==set(event.FIELDS),'Event fields')
        require(previous is None or int(fact['time'])>previous,'Event ordering')
        previous=int(fact['time']);parsed.append(fact)
    for fact in reversed(parsed):latest.setdefault((fact['person'],fact['attribute']),fact)
    if task=='event_state':return {'facts':[latest[k] for k in sorted(latest)]}
    remaining=list(latest.values());unmatched=[]
    for index,fact in enumerate(data['draft']):
        if fact in remaining:remaining.remove(fact)
        else:unmatched.append((index,fact))
    if not remaining and not unmatched:return {'approved':True,'issues':[]}
    require(len(remaining)==len(unmatched)==1,'Only single-field counterfactuals admitted')
    index,actual=unmatched[0];expected=remaining[0];fields=[k for k in event.FIELDS if actual[k]!=expected[k]]
    require(len(fields)==1,'Counterfactual must change one field')
    field=fields[0]
    return {'approved':False,'issues':[dict(index=index,field=field,actual=actual[field],expected=expected[field],rule='latest_supported_tuple')]}

def make_record(task,payload,target,root,split,variant,pair=None,challenge=None):
    messages=[dict(role='system',content=event.SYSTEM),dict(role='user',content=canonical(payload))]
    rid=digest([VERSION,root,variant])[:24]
    req=dict(request_id=rid,task=task,messages=messages,source_root_ids=[root],split=split)
    ref=dict(request_id=rid,task=task,target=target,source_root_ids=[root],split=split)
    row=dict(row_id=rid,request_id=rid,task=task,split=split,source_root_ids=[root],source_group_ids=[root],
        weight={'numerator':1,'denominator':1},messages=messages+[dict(role='assistant',content=canonical(target))],
        loss_message_mask=[0,0,1],target_sha256=hashlib.sha256(canonical(target).encode()).hexdigest(),variant=variant)
    if pair:
        for value in (req,ref,row):value.update(pair_id=pair,challenge=challenge)
    if task=='event_review':ref['changed_field']=None if target['approved'] else target['issues'][0]['field']
    return req,ref,row

def project(events,facts,root,split):
    rng=random.Random(root);seen=set();result=[];prior,current=enhanced.repeated_pair(events)
    for encoding in ('pipe','object'):
        encoded=['|'.join(f[k] for k in ('time','person','attribute','value','negated','certainty')) for f in events] if encoding=='pipe' else deepcopy(events)
        for challenge in CHALLENGES:
            while True:
                draft=deepcopy(facts);rng.shuffle(draft);key=canonical(draft)
                if (encoding,key) not in seen:seen.add((encoding,key));break
            pair=digest([VERSION,root,encoding,challenge])[:24]
            field='time' if challenge in enhanced.TIME_MODES else challenge
            index=next(i for i,f in enumerate(draft) if (f['person'],f['attribute'])==(current['person'],current['attribute'])) if field=='time' else rng.randrange(len(draft))
            corrupt=deepcopy(draft);original=corrupt[index][field]
            if field=='time':wrong={'value_as_time':corrupt[index]['value'],'person_as_time':corrupt[index]['person'],'none_as_time':'none','stale_same_value_time':prior['time']}[challenge]
            else:
                options={'person':[f['person'] for f in facts],'attribute':event.ATTRIBUTES,'value':event.VALUES,'negated':('true','false'),'certainty':('reported','unknown')}[field]
                wrong=rng.choice([v for v in options if v!=original])
            corrupt[index][field]=wrong
            state_payload=dict(data=dict(event_grammar=event.GRAMMAR,events=encoded,required_current_slots=[{k:f[k] for k in ('person','attribute')} for f in draft]),rules=event.STATE_RULE,output_schema=event.schema('event_state'))
            result.append(make_record('event_state',state_payload,{'facts':deepcopy(facts)},root,split,f'{encoding}:{challenge}:state'))
            for normal,selected in ((True,draft),(False,corrupt)):
                payload=dict(data=dict(event_grammar=event.GRAMMAR,events=encoded,draft=selected),rules=event.REVIEW_RULE,output_schema=event.schema('event_review'))
                target={'approved':True,'issues':[]} if normal else {'approved':False,'issues':[dict(index=index,field=field,actual=wrong,expected=original,rule='latest_supported_tuple')]}
                require(oracle(payload,'event_review')==target,'Independent semantic oracle differs')
                result.append(make_record('event_review',payload,target,root,split,f'{encoding}:{challenge}:{normal}',pair,challenge))
    return result

def fair_schedule(training,seed=SEED):
    """Pairs stay in the same accumulation window; all task queues span the epoch."""
    buckets=defaultdict(list);paired=defaultdict(list)
    for row in training:
        if row.get('pair_id'):paired[row['pair_id']].append(row)
        else:buckets[row['task']].append([row['row_id']])
    for values in paired.values():
        require(len(values)==2 and len({v['task'] for v in values})==1,'Broken training pair')
        decisions=[decision(v['task'],json.loads(v['messages'][-1]['content'])) for v in values]
        require(sorted(decisions)==[False,True],'Training pair polarity')
        # Alternate within-pair order; no normal-first training shortcut.
        unit=[v['row_id'] for v in values];random.Random(str(seed)+values[0]['pair_id']).shuffle(unit)
        buckets[values[0]['task']].append(unit)
    for task,units in buckets.items():random.Random(str(seed)+task).shuffle(units)
    totals={k:sum(map(len,v)) for k,v in buckets.items()};used=Counter();cursor=Counter();windows=[]
    while any(cursor[t]<len(buckets[t]) for t in buckets):
        window=[]
        while len(window)<8:
            available=[t for t in buckets if cursor[t]<len(buckets[t]) and len(buckets[t][cursor[t]])<=8-len(window)]
            if not available:break
            task=min(available,key=lambda t:(used[t]/totals[t],t));unit=buckets[task][cursor[task]];cursor[task]+=1;used[task]+=len(unit);window.extend(unit)
        require(window,'Empty schedule window');windows.append(window)
    flat=[x for w in windows for x in w];require(len(flat)==len(set(flat))==len(training),'Schedule coverage')
    return dict(schema='pair-preserving-task-interleave-v1',seed=seed,accumulation=8,windows=windows,rows=len(flat),task_rows=totals)

def decision(task,target):
    return target['state']['approved'] if task=='memory_review' else target['approved']

def token_weights(task,content,ids,offsets,prefix_chars,prefix_length,tokenizer):
    """Each decision receives 1/2 total row mass regardless of rationale length."""
    weights=[0.0]*len(ids);target_positions=list(range(prefix_length,len(ids)))
    if task=='event_state':
        spans=[(m.start(1),m.end(1)) for m in re.finditer(r'"time":"([0-9]+)"',content)]
        require(len(spans)==len(json.loads(content)['facts']) and spans,'Missing time field spans')
    else:
        matches=list(re.finditer(r'"approved":(true|false)',content));require(len(matches)==1,'Ambiguous decision field')
        spans=[matches[0].span(1)]
        require(matches[0].group(1)==str(decision(task,json.loads(content))).lower(),'Wrong decision path')
    focus=[]
    for start,end in spans:
        start+=prefix_chars;end+=prefix_chars
        selected=[i for i in target_positions if offsets[i][0]>=start and offsets[i][1]<=end and offsets[i][1]>offsets[i][0]]
        require(selected and tokenizer.decode([ids[i] for i in selected],skip_special_tokens=False)==(content[start-prefix_chars:end-prefix_chars]),'Nonexact focus token boundary')
        focus.append(selected)
    flat=[i for group in focus for i in group];require(len(set(flat))==len(flat),'Overlapping focus fields')
    detail=[i for i in target_positions if i not in set(flat)];require(detail,'Missing detail tokens')
    for group in focus:
        for i in group:weights[i]=.5/len(focus)/len(group)
    for i in detail:weights[i]=.5/len(detail)
    require(abs(sum(weights)-1)<1e-9 and all(w==0 for w in weights[:prefix_length]),'Objective normalization/mask')
    return weights,focus

def encode_row(row,tokenizer):
    prefix=tokenizer.apply_chat_template(row['messages'][:-1],tokenize=False,add_generation_prompt=True,enable_thinking=False)
    content=canonical(json.loads(row['messages'][-1]['content']));target=content+'<turn|>\n';full=prefix+target
    require(content==row['messages'][-1]['content'].strip(),'Stored target must match encoded canonical target')
    encoded=tokenizer(full,add_special_tokens=False,return_offsets_mapping=True,truncation=False)
    ids=encoded['input_ids'];prefix_ids=tokenizer.apply_chat_template(row['messages'][:-1],tokenize=True,return_dict=False,add_generation_prompt=True,enable_thinking=False)
    n=len(prefix_ids);require(ids[:n]==prefix_ids and n<len(ids)<=32768,'Token boundary/truncation')
    require(tokenizer.decode(ids,skip_special_tokens=False)==full and tokenizer.decode(ids[n:],skip_special_tokens=False)==target,'Roundtrip failed')
    weights,focus=token_weights(row['task'],content,ids,encoded['offset_mapping'],len(prefix),n,tokenizer)
    return ids,weights,focus,n

def verify_schedule(training,schedule):
    windows=schedule['windows'];require(windows and all(1<=len(w)<=8 for w in windows),'Accumulation window size')
    flat=[x for w in windows for x in w];by_id={r['row_id']:r for r in training}
    require(set(flat)==set(by_id) and len(flat)==len(training)==len(set(flat)),'Schedule omission/duplication')
    placement={rid:i for i,w in enumerate(windows) for rid in w};paired=defaultdict(list)
    for row in training:
        if row.get('pair_id'):paired[row['pair_id']].append(row)
    for values in paired.values():
        require(len(values)==2 and len({placement[v['row_id']] for v in values})==1,'Pair split over windows')
        require(len({v['task'] for v in values})==1 and sorted(decision(v['task'],json.loads(v['messages'][-1]['content'])) for v in values)==[False,True],'Training pair polarity')
    tasks={r['task'] for r in training}
    for quarter in range(4):
        part=windows[len(windows)*quarter//4:len(windows)*(quarter+1)//4]
        require({by_id[rid]['task'] for w in part for rid in w}==tasks,'Task absent from schedule quarter')

def verify_encoded_row(row,item,token_bytes,weight_bytes,tokenizer,split):
    require(item['row_id']==row['row_id'] and item['task']==row['task'] and item['split']==split==row['split'],'Encoded row identity')
    ids,expected_weights,focus,n=encode_row(row,tokenizer)
    require(item['sequence_length']==len(ids) and item['prefix_length']==n and item['target_length']==len(ids)-n,'Encoded row lengths')
    require(item['focus_positions']==focus,'Semantic focus positions')
    actual_ids=array('I');actual_ids.frombytes(token_bytes)
    values=array('f');values.frombytes(weight_bytes)
    if sys.byteorder!='little':actual_ids.byteswap();values.byteswap()
    require(list(actual_ids)==ids,'Encoded tokens differ from source row')
    require(len(values)==len(expected_weights) and all(math.isfinite(x) and x>=0 and abs(x-y)<1e-8 for x,y in zip(values,expected_weights)),'Stored objective differs from semantic weights')

def encode(root,model,tokenizer_dir,training,validation):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(str(tokenizer_dir),local_files_only=True)
    expected='ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4' if model=='12b' else '845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b'
    require(hashlib.sha256(tokenizer.chat_template.encode()).hexdigest()==expected,'Wrong tokenizer template')
    folder=root/'encoded'/model;folder.mkdir(parents=True);stats={}
    for split,values in [('train',training),('validation',validation)]:
        print(f'Encoding {model} {split}: {len(values)} rows on CPU',flush=True)
        indexes=[];offset=0;lengths=Counter();focus_mass=defaultdict(list)
        with (folder/f'{split}.tokens.bin').open('xb') as tokfile,(folder/f'{split}.weights.bin').open('xb') as weightfile:
            for row in values:
                ids,weights,focus,n=encode_row(row,tokenizer)
                token_array=array('I',ids);weight_array=array('f',weights)
                require(token_array.itemsize==weight_array.itemsize==4,'Expected32bitarrays')
                if sys.byteorder!='little':token_array.byteswap();weight_array.byteswap()
                token_bytes=token_array.tobytes();weight_bytes=weight_array.tobytes();tokfile.write(token_bytes);weightfile.write(weight_bytes)
                index=dict(row_id=row['row_id'],task=row['task'],split=split,offset_tokens=offset,sequence_length=len(ids),prefix_length=n,target_length=len(ids)-n,
                    focus_positions=focus,token_sha256=hashlib.sha256(token_bytes).hexdigest(),weight_sha256=hashlib.sha256(weight_bytes).hexdigest(),objective=VERSION)
                indexes.append(index);offset+=len(ids);lengths[row['task']]+=1
                if row['task']!='event_state':focus_mass[row['task']+'/'+str(decision(row['task'],json.loads(row['messages'][-1]['content'])))].append(sum(weights[i] for group in focus for i in group))
        write_rows(folder/f'{split}.index.jsonl',indexes)
        stats[split]=dict(rows=len(values),total_tokens=offset,max_tokens=max(x['sequence_length'] for x in indexes),task_counts=dict(lengths),decision_mass={k:dict(min=min(v),max=max(v),rows=len(v)) for k,v in focus_mass.items()})
    return dict(tokenizer_path=str(tokenizer_dir.resolve()),tokenizer_sha256={p.name:sha(p) for p in tokenizer_dir.iterdir() if p.is_file()},template_sha256=expected,partitions=stats)

def build(output,old12,old31,tokenizer31):
    output=Path(output).absolute();old12=Path(old12);old31=Path(old31)
    require(output.parent==ROOT/'training_data' and not output.exists(),'Fresh gitignored training_data destination required')
    require(subprocess.run(['git','check-ignore','-q',str(output/'data.jsonl')],cwd=ROOT).returncode==0,'Data must stay ignored')
    app.verify(old12/'panels/app')
    protected={str(p):sha(p) for source in [old12,old31] for p in source.rglob('*') if p.is_file()}
    output.mkdir(mode=0o700);old_structures=set()
    for src in [old12/'panels/event/sources.jsonl',old31/'sources.jsonl']:
        for item in rows(src):old_structures.add(event.structure_fingerprint(item['events']))
    sources=[];panels={};used=set(old_structures);number=0
    for split,count in SIZES.items():
        projected=[]
        while len([s for s in sources if s['split']==split])<count:
            number+=1;events,facts=enhanced.source(SEED,number);fingerprint=event.structure_fingerprint(events)
            if fingerprint in used:continue
            used.add(fingerprint);root=VERSION+':'+digest([SEED,number])[:24]
            sources.append(dict(source_root_id=root,split=split,events=events,structure_sha256=fingerprint))
            projected.extend(project(events,facts,root,split))
        inputs,refs,training=map(list,zip(*projected));panels[split]=training
        write_rows(output/f'evaluation/event/{split}/inputs.jsonl',inputs);write_rows(output/f'evaluation/event/{split}/references.jsonl',refs)
        if split!='test':write_rows(output/f'data/event/{split}.jsonl',training)
    write_rows(output/'sources.jsonl',sources)
    app_data={}
    for split in ('train','validation'):
        inherited=rows(old12/f'panels/app/data/{split}.jsonl');inputs=[];refs=[]
        for row in inherited:
            target=json.loads(row['messages'][-1]['content']);pair=digest([VERSION,row['source_root_ids'],row['task'],row['review_metadata']['stage']])[:24]
            row['pair_id']=pair
            row['messages'][-1]['content']=canonical(target)
            row['target_sha256']=hashlib.sha256(canonical(target).encode()).hexdigest()
            inputs.append(dict(request_id=row['row_id'],task=row['task'],messages=row['messages'][:-1],source_root_ids=row['source_root_ids'],pair_id=pair,split=split))
            refs.append(dict(request_id=row['row_id'],task=row['task'],target=target,source_root_ids=row['source_root_ids'],pair_id=pair,split=split))
        app_data[split]=inherited;write_rows(output/f'data/app/{split}.jsonl',inherited)
        write_rows(output/f'evaluation/app/{split}/inputs.jsonl',inputs);write_rows(output/f'evaluation/app/{split}/references.jsonl',refs)
    schedules={};tokenization={}
    for model in ('12b','31b'):
        combined={split:panels[split]+(app_data[split] if model=='12b' else []) for split in ('train','validation')}
        schedules[model]=fair_schedule(combined['train']);save(output/f'schedules/{model}.json',schedules[model])
        for split,values in combined.items():write_rows(output/f'data/{model}/{split}.jsonl',values)
        tokenization[model]=encode(output,model,old12/'tokenizer' if model=='12b' else Path(tokenizer31),combined['train'],combined['validation'])
    save(output/'TOKENIZATION.json',tokenization)
    save(output/'SOURCE_BINDING.json',dict(source_manifest_sha256={str(p):sha(p) for p in [old12/'MANIFEST.json',old31/'MANIFEST.json']},
        dependency_sha256={str(Path(module.__file__).resolve()):sha(Path(module.__file__)) for module in (event,enhanced,app,event.d)},
        historical_test_policy='previously exposed old test is diagnostic only; never moved into training',old_structure_count=len(old_structures)))
    contract=dict(schema=VERSION,design_ready=True,training_ready=False,execution_ready=False,training_started=False,
        loss=dict(required='sum(token_weight * unshifted_label_next_token_CE), average rows per actual accumulation window',review_decision_mass=.5,event_state_time_mass=.5,remaining_target_mass=.5,prompt_mass=0,shift='exactly once in loss',legacy_uniform_CE_forbidden=True),
        sequence_policy='one jointly interleaved phase, counterfactual pairs in same window, each row exactly once; no app-only suffix',
        evaluation=dict(reused_app_validation='development only; no independent app test',old_event_test='diagnostic_only_after_exposure',fresh_event_test='freeze before any new model inference; no selection on test',selection='validation only, both polarity recalls/evidence/time/pair gates and no baseline regressions',required_checkpoints=['parent','each planned validation boundary','final'],ablations=['objective_only_on_old_split_diagnostic','objective_plus_interleave','objective_interleave_plus_new_data']),
        pending=['Implement and canary-verify weighted objective in each actual trainer before execution','Preregister model-specific token/update budget and validation-only stopping policy','No causal claim about phase interference until saved phase checkpoints are evaluated'],
        counts={m:{s:v['rows'] for s,v in t['partitions'].items()} for m,t in tokenization.items()})
    save(output/'COURSE_PROPOSAL.json',contract)
    (output/'scripts').mkdir();shutil.copyfile(__file__,output/'scripts'/Path(__file__).name)
    require(all(sha(Path(p))==h for p,h in protected.items()),'Original artifact changed')
    save(output/'MANIFEST.json',dict(schema=VERSION,files=inventory(output)))
    result=verify(output);save(output/'VERIFICATION.json',result);return result

def verify(root):
    from transformers import AutoTokenizer
    root=Path(root).resolve(strict=True);manifest=read(root/'MANIFEST.json');require(manifest['files']==inventory(root),'Artifact hash drift')
    contract=read(root/'COURSE_PROPOSAL.json');require(not contract['training_ready'] and not contract['training_started'] and contract['loss']['legacy_uniform_CE_forbidden'],'Premature training admission')
    split_roots={};all_prompts=set();counts={};event_data={}
    sources=rows(root/'sources.jsonl');structures={s['structure_sha256'] for s in sources}
    require(len(sources)==sum(SIZES.values())==len(structures),'Repeated source structure')
    source_by_id={s['source_root_id']:s for s in sources}
    require(len(source_by_id)==len(sources),'Repeated source identity')
    binding=read(root/'SOURCE_BINDING.json')
    for path,value in binding['dependency_sha256'].items():require(sha(Path(path))==value,'Curriculum dependency drift')
    for path,value in binding['source_manifest_sha256'].items():require(sha(Path(path))==value,'Original source manifest drift')
    for path in binding['source_manifest_sha256']:
        previous=Path(path).parent
        source_file=previous/'panels/event/sources.jsonl' if (previous/'panels').exists() else previous/'sources.jsonl'
        require(not structures & {event.structure_fingerprint(s['events']) for s in rows(source_file)},'Historical structure leakage')
    for split in SIZES:
        inputs=rows(root/f'evaluation/event/{split}/inputs.jsonl');refs=rows(root/f'evaluation/event/{split}/references.jsonl');split_roots[split]=set();pairs=defaultdict(list)
        require(len(inputs)==len(refs)==SIZES[split]*54,'Expected complete field/time coverage')
        for req,ref in zip(inputs,refs):
            require(req['request_id']==ref['request_id'] and req['split']==split and ref['split']==split,'Input/reference split')
            payload=json.loads(req['messages'][-1]['content']);require(oracle(payload,req['task'])==ref['target'],'Independent target mismatch')
            require(req['task']==ref['task'] and req['source_root_ids']==ref['source_root_ids'] and len(req['source_root_ids'])==1,'Input/reference source identity')
            source=source_by_id[req['source_root_ids'][0]]
            require(source['split']==split and event.structure_fingerprint(source['events'])==source['structure_sha256'],'Source split/fingerprint')
            expected_events=source['events'] if isinstance(payload['data']['events'][0],dict) else ['|'.join(f[k] for k in ('time','person','attribute','value','negated','certainty')) for f in source['events']]
            require(payload['data']['events']==expected_events,'Projected event context drift')
            prompt=digest(req['messages']);require(prompt not in all_prompts,'Duplicate model prompt');all_prompts.add(prompt)
            split_roots[split].update(req['source_root_ids'])
            if req.get('pair_id'):pairs[req['pair_id']].append((req,ref))
        for values in pairs.values():
            require(len(values)==2 and sorted(v[1]['target']['approved'] for v in values)==[False,True],'Broken polarity pair')
            a,b=[json.loads(x[0]['messages'][-1]['content']) for x in values];require(a['data']['events']==b['data']['events'],'Pair context mismatch')
            diffs=sum(x[f]!=y[f] for x,y in zip(a['data']['draft'],b['data']['draft']) for f in event.FIELDS)
            require(diffs==1,'Pair needs exactly one changed field')
        counts[split]=dict(rows=len(inputs),pairs=len(pairs),source_roots=len(split_roots[split]))
        require(len(split_roots[split])==SIZES[split] and len(pairs)==SIZES[split]*18,'Source/pair count')
        if split!='test':
            event_data[split]=rows(root/f'data/event/{split}.jsonl')
            require(len(event_data[split])==len(inputs),'Event training row count')
            for row,req,ref in zip(event_data[split],inputs,refs):
                require(row['row_id']==req['request_id'] and row['messages'][:-1]==req['messages'] and json.loads(row['messages'][-1]['content'])==ref['target'],'Event training/evaluation binding')
    require(all(not split_roots[a]&split_roots[b] for a,b in [('train','validation'),('train','test'),('validation','test')]),'Root leakage')
    old12=next(Path(p).parent for p in binding['source_manifest_sha256'] if (Path(p).parent/'panels/app').exists())
    app_roots={}
    for split in ('train','validation'):
        actual=rows(root/f'data/app/{split}.jsonl');expected=rows(old12/f'panels/app/data/{split}.jsonl')
        for row in expected:
            row['pair_id']=digest([VERSION,row['source_root_ids'],row['task'],row['review_metadata']['stage']])[:24]
            row['messages'][-1]['content']=canonical(json.loads(row['messages'][-1]['content']))
            row['target_sha256']=hashlib.sha256(row['messages'][-1]['content'].encode()).hexdigest()
        require(actual==expected,'Inherited app data drift')
        app_roots[split]={x for row in actual for x in row['source_root_ids']}
        inputs=rows(root/f'evaluation/app/{split}/inputs.jsonl');refs=rows(root/f'evaluation/app/{split}/references.jsonl')
        require(len(actual)==len(inputs)==len(refs),'App evaluation count')
        for row,req,ref in zip(actual,inputs,refs):
            require(row['row_id']==req['request_id']==ref['request_id'] and row['messages'][:-1]==req['messages'] and json.loads(row['messages'][-1]['content'])==ref['target'],'App evaluation binding')
            require(row['pair_id']==req['pair_id']==ref['pair_id'] and row['source_root_ids']==req['source_root_ids']==ref['source_root_ids'] and row['task']==req['task']==ref['task'] and row['split']==req['split']==ref['split']==split,'App evaluation metadata')
    require(not app_roots['train'] & app_roots['validation'],'App root leakage')
    for model in ('12b','31b'):
        training=rows(root/f'data/{model}/train.jsonl');verify_schedule(training,read(root/f'schedules/{model}.json'))
        token_binding=read(root/'TOKENIZATION.json')[model];tokenizer_dir=Path(token_binding['tokenizer_path'])
        require(all(sha(tokenizer_dir/name)==value for name,value in token_binding['tokenizer_sha256'].items()),'Tokenizer binding drift')
        tokenizer=AutoTokenizer.from_pretrained(str(tokenizer_dir),local_files_only=True)
        for split in ('train','validation'):
            print(f'Verifying source-bound tokens and weights: {model} {split}',flush=True)
            data=rows(root/f'data/{model}/{split}.jsonl')
            expected_data=event_data[split]+(rows(root/f'data/app/{split}.jsonl') if model=='12b' else [])
            require(data==expected_data,'Model data composition drift')
            indexes=rows(root/f'encoded/{model}/{split}.index.jsonl');tokens=(root/f'encoded/{model}/{split}.tokens.bin').read_bytes();weights=(root/f'encoded/{model}/{split}.weights.bin').read_bytes();offset=0
            require(len(indexes)==len(data),'Encoded row count')
            for row,item in zip(data,indexes):
                n=item['sequence_length'];require(item['offset_tokens']==offset and item['split']==split,'Index boundary')
                t=tokens[offset*4:(offset+n)*4];w=weights[offset*4:(offset+n)*4]
                require(hashlib.sha256(t).hexdigest()==item['token_sha256'] and hashlib.sha256(w).hexdigest()==item['weight_sha256'],'Encoded row hash')
                verify_encoded_row(row,item,t,w,tokenizer,split)
                values=array('f');values.frombytes(w)
                if sys.byteorder!='little':values.byteswap()
                require(all(x==0 for x in values[:item['prefix_length']]) and abs(sum(values)-1)<1e-6,'Stored objective weights')
                require(abs(sum(values[i] for group in item['focus_positions'] for i in group)-.5)<1e-6,'Length-dependent focus mass')
                offset+=n
            require(offset*4==len(tokens)==len(weights),'Binary inventory')
    return dict(status='passed',event=counts,semantic_oracle='reverse scan + exact multiset difference, all event rows',paired_windows_verified=True,token_weight_normalization_verified=True,
        token_source_binding_verified=True,semantic_focus_recomputed=True,encoded_rows_verified=10240,app_source_splits_preserved=True,
        originals_preserved=True,training_started=False,training_ready=False,execution_ready=False)

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['build','verify']);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--source12',type=Path,default=ROOT/'training_data/gemma4_12b_additional_training_ready_20261112_v1');p.add_argument('--source31',type=Path,default=ROOT/'training_data/gemma4_31b_event_review_supplement_20261112_v1');p.add_argument('--tokenizer31',type=Path,default=ROOT/'training_data/gemma4_31b_expanded_20261025/tokenizer');a=p.parse_args()
    result=build(a.output,a.source12,a.source31,a.tokenizer31) if a.command=='build' else verify(a.output);print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
