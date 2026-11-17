#!/usr/bin/env python3
"""12B-only state/contract curriculum proposal. CPU build and verify; never trains."""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess

import local12b_contrast_repair as previous
import local12b_state_evaluation as evaluation

ROOT = Path(__file__).resolve().parents[2]
VERSION = '12b-state-contract-repair-v1'
SEED = 16112026
QUOTAS = {'train':96, 'validation':32, 'test':32}
o = previous.objective
e = previous.event
STATE_RULE = e.STATE_RULE + (
    ' facts는 사건 이력 목록이 아니라 현재 상태 목록이다. (person,attribute) 조합마다 정확히 한 항목만 출력한다.'
    ' 같은 값의 재등장·부정 여부 변경·확실성 변경도 새 사건이다. 마지막 사건의 time,negated,certainty를 함께 복사한다.'
    ' negated는 문자열 true/false, certainty는 문자열 reported/unknown이며 임의 추론으로 바꾸지 않는다.'
    ' required_current_slots의 고유 조합 개수와 facts 개수가 같아야 한다.'
    ' previous_output과 validation_feedback이 있으면 오류 수정용 입력일 뿐 사실의 근거가 아니다. events만으로 다시 계산한다.')
REVIEW_RULE = previous.REVIEW_RULE + (
    ' 부정과 확실성은 서로 독립이다. negated=false라도 certainty=unknown일 수 있다.'
    ' true를 false로 바꾸는 경우와 false를 true로 바꾸는 경우 모두 오류이며 reported/unknown도 양방향 동일하게 비교한다.')


def source(seed, number, spec):
    history, _ = previous.enhanced.source(seed, number)
    latest = previous.forward_state(history)
    time_key = tuple(previous.enhanced.repeated_pair(history)[1][k] for k in ('person','attribute'))
    slots = [f for f in latest if (f['person'],f['attribute']) != time_key]
    # Repeated value with changing flags: copying the first/most confident fact is wrong.
    for index, field in enumerate(('negated','certainty')):
        fact = deepcopy(slots[index]); values = ('false','true') if field=='negated' else ('reported','unknown')
        final = spec['expected'] if spec['field']==field else values[(number+index)%2]
        start = int(history[-1]['time'])
        for offset, value in enumerate((final, next(v for v in values if v!=final), final), 1):
            item = deepcopy(fact); item[field]=value;item['time']=str(start+offset*7);history.append(item)
    return history


def project(src):
    projected=[]
    for req,ref,row in previous.project(src):
        req,ref,row=deepcopy((req,ref,row));payload=json.loads(req['messages'][-1]['content'])
        payload['rules']=STATE_RULE if req['task']=='event_state' else REVIEW_RULE
        if req['task']=='event_state':
            facts=payload['output_schema']['properties']['facts'];n=len(ref['target']['facts'])
            facts.update(minItems=n,maxItems=n)
            facts['items']['properties']['negated']['enum']=['true','false']
            facts['items']['properties']['certainty']['enum']=['reported','unknown']
        identity=e.digest([VERSION,src['source_root_id'],row['variant']])[:24]
        req['request_id']=ref['request_id']=row['row_id']=row['request_id']=identity
        if req.get('pair_id'):
            pair=e.digest([VERSION,src['source_root_id'],req['encoding']])[:24]
            for v in (req,ref,row):v['pair_id']=pair
        req['messages'][-1]['content']=e.canonical(payload)
        row['messages']=deepcopy(req['messages'])+[{'role':'assistant','content':e.canonical(ref['target'])}]
        projected.append((req,ref,row))
        if req['task']=='event_state':
            payload=deepcopy(payload);current=ref['target']['facts'];slot=current[src['number']%len(current)]
            old=next(f for f in src['events'] if (f['person'],f['attribute'])==(slot['person'],slot['attribute']))
            duplicate=deepcopy(slot if src['number']%2 else old)
            payload['data']['previous_output']={'facts':deepcopy(current)+[duplicate]}
            payload['data']['validation_feedback']={'path':'facts','rule':'one_current_fact_per_person_attribute','duplicate_slots':[{k:slot[k] for k in ('person','attribute')}]}
            repair=o.make_record('event_state',payload,deepcopy(ref['target']),src['source_root_id'],src['split'],req['encoding']+':duplicate_repair')
            for v in repair:v.update(encoding=req['encoding'],repair_kind='duplicate_current' if src['number']%2 else 'duplicate_history')
            projected.append(repair)
    return projected


