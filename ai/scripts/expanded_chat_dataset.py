#!/usr/bin/env python3
"""Standalone, locally verified 12B curriculum; no training or remote inference."""
from array import array
import argparse
from collections import Counter
from copy import deepcopy
from fractions import Fraction
from itertools import zip_longest
import json
import os
from pathlib import Path
import shutil
import sys

import chat_role_expansion as expansion
import encode_chat_role as encoder
import native_chat_review
import role_dataset as d

SCHEMA='malssi-expanded-chat-12b-v1'
META=('row_id','task','split','weight','source_group_ids','source_root_ids','target_sha256')


def read(path):return json.loads(Path(path).read_text())


def inventory(root):
    return {str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':d.file_hash(p)}
            for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ('MANIFEST.json','VERIFICATION.json')}


def manifest(root):d.save(root/'MANIFEST.json',{'schema':SCHEMA,'files':inventory(root)})


def project(cases,projections):
    output=[]
    d.require(set(cases)==set(projections),'Projection case inventory differs')
    for identity,(case,review) in sorted(cases.items()):
        projection=projections[identity]
        d.require(projection['case_sha256']==d.digest(d.canonical(case)),'Projection source changed')
        d.require(len(projection['rows'])==8,'Incomplete task projection')
        for row in projection['rows']:
            row=deepcopy(row);lineage='synthetic:chat-expansion-20261031:'+identity
            row.update(row_id='expanded-'+identity+'-'+row['variant'],split=case['split'],
                loss_message_mask=[0]*(len(row['messages'])-1)+[1],weight={'numerator':1,'denominator':1},
                source_group_ids=[lineage],source_root_ids=[lineage],origin_type=case['origin_type'],
                target_sha256=d.digest(row['messages'][-1]['content']),
                provenance=[{'case_id':identity,'case_sha256':projection['case_sha256'],
                    'review_sha256':d.digest(d.canonical(review)),
                    'transformation':'app_schema_projection_from_authored_source_spans_v1'}],
                approval_scope=native_chat_review.SCOPE)
            d.check_row(row);output.append(row)
    return output


def encode(root,phase,split,part):
    folder=root/'encoded'/phase;folder.mkdir(parents=True,exist_ok=True)
    index=folder/(split+'.index.jsonl');binary=folder/(split+'.tokens.bin');offset=0;target=0;maximum=0
    with index.open('x') as idx,binary.open('xb') as out:
        for row in d.read_rows(root/part['path']):
            metadata,tokens=encoder.encode_batch([row])[0]
            packed=array('I',tokens);d.require(packed.itemsize==4,'Need uint32')
            if sys.byteorder!='little':packed.byteswap()
            raw=packed.tobytes();metadata.update(offset_tokens=offset,token_sha256=d.digest(raw))
            out.write(raw);idx.write(d.canonical(metadata)+'\n')
            offset+=len(tokens);target+=metadata['target_length'];maximum=max(maximum,len(tokens))
    part.update(token_index=str(index.relative_to(root)),token_binary=str(binary.relative_to(root)))
    return {'rows':part['rows'],'sequence_tokens':offset,'target_tokens':target,'max_sequence_length':maximum,
            'method':'pinned_12b_fresh_encoding_and_roundtrip'}