def tokenizer_audit(root,tokenizer_path):
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(str(tokenizer_path),local_files_only=True)
    stats={}
    for split in ('train','validation'):
        lengths=[];tasks=Counter()
        for row in o.rows(root/f'data/12b/{split}.jsonl'):
            prompt=tokenizer.apply_chat_template(row['messages'][:-1],tokenize=False,add_generation_prompt=True,enable_thinking=False)
            content=row['messages'][-1]['content'];tail=content+'<turn|>\n'
            ids=tokenizer.encode(prompt+tail,add_special_tokens=False)
            prefix=tokenizer.encode(prompt,add_special_tokens=False)
            o.require(ids[:len(prefix)]==prefix and tokenizer.decode(ids,skip_special_tokens=False)==prompt+tail,'Tokenizer boundary/roundtrip')
            o.require(len(prefix)<len(ids)<=32768,'Empty target or context overflow; truncation forbidden')
            lengths.append(len(ids));tasks[row['task']]+=1
        stats[split]={'rows':len(lengths),'max_tokens':max(lengths),'total_tokens':sum(lengths),'tasks':dict(tasks)}
    return {'status':'passed','tokenizer_path':str(tokenizer_path),'tokenizer_sha256':{p.name:o.sha(p) for p in Path(tokenizer_path).iterdir() if p.is_file()},'template_sha256':hashlib.sha256(tokenizer.chat_template.encode()).hexdigest(),'partitions':stats,'test_tokenized':False,'training_weights_encoded':False}


def build(output,old,app):
    output=Path(output).absolute();old=Path(old).resolve(strict=True);app=Path(app).resolve(strict=True)
    o.require(output.parent==ROOT/'training_data' and not output.exists(),'Fresh ignored training_data path required')
    o.require(subprocess.run(['git','check-ignore','-q',str(output/'data.jsonl')],cwd=ROOT).returncode==0,'Data must be gitignored')
    subprocess.run(['node',str(ROOT/'ai/scripts/local12b_generation_contract.mjs'),'verify','--output',str(app)],check=True)
    bindings={str(p):o.sha(p) for p in [old/'sources.jsonl',old/'MANIFEST.json',old/'TOKENIZATION.json',app/'SOURCE_BINDING.json',app/'CONTRACT.json']}
    bindings.update({str(p):o.sha(p) for p in app.rglob('*') if p.is_file() and p.name!='VERIFICATION.json'})
    old_binding=o.read(old/'SOURCE_BINDING.json')
    forbidden=set(old_binding['historical_structures'])|{e.structure_fingerprint(s['events']) for s in o.rows(old/'sources.jsonl')}
    output.mkdir(mode=0o700);seen=set(forbidden);sources=[];number=0;stats={}
    for split,quota in QUOTAS.items():
        records=[]
        for spec in previous.specs(quota):
            while True:
                number+=1;events=source(SEED,number,spec);fingerprint=e.structure_fingerprint(events)
                if fingerprint not in seen:break
            seen.add(fingerprint)
            src={'source_root_id':VERSION+':'+e.digest([SEED,number])[:24],'split':split,'seed':SEED,'number':number,'events':events,'contrast':spec,'structure_sha256':fingerprint}
            sources.append(src);records.extend(project(src))
        inputs=[r[0] for r in records];refs=[r[1] for r in records]
        for name,values in [('inputs',inputs),('references',refs)]:o.write_rows(output/f'evaluation/event/{split}/{name}.jsonl',values)
        if split!='train':o.save(output/f'evaluation/event/{split}/COVERAGE.json',evaluation.make_coverage(inputs,refs))
        app_inputs=o.rows(app/f'evaluation/app_generation/{split}/inputs.jsonl');app_refs=o.rows(app/f'evaluation/app_generation/{split}/references.jsonl')
        for name,values in [('inputs',app_inputs),('references',app_refs)]:o.write_rows(output/f'evaluation/app_generation/{split}/{name}.jsonl',values)
        if (app/f'evaluation/app_generation/{split}/COVERAGE.json').exists():o.save(output/f'evaluation/app_generation/{split}/COVERAGE.json',o.read(app/f'evaluation/app_generation/{split}/COVERAGE.json'))
        if split!='test':
            training=[r[2] for r in records];inherited=o.rows(old/f'data/app/{split}.jsonl');generation=o.rows(app/f'data/app_generation/{split}.jsonl')
            for domain,values in [('event',training),('app',inherited),('app_generation',generation),('12b',training+inherited+generation)]:o.write_rows(output/f'data/{domain}/{split}.jsonl',values)
            for name in ('inputs','references'):
                p=old/f'evaluation/app/{split}/{name}.jsonl';bindings[str(p)]=o.sha(p);o.write_rows(output/f'evaluation/app/{split}/{name}.jsonl',o.rows(p))
            bindings[str(old/f'data/app/{split}.jsonl')]=o.sha(old/f'data/app/{split}.jsonl')
        stats[split]={'event_roots':quota*6,'event_rows':len(inputs),'app_generation_rows':len(app_inputs)}
    o.write_rows(output/'sources.jsonl',sources)
    schedule=o.fair_schedule(o.rows(output/'data/12b/train.jsonl'),SEED);o.verify_schedule(o.rows(output/'data/12b/train.jsonl'),schedule);o.save(output/'schedules/12b.json',schedule)
    tok=Path(o.read(old/'TOKENIZATION.json')['12b']['tokenizer_path'])
    o.save(output/'TOKENIZATION.json',tokenizer_audit(output,tok))
    dependencies={str(Path(m.__file__).resolve()):o.sha(Path(m.__file__)) for m in (previous,previous.enhanced,e,o,evaluation,evaluation.legacy,evaluation.legacy.paired,evaluation.event)}
    dependencies[str(Path(__file__).resolve())]=o.sha(Path(__file__))
    o.save(output/'SOURCE_BINDING.json',{'source_files':bindings,'dependencies':dependencies,'old_bundle':str(old),'app_bundle':str(app),'historical_structures':sorted(forbidden)})
    o.save(output/'COURSE_PROPOSAL.json',{'schema':VERSION,'model':'12b','design_ready':True,'training_ready':False,'training_started':False,'execution_ready':False,'trainer_hook_connected':False,'counts':stats,'updates_proposed':len(schedule['windows']),'objective':'Existing event/review weighting unchanged; app_generation target-only loss proposal requires separate trainer integration and canary','pending':['12B-only trainer task/loss integration','full event + inherited app-review + app-generation validation stop gates','GPU canary only under a later training request'],'limitations':['Synthetic new event sources; inherited app-review validation remains development data','App-generation contracts are source-hash bound; source drift invalidates verification','New training efficacy has not been measured']})
    o.save(output/'CHECKPOINT_POLICY.json',{'schema':VERSION,'training_started':False,'trainer_hook_connected':False,'required_domains':['event','app','app_generation'],'require_full_validation_and_same_cohort_baseline':True,'require_zero_state_duplicates_and_invalid':True,'flag_gates':'Each negated/certainty × encoding × direction must pass and never regress; aggregate gains do not compensate','time_reporting':['all_assigned_slots','invalid_state_penalties','valid_state_conditional','matched_valid_diagnostic'],'project_stage_completion_required':True,'allow_test_selection':False,'deployment_approved':False})
    o.require(all(o.sha(Path(p))==h for p,h in bindings.items()),'Original artifact modified')
    o.save(output/'MANIFEST.json',{'schema':VERSION,'files':o.inventory(output)})
    report=verify(output);o.save(output/'VERIFICATION.json',report);return report



def verify_app_copies(root, binding):
    old=Path(binding['old_bundle']);app=Path(binding['app_bundle'])
    checked=0
    for split in QUOTAS:
        for domain,origin in [('app_generation',app),('app',old)]:
            if domain=='app' and split=='test':continue
            names=['inputs','references']+(['COVERAGE'] if domain=='app_generation' else [])
            for name in names:
                suffix='.json' if name=='COVERAGE' else '.jsonl'
                rel=Path(f'evaluation/{domain}/{split}/{name}{suffix}')
                o.require((root/rel).read_bytes()==(origin/rel).read_bytes(),'Copied evaluation differs from bound source: '+str(rel));checked+=1
            if split!='test':
                rel=Path(f'data/{domain}/{split}.jsonl')
                o.require((root/rel).read_bytes()==(origin/rel).read_bytes(),'Copied training differs from bound source: '+str(rel));checked+=1
    return checked

def verify(root):
    root=Path(root).resolve(strict=True);manifest=o.read(root/'MANIFEST.json')
    o.require(manifest['schema']==VERSION and manifest['files']==o.inventory(root),'Inventory/hash drift')
    binding=o.read(root/'SOURCE_BINDING.json')
    for p,h in {**binding['source_files'],**binding['dependencies']}.items():o.require(o.sha(Path(p))==h,'Bound source/code drift: '+p)
    copied_app_files=verify_app_copies(root,binding)
    contract=o.read(root/'COURSE_PROPOSAL.json')
    o.require(contract['model']=='12b' and all(contract[k] is False for k in ('training_ready','training_started','execution_ready','trainer_hook_connected')),'Execution not authorized')
    seen=set(binding['historical_structures']);prompts=set();all_roots=set();sources=o.rows(root/'sources.jsonl');count=0
    for split,quota in QUOTAS.items():
        selected=[s for s in sources if s['split']==split];o.require([s['contrast'] for s in selected]==previous.specs(quota),'Quota drift')
        expected=[]
        for s in selected:
            events=source(s['seed'],s['number'],s['contrast']);fp=e.structure_fingerprint(events)
            o.require(events==s['events'] and fp==s['structure_sha256'] and fp not in seen,'Source/leakage mismatch');seen.add(fp)
            o.require(s['source_root_id'] not in all_roots,'Root overlap');all_roots.add(s['source_root_id']);expected.extend(project(s))
        inputs=o.rows(root/f'evaluation/event/{split}/inputs.jsonl');refs=o.rows(root/f'evaluation/event/{split}/references.jsonl')
        o.require(inputs==[x[0] for x in expected] and refs==[x[1] for x in expected],'Projection mismatch')
        for req,ref in zip(inputs,refs):
            payload=json.loads(req['messages'][-1]['content']);o.require(o.oracle(payload,req['task'])==ref['target'],'Independent oracle mismatch')
            o.require(e.digest(req['messages']) not in prompts,'Prompt duplication');prompts.add(e.digest(req['messages']))
            o.require(all(secret not in str(req['messages']) for secret in req['source_root_ids']+[req['request_id']]),'Private identity leak')
            if req['task']=='event_state':
                facts=ref['target']['facts'];o.require(len({(f['person'],f['attribute']) for f in facts})==len(facts),'Duplicate target')
                o.require(payload['output_schema']['properties']['facts']['maxItems']==len(facts),'State count contract')
                if 'previous_output' in payload['data']:
                    bad=payload['data']['previous_output']['facts'];o.require(len({(f['person'],f['attribute']) for f in bad})<len(bad),'Repair input is not a duplicate')
            count+=1
        if split!='train':o.require(evaluation.make_coverage(inputs,refs)==o.read(root/f'evaluation/event/{split}/COVERAGE.json'),'Coverage drift')
        if split!='test':
            o.require(o.rows(root/f'data/event/{split}.jsonl')==[x[2] for x in expected],'Training projection mismatch')
            old=Path(binding['old_bundle']);app=Path(binding['app_bundle'])
            inherited=o.rows(old/f'data/app/{split}.jsonl');generation=o.rows(app/f'data/app_generation/{split}.jsonl')
            o.require(o.rows(root/f'data/12b/{split}.jsonl')==[x[2] for x in expected]+inherited+generation,'Composition drift')
    # Hold every source lineage and every model prompt in exactly one partition,
    # including inherited app-review data and new generation examples.
    split_roots={};split_prompts={}
    for split in QUOTAS:
        split_roots[split]=set();split_prompts[split]=set()
        for domain in ('event','app','app_generation'):
            path=root/f'evaluation/{domain}/{split}/inputs.jsonl'
            if not path.exists():continue
            for req in o.rows(path):
                split_roots[split].update(req['source_root_ids'])
                signature=e.digest(req['messages'])
                o.require(signature not in split_prompts[split],'Duplicate prompt across domains')
                split_prompts[split].add(signature)
        for earlier in split_roots:
            if earlier==split:continue
            o.require(not split_roots[split]&split_roots[earlier] and not split_prompts[split]&split_prompts[earlier],'Cross-domain split leakage')
    o.require(not (root/'data/12b/test.jsonl').exists(),'Test leaked to training')
    o.verify_schedule(o.rows(root/'data/12b/train.jsonl'),o.read(root/'schedules/12b.json'))
    subprocess.run(['node',str(ROOT/'ai/scripts/local12b_generation_contract.mjs'),'verify','--output',binding['app_bundle']],check=True)
    token=o.read(root/'TOKENIZATION.json')
    o.require(token['status']=='passed' and not token['test_tokenized'],'Tokenizer audit missing')
    for name,h in token['tokenizer_sha256'].items():o.require(o.sha(Path(token['tokenizer_path'])/name)==h,'Tokenizer drift')
    return {'status':'passed','event_rows_semantically_verified':count,'source_roots':len(sources),'event_prompt_and_structure_collisions':0,'training_started':False,'training_ready':False,'execution_ready':False,'old_sources_preserved':True,'app_copies_verified':copied_app_files,'app_contract_verification':'passed','tokenization':token['partitions'],'model_improvement_measured':False}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['build','verify']);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--old',type=Path,default=ROOT/'training_data/12b_review_contrast_repair_20261115_v2');p.add_argument('--app',type=Path,default=ROOT/'training_data/12b_app_contract_repair_20261116_v1')
    a=p.parse_args();print(json.dumps(build(a.output,a.old,a.app) if a.command=='build' else verify(a.output),ensure_ascii=False))