def audit_numeric(root):
    """Independently encode non-warmup rows using HF's public chat-template API."""
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',TOKENIZERS_PARALLELISM='false')
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(str(root/'tokenizer'),local_files_only=True,trust_remote_code=False)
    stats={}
    course=read(root/'COURSE.json')
    for phase in course['phases'][1:]:
        for split,part in phase['data'].items():
            count=0
            with (root/part['token_binary']).open('rb') as handle:
                for row,index in zip_longest(d.read_rows(root/part['path']),d.read_rows(root/part['token_index'])):
                    d.require(row is not None and index is not None,'Numeric inventory mismatch')
                    prefix=tokenizer.apply_chat_template(row['messages'][:-1],tokenize=False,
                        add_generation_prompt=True,enable_thinking=False)
                    completion=row['messages'][-1]['content'].strip()+'<turn|>\n'
                    ids=tokenizer.encode(prefix+completion,add_special_tokens=False)
                    prefix_ids=tokenizer.encode(prefix,add_special_tokens=False)
                    packed=array('I',ids)
                    if sys.byteorder!='little':packed.byteswap()
                    raw=handle.read(index['sequence_length']*4)
                    d.require(raw==packed.tobytes() and index['prefix_length']==len(prefix_ids)
                              and ids[:len(prefix_ids)]==prefix_ids,'Independent token/boundary mismatch')
                    d.require(tokenizer.decode(ids[len(prefix_ids):],skip_special_tokens=False)==completion,'Independent target decode mismatch')
                    count+=1
                d.require(handle.read()==b'','Trailing token bytes')
            stats[phase['id']+'/'+split]=count
    return {'independently_reencoded_rows':sum(stats.values()),'partitions':stats,'mismatches':0,
            'warmup_audit':'all_three_artifacts_byte_identical_to_manifest_bound_12b_source',
            'method':'AutoTokenizer_apply_chat_template_and_encode_separate_from_builder',
            'model_weights_loaded':False,'gpu_used':False}


def build(prior,cases,projection,output):
    prior=prior.resolve(strict=True);cases=cases.resolve(strict=True);projection=projection.resolve(strict=True)
    d.require(output.parent.resolve().name=='training_data' and not output.exists(),'Use fresh ignored training_data directory')
    accepted=expansion.admitted(cases)
    cov=expansion.coverage({k:c for k,(c,_) in accepted.items()})
    d.require(cov['train']['cases']==160 and cov['validation']['cases']==40,'Expected complete 200-case expansion')
    for split,expected in (('train',16),('validation',4)):
        d.require(cov[split]['challenges']==dict.fromkeys(expansion.CHALLENGES,expected),'Unbalanced challenge coverage')
    projections={r['case_id']:r for r in d.read_rows(projection)}
    app_report=read(str(projection)+'.verification.json')
    d.require(app_report['status']=='passed' and app_report['cases']==200
              and app_report['projections_sha256']==d.file_hash(projection),'Missing current app contract verification')
    new=project(accepted,projections)
    oldcourse=read(prior/'COURSE.json');prior_manifest=read(prior.parent/'MANIFEST.json')
    d.require(oldcourse['role']=='chat_12b' and oldcourse['model']['tokenizer_sha256']==encoder.PINS,'Wrong prior model')
    output.mkdir(mode=0o700);(output/'provenance').mkdir();(output/'scripts').mkdir()
    shutil.copytree(prior/'tokenizer',output/'tokenizer')
    shutil.copytree(cases,output/'provenance/expansion')
    shutil.copyfile(projection,output/'provenance/PROJECTIONS.jsonl')
    d.save(output/'APP_CONTRACT.json',app_report)
    shutil.copyfile(prior.parent/'MANIFEST.json',output/'provenance/PRIOR_MANIFEST.json')
    shutil.copyfile(prior/'COURSE.json',output/'provenance/PRIOR_COURSE.json')
    course=deepcopy(oldcourse);course.update(schema=SCHEMA,optional=[],coverage_status='expanded_fictional_nonclinical_role_curriculum',
        quality_status='independently_ai_reviewed_not_human_or_clinically_validated',independent_test=False)
    course['phases'][1]['purpose']='grounded_supporter_replies_question_selection_and_question_review'
    course['phases'][2]['purpose']='reported_state_memory_and_combined_draft_from_structured_source_spans'
    stats={};copied={}
    for number,phase in enumerate(course['phases']):
        for split,oldpart in oldcourse['phases'][number]['data'].items():
            if number==0:
                for kind in ('path','token_index','token_binary'):
                    name=oldpart[kind];src=prior/name;dest=output/name
                    expected=prior_manifest['files']['chat_12b/'+name]
                    d.require(d.file_hash(src)==expected['sha256'],'Frozen prior changed')
                    dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest)
                    d.require(d.file_hash(dest)==expected['sha256'],'Copied warmup changed')
                    copied[name]=expected
                entries=list(d.read_rows(output/oldpart['token_index']))
                stats[phase['id']+'/'+split]={'rows':len(entries),'sequence_tokens':sum(r['sequence_length'] for r in entries),
                    'target_tokens':sum(r['target_length'] for r in entries),'max_sequence_length':max(r['sequence_length'] for r in entries),
                    'method':'exact_verified_12b_artifact_copy'}
                continue
            oldpath=prior/oldpart['path'];old=output/'provenance'/oldpart['path']
            old.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(oldpath,old)
            d.require(d.file_hash(old)==prior_manifest['files']['chat_12b/'+oldpart['path']]['sha256'],'Changed legacy rows')
            rows=list(d.read_rows(old))+[r for r in new if r['phase']==phase['id'] and r['split']==split]
            rows=d.balance(rows)
            phase['data'][split]=d.write_partition(output,phase['id'],split,rows)
    encoder.initialize(output/'tokenizer')
    for phase in course['phases'][1:]:
        for split,part in phase['data'].items():
            stats[phase['id']+'/'+split]=encode(output,phase['id'],split,part)
            print(d.canonical({'encoded':phase['id']+'/'+split,**stats[phase['id']+'/'+split]}),flush=True)
    d.save(output/'COURSE.json',course);d.save(output/'ADMISSION.json',{'coverage':cov,'accepted_cases':len(accepted),
        'rows_per_new_case':8,'review_scope':native_chat_review.SCOPE,'clinical_or_human_approval':False})
    d.save(output/'provenance/SOURCE.json',{'prior_manifest_sha256':d.file_hash(prior.parent/'MANIFEST.json'),
        'prior_root_at_build':str(prior),'byte_identical_warmup':copied,
        'held_openers_not_added':True,'historical_optional_tasks_not_added':True})
    d.save(output/'TOKENIZATION.json',{'partitions':stats,'tokenizer_sha256':encoder.PINS,'truncated_rows':0,
        'model_weights_loaded':False,'gpu_used':False,'loss_mask':'final_assistant_only'})
    for name in ('expanded_chat_dataset.py','chat_role_expansion.py','native_chat_review.py','role_dataset.py','encode_chat_role.py',
                 'project_chat_cases.mjs','test_chat_role_expansion.py'):
        shutil.copyfile(Path(__file__).with_name(name),output/'scripts'/name)
    shutil.copyfile(Path(__file__).with_name('chat_and_role_evaluation_README.md'),output/'README.md')
    d.save(output/'NUMERIC_AUDIT.json',audit_numeric(output))
    manifest(output);result=verify(output);d.save(output/'VERIFICATION.json',result)
    return result


def verify(root):
    root=root.resolve(strict=True);m=read(root/'MANIFEST.json')
    d.require(m['schema']==SCHEMA and m['files']==inventory(root),'Changed bundle inventory/hash')
    for name in m['files']:d.safe_path(root,name)
    course=read(root/'COURSE.json');old=read(root/'provenance/PRIOR_COURSE.json')
    d.require(course['role']=='chat_12b' and course['model']==old['model'] and course['loss']==old['loss'],'Changed course model/loss')
    for key in ('truncation','packing','split_reassignment','validation_used_for_gradient','cross_model_adapter_reuse','training_started'):
        d.require(course[key] is False,'Unsafe course setting '+key)
    d.require([p['id'] for p in course['phases']]==[p['id'] for p in old['phases']],'Changed phase order')
    prior=read(root/'provenance/PRIOR_MANIFEST.json');binding=read(root/'provenance/SOURCE.json')
    d.require(d.file_hash(root/'provenance/PRIOR_MANIFEST.json')==binding['prior_manifest_sha256'],'Changed prior binding')
    for name,info in binding['byte_identical_warmup'].items():
        d.require(info==prior['files']['chat_12b/'+name] and d.file_hash(root/name)==info['sha256'],'Warmup mismatch')
    for name,expected in encoder.PINS.items():d.require(d.file_hash(root/'tokenizer'/name)==expected,'Tokenizer mismatch')
    cases=expansion.admitted(root/'provenance/expansion')
    projections={r['case_id']:r for r in d.read_rows(root/'provenance/PROJECTIONS.jsonl')}
    d.require(read(root/'APP_CONTRACT.json')['projections_sha256']==d.file_hash(root/'provenance/PROJECTIONS.jsonl'),'Changed app contract projection')
    new=project(cases,projections);lineage={s:set() for s in d.SPLITS};inputs={s:set() for s in d.SPLITS}
    seen=set();counts={};tokens=0
    for number,phase in enumerate(course['phases']):
        counts[phase['id']]={}
        for split,part in phase['data'].items():
            expected=None
            if number:
                src=root/'provenance'/old['phases'][number]['data'][split]['path']
                d.require(d.file_hash(src)==prior['files']['chat_12b/'+old['phases'][number]['data'][split]['path']]['sha256'],'Legacy binding changed')
                rows=list(d.read_rows(src))+[r for r in new if r['phase']==phase['id'] and r['split']==split]
                expected={r['row_id']:r for r in d.balance(rows)}
            loader=d.IndexedTokens(root/part['token_index'],root/part['token_binary'])
            mass=Fraction();actual=set();tasks=Counter()
            with loader.binary.open('rb') as binary:
                for row,index in zip_longest(d.read_rows(root/part['path']),loader.entries):
                    d.require(row is not None and index is not None,'Row/token inventory differs');d.check_row(row)
                    d.require(row['row_id'] not in seen and row['split']==split,'Duplicate/wrong split')
                    if expected is not None:d.require(row==expected[row['row_id']],'Projection/weight changed')
                    for key in META:d.require(row[key]==index[key],'Index metadata changed')
                    d.require(d.digest(d.canonical(row['messages']))==index['messages_sha256'],'Token/text identity mismatch')
                    raw=binary.read(index['sequence_length']*4)
                    d.require(len(raw)==index['sequence_length']*4,'Truncated token file')
                    if number:d.require(d.digest(raw)==index['token_sha256'],'Changed encoded row')
                    seen.add(row['row_id']);actual.add(row['row_id']);mass+=Fraction(**row['weight']);tasks[row['task']]+=1
                    lineage[split].update(row['source_group_ids']+row['source_root_ids'])
                    inputs[split].add(d.digest(d.canonical(row['messages'][:-1])));tokens+=index['sequence_length']
                d.require(binary.read()==b'','Trailing token bytes')
            d.require(len(actual)==part['rows'] and mass==len(actual) and dict(tasks)==part['tasks'],'Wrong counts or loss mass')
            if expected is not None:d.require(actual==set(expected),'Missing projected rows')
            counts[phase['id']][split]=len(actual)
    d.require(not(lineage['train']&lineage['validation']) and not(inputs['train']&inputs['validation']),'Train/validation leakage')
    audit=read(root/'NUMERIC_AUDIT.json')
    d.require(audit['mismatches']==0 and audit['independently_reencoded_rows']==sum(v[s] for k,v in counts.items() for s in d.SPLITS if k!=course['phases'][0]['id']),'Numeric audit mismatch')
    return {'status':'passed','rows':len(seen),'sequence_tokens':tokens,'counts':counts,
        'unique_new_cases':len(cases),'new_projected_rows':len(new),'cross_split_lineage_collisions':0,
        'exact_input_cross_split_collisions':0,'independent_numeric_audit':audit,
        'training_started':False,'human_or_clinical_validation':False}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=('build','verify'))
    p.add_argument('--root',type=Path,required=True);p.add_argument('--prior',type=Path);p.add_argument('--cases',type=Path);p.add_argument('--projection',type=Path)
    a=p.parse_args();print(d.canonical(verify(a.root) if a.command=='verify' else build(a.prior,a.cases,a.projection,a.root)))
