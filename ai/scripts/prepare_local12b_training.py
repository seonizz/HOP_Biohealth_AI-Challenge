#!/usr/bin/env python3
"""CPU-only, immutable-source admission of reviewed 12B supplementary data."""
import argparse
from array import array
from collections import Counter
from copy import deepcopy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import encode_chat_role as encoder
import local12b_app_review as app
import local12b_event_review as event
import role_dataset as d

VERSION='local12b-reviewed-training-v1'
ROOT=Path(__file__).resolve().parents[2]


def read(path):return json.loads(Path(path).read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def require(condition,message):
    if not condition:raise ValueError(message)


def inventory(root):
    result={}
    for p in sorted(Path(root).rglob('*')):
        require(not p.is_symlink(),'Symlink in admitted bundle')
        if p.is_file() and p.relative_to(root).as_posix() not in ('MANIFEST.json','VERIFICATION.json'):
            result[str(p.relative_to(root))]=sha(p)
    return result


def pack(ids):
    values=array('I',ids)
    require(values.itemsize==4,'uint32 unavailable')
    if sys.byteorder!='little':values.byteswap()
    return values.tobytes()


def independent_encode(row, tokenizer):
    prefix=tokenizer.apply_chat_template(row['messages'][:-1],tokenize=False,
        add_generation_prompt=True,enable_thinking=False)
    target=row['messages'][-1]['content'].strip()+'<turn|>\n'
    ids=tokenizer.encode(prefix+target,add_special_tokens=False)
    prefix_ids=tokenizer.encode(prefix,add_special_tokens=False)
    boundary=len(prefix_ids)
    require(ids[:boundary]==prefix_ids and 0<boundary<len(ids)<=32768,'Independent prefix/context mismatch')
    require(tokenizer.decode(ids,skip_special_tokens=False)==prefix+target,'Independent full decode mismatch')
    require(tokenizer.decode(ids[boundary:],skip_special_tokens=False)==target,'Independent target decode mismatch')
    labels=[-100]*boundary+ids[boundary:]
    require(all(x==-100 for x in labels[:boundary]) and labels[boundary:]==ids[boundary:], 'Loss mask mismatch')
    return ids,boundary


def rewrite_rows(path,rows):
    Path(path).write_text(''.join(d.canonical(row)+'\n' for row in rows))


def apply_patches(panel, patches):
    """Accept exact old-row hash bound complete replacements from semantic review."""
    lookup={p['row_id']:p for p in patches}
    require(len(lookup)==len(patches),'Duplicate patch identity')
    applied=[]
    for split in ('train','validation'):
        path=panel/'data'/f'{split}.jsonl';rows=app.read_rows(path)
        for index,row in enumerate(rows):
            if row['row_id'] not in lookup:continue
            patch=lookup.pop(row['row_id'])
            require(app.digest(row)==patch['original_row_sha256'],'Patch source changed')
            updated=deepcopy(patch['patched_row'])
            for key in ('row_id','request_id','split','source_root_ids','source_group_ids','task','loss_message_mask'):
                require(updated[key]==row[key],'Patch changes identity/split/task/mask')
            d.check_row(updated)
            require(updated['target_sha256']==hashlib.sha256(updated['messages'][-1]['content'].encode()).hexdigest(),'Patch target digest mismatch')
            require(app.judge(updated['task'],app.row_target(updated))['approved'] == app.judge(row['task'],app.row_target(row))['approved'], 'Patch changed polarity')
            rows[index]=updated
            applied.append(dict(row_id=row['row_id'],old_sha256=app.digest(row),new_sha256=app.digest(updated)))
        rewrite_rows(path,rows)
    require(not lookup,'Patch ID not found')
    held={r['request_id']:r for r in app.read_rows(panel/'data/validation.jsonl')}
    for name in ('inputs','references'):
        path=panel/f'evaluation/validation.{name}.jsonl';rows=app.read_rows(path)
        for row in rows:
            source=held[row['request_id']]
            if name=='inputs':row['messages']=source['messages'][:-1]
            else:row['target']=app.row_target(source)
        rewrite_rows(path,rows)
    manifest=read(panel/'MANIFEST.json')
    manifest['admission_patches']=applied
    manifest['files']={name:sha(panel/name) for name in manifest['files']}
    d.save(panel/'MANIFEST.json',manifest)
    d.save(panel/'VERIFICATION.json',app.verify(panel))
    return applied


def semantic_check(reports, source_event, source_app):
    expected={'answer_review':(800,sha(source_app/'MANIFEST.json')),
              'memory_review':(800,sha(source_app/'MANIFEST.json')),
              'event_review':(1200,sha(source_event/'MANIFEST.json'))}
    require(set(reports)==set(expected),'Missing independent semantic review')
    for task,(rows,manifest_hash) in expected.items():
        report=reports[task]
        require(report['task']==('event_state_and_review' if task=='event_review' else task),'Semantic review task mismatch')
        require(report['status']=='approved' and not report['unresolved_issues'],'Semantic review not approved: '+task)
        require(report['source_manifest_sha256']==manifest_hash,'Semantic review source drift: '+task)
        require(report['mechanically_checked_rows']==rows,'Incomplete exhaustive audit: '+task)
        records=report['independently_read_rows']
        require(records and len({r['row_id'] for r in records})==len(records),'Missing/duplicate semantic reading receipts')
        source=source_event if task=='event_review' else source_app
        actual={r['row_id']:r for split in ('train','validation') for r in app.read_rows(source/f'data/{split}.jsonl')}
        test_pairs={}
        if task=='event_review':
            require(report.get('exhaustive_symbolic_semantically_checked_rows')==1200,'Incomplete symbolic semantic check')
            test_inputs={r['request_id']:r for r in app.read_rows(source/'evaluation/test/inputs.jsonl')}
            test_refs={r['request_id']:r for r in app.read_rows(source/'evaluation/test/references.jsonl')}
            test_pairs={key:dict(input=value,reference=test_refs[key]) for key,value in test_inputs.items()}
        for record in records:
            scope=record.get('row_hash_scope','training_row')
            require(scope in ('training_row','input_and_reference_pair'),'Unknown semantic receipt scope')
            lookup=actual if scope=='training_row' else test_pairs
            require(record['row_id'] in lookup and app.digest(lookup[record['row_id']])==record['row_sha256'], 'Reading receipt row mismatch')
            if task!='event_review':require(lookup[record['row_id']]['task']==task,'Receipt belongs to another task')
            require(record['verdict'] in ('approved','approved_after_patch'),'Unapproved reading receipt')
    return True


def build(event_source, app_source, tokenizer_path, review_paths, output, patch_path=None):
    event_source=Path(event_source).resolve(strict=True);app_source=Path(app_source).resolve(strict=True)
    tokenizer_path=Path(tokenizer_path).resolve(strict=True);output=Path(output).absolute()
    require(output.parent==ROOT/'training_data' and output.parent.resolve()==output.parent
            and not output.exists(),'Use a fresh original training_data directory')
    require(subprocess.run(['git','check-ignore','-q',str(output/'data.jsonl')],cwd=ROOT).returncode==0,'Data path must be gitignored')
    event.verify(event_source);app.verify(app_source)
    reports={task:read(path) for task,path in review_paths.items()}
    semantic_check(reports,event_source,app_source)
    patches=read(patch_path) if patch_path else []
    if isinstance(patches,dict):patches=patches['patches']
    for name,pin in encoder.PINS.items():require(sha(tokenizer_path/name)==pin,'Wrong 12B tokenizer')
    source_hashes={str(p):sha(p) for source in (event_source,app_source) for p in source.rglob('*') if p.is_file()}
    output.mkdir(mode=0o700);(output/'panels').mkdir();(output/'semantic').mkdir();(output/'scripts').mkdir()
    for name,source in (('event',event_source),('app',app_source)):
        shutil.copytree(source,output/'panels'/name)
    applied=apply_patches(output/'panels/app',patches)
    reviewed_fixes={r['row_id'] for r in reports['answer_review']['independently_read_rows']+reports['memory_review']['independently_read_rows'] if r['verdict']=='approved_after_patch'}
    require(reviewed_fixes=={p['row_id'] for p in applied},'Patches lack independent approval or approved patch omitted')
    receipts={r['row_id']:r for report in reports.values() for r in report['independently_read_rows']}
    require(all(receipts[p['row_id']].get('patched_row_sha256')==p['new_sha256'] for p in applied),
            'Patched row differs from independently reviewed correction')
    app_rows=[row for split in ('train','validation') for row in app.read_rows(output/f'panels/app/data/{split}.jsonl')]
    items=[dict(task=row['task'],payload=app.strict_json(row['messages'][1]['content']),value=app.row_target(row)) for row in app_rows]
    checks=app.node_call(dict(mode='validate',items=items))
    require(len(checks)==len(items) and all(x['valid'] for x in checks),'Patched current contract validation failed')
    require(all(app.answer_grounded(x['payload'],x['value']) for x in items if x['task']=='answer_review'),
            'Patched answer reference not grounded')
    for task,path in review_paths.items():shutil.copyfile(path,output/'semantic'/f'{task}.json')
    d.save(output/'semantic/APPLIED_PATCHES.json',applied)
    if patch_path:shutil.copyfile(patch_path,output/'semantic/PATCHES.json')
    shutil.copytree(tokenizer_path,output/'tokenizer')
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',TOKENIZERS_PARALLELISM='false')
    from transformers import AutoTokenizer
    hf=AutoTokenizer.from_pretrained(str(output/'tokenizer'),local_files_only=True,trust_remote_code=False)
    encoder.initialize(output/'tokenizer')
    phases=[];statistics={};total=0
    for phase,panel in (('01_event_state_review','event'),('02_answer_memory_review','app')):
        parts={};(output/'encoded'/phase).mkdir(parents=True)
        for split in ('train','validation'):
            data_path=f'panels/{panel}/data/{split}.jsonl';rows=app.read_rows(output/data_path)
            index_path=f'encoded/{phase}/{split}.index.jsonl';binary_path=f'encoded/{phase}/{split}.tokens.bin'
            count,offset,targets,maximum=0,0,0,0;tasks=Counter()
            with (output/index_path).open('x') as idx,(output/binary_path).open('xb') as binary:
                for row in rows:
                    metadata,ids=encoder.encode_batch([row])[0]
                    second,boundary=independent_encode(row,hf)
                    require(ids==second and metadata['prefix_length']==boundary,'Independent numeric mismatch')
                    raw=pack(ids);metadata.update(offset_tokens=offset,token_sha256=hashlib.sha256(raw).hexdigest())
                    binary.write(raw);idx.write(d.canonical(metadata)+'\n')
                    count+=1;offset+=len(ids);targets+=metadata['target_length'];maximum=max(maximum,len(ids));tasks[row['task']]+=1
            parts[split]=dict(path=data_path,rows=count,tasks=dict(tasks),token_index=index_path,token_binary=binary_path)
            statistics[phase+'/'+split]=dict(rows=count,sequence_tokens=offset,target_tokens=targets,max_sequence_length=maximum)
            total+=count;print(d.canonical({'encoded':phase+'/'+split,**statistics[phase+'/'+split]}),flush=True)
        phases.append(dict(id=phase,data=parts))
    course=dict(schema=VERSION,role='supplemental_12b_combined',phases=phases,
        model=dict(identity='google/gemma-4-12B-it',revision=encoder.REVISION,tokenizer_sha256=encoder.PINS,
                   max_encoded_sequence_length=32768,enable_thinking=False),
        training_ready=False,training_started=False,readiness_scope='data_admitted_for_bounded_research_training',
        execution_ready=False,checkpoint_selection='not_selected_or_modified_by_data_preparation',
        token_storage='little_endian_uint32_contiguous_no_padding',
        label_rule='[-100] * prefix_length + input_ids[prefix_length:]; no pre-shift; trainer shifts causally once',
        loss=dict(mask='last_assistant_only',reduction='mean_target_token_CE_per_row',weighting='preserved_equal_row_weights'),
        truncation=False,packing=False,validation_used_for_gradient=False,test_used_for_gradient=False,
        evaluation_test='panels/event/evaluation/test',
        limitations=['Natural-language independent semantic review is stratified, not every row read by a human.',
                    'Symbolic event contract and dataset-only answer review do not prove app/clinical quality.',
                    'Review data reuse original validation; no new independent natural-language test.',
                    'Training requires compatible 12B checkpoint and isolated runtime preflight; no training launched.'])
    d.save(output/'COURSE.json',course)
    d.save(output/'TOKENIZATION.json',dict(status='passed',partitions=statistics,rows=total,
        tokenizer_sha256=encoder.PINS,revision=encoder.REVISION,independently_reencoded_rows=total,
        boundary_mismatches=0,decode_mismatches=0,truncated_rows=0,loss_mask_mismatches=0,
        software={p:importlib.metadata.version(p) for p in ('transformers','tokenizers','jinja2')},
        model_weights_loaded=False,gpu_used=False))
    for module in (Path(__file__),Path(encoder.__file__),Path(d.__file__)):
        shutil.copyfile(module,output/'scripts'/module.name)
    require(all(sha(p)==h for p,h in source_hashes.items()),'Frozen input source changed')
    d.save(output/'SOURCE_BINDING.json',dict(source_files_sha256=source_hashes,semantic_report_paths={k:str(v) for k,v in review_paths.items()}))
    d.save(output/'MANIFEST.json',dict(schema=VERSION,files=inventory(output)))
    proof=verify(output,numeric=True,allow_pending=True)
    course['training_ready']=True;d.save(output/'COURSE.json',course)
    d.save(output/'MANIFEST.json',dict(schema=VERSION,files=inventory(output)))
    final=verify(output)
    final['full_numeric_reencoding']=proof['full_numeric_reencoding']
    d.save(output/'VERIFICATION.json',final);return final


def verify(root,numeric=False,allow_pending=False):
    root=Path(root).resolve(strict=True);manifest=read(root/'MANIFEST.json');course=read(root/'COURSE.json')
    require(manifest['schema']==VERSION and manifest['files']==inventory(root),'Admitted bundle changed')
    require(course['training_ready'] is (not allow_pending) and not course['training_started'],'Wrong admission state')
    for name,pin in encoder.PINS.items():require(sha(root/'tokenizer'/name)==pin,'Wrong tokenizer pins')
    for task in ('answer_review','memory_review','event_review'):
        semantic=read(root/f'semantic/{task}.json')
        require(semantic['task']==('event_state_and_review' if task=='event_review' else task)
                and semantic['status']=='approved' and not semantic['unresolved_issues'],'Semantic admission lost')
    binding=read(root/'SOURCE_BINDING.json')['source_files_sha256']
    patched={r['row_id']:r for r in read(root/'semantic/APPLIED_PATCHES.json')}
    for task in ('answer_review','memory_review','event_review'):
        semantic=read(root/f'semantic/{task}.json');panel=root/'panels'/('event' if task=='event_review' else 'app')
        require(semantic['source_manifest_sha256']==binding[str(Path(semantic['source_bundle'])/'MANIFEST.json')],
                'Review/source manifest binding lost')
        current={r['row_id']:r for split in ('train','validation') for r in app.read_rows(panel/f'data/{split}.jsonl')}
        pairs={}
        if task=='event_review':
            reqs={r['request_id']:r for r in app.read_rows(panel/'evaluation/test/inputs.jsonl')}
            refs={r['request_id']:r for r in app.read_rows(panel/'evaluation/test/references.jsonl')}
            pairs={key:dict(input=value,reference=refs[key]) for key,value in reqs.items()}
        for receipt in semantic['independently_read_rows']:
            rid=receipt['row_id'];scope=receipt.get('row_hash_scope','training_row');lookup=current if scope=='training_row' else pairs
            require(rid in lookup,'Reviewed row absent from admitted bundle')
            if rid in patched:
                require(receipt['row_sha256']==patched[rid]['old_sha256'] and receipt.get('patched_row_sha256')==
                        patched[rid]['new_sha256']==app.digest(lookup[rid]),'Admitted patch review binding lost')
            else:require(receipt['row_sha256']==app.digest(lookup[rid]),'Admitted reading receipt drift')
    hf=None
    if numeric:
        os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',TOKENIZERS_PARALLELISM='false')
        from transformers import AutoTokenizer
        hf=AutoTokenizer.from_pretrained(str(root/'tokenizer'),local_files_only=True,trust_remote_code=False)
    ids={s:set() for s in ('train','validation')};roots={s:set() for s in ids};counts=Counter();maximum=0
    for phase in course['phases']:
        require(set(phase['data'])=={'train','validation'},'Test entered training phases')
        for split,part in phase['data'].items():
            rows=app.read_rows(root/part['path']);indices=app.read_rows(root/part['token_index'])
            require(len(rows)==len(indices)==part['rows'],'Token row inventory mismatch')
            offset=0
            with (root/part['token_binary']).open('rb') as binary:
                for row,index in zip(rows,indices):
                    d.check_row(row)
                    require(row['row_id'] not in ids[split] and row['split']==split,'Duplicate/wrong-split row')
                    ids[split].add(row['row_id']);roots[split].update(row['source_root_ids'])
                    require(index['row_id']==row['row_id'] and index['offset_tokens']==offset
                            and index['messages_sha256']==d.digest(d.canonical(row['messages'])),'Token metadata mismatch')
                    require(0<index['prefix_length']<index['sequence_length']<=32768
                            and index['target_length']==index['sequence_length']-index['prefix_length'],'Invalid token bounds')
                    raw=binary.read(index['sequence_length']*4)
                    require(len(raw)==index['sequence_length']*4 and hashlib.sha256(raw).hexdigest()==index['token_sha256'],'Token byte/hash mismatch')
                    if numeric:
                        tokens,boundary=independent_encode(row,hf)
                        require(raw==pack(tokens) and boundary==index['prefix_length'],'Re-encoded numeric mismatch')
                    offset+=index['sequence_length'];counts[split]+=1;maximum=max(maximum,index['sequence_length'])
                require(binary.read()==b'','Trailing token bytes')
    require(not(ids['train']&ids['validation'] or roots['train']&roots['validation']),'Cross-split leakage')
    test=app.read_rows(root/'panels/event/evaluation/test/inputs.jsonl')
    require(not ({r['request_id'] for r in test}&(ids['train']|ids['validation'])),'Test IDs included in train/validation')
    require(not ({x for r in test for x in r['source_root_ids']}&(roots['train']|roots['validation'])),'Test roots included in train/validation')
    numeric_proof=read(root/'TOKENIZATION.json')
    require(numeric_proof['status']=='passed' and numeric_proof['rows']==numeric_proof['independently_reencoded_rows']==sum(counts.values())
            and all(numeric_proof[k]==0 for k in ('boundary_mismatches','decode_mismatches','truncated_rows','loss_mask_mismatches')),
            'Numeric audit coverage mismatch')
    return dict(status='passed',training_ready=course['training_ready'],training_started=False,counts=dict(counts),
        full_numeric_reencoding=numeric,max_sequence_length=maximum,test_excluded=True,
        cross_split_roots=0,scope=course['readiness_scope'])


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build')
    for name in ('event-source','app-source','tokenizer','output','answer-review','memory-review','event-review'):
        b.add_argument('--'+name,type=Path,required=True)
    b.add_argument('--patches',type=Path)
    v=sub.add_parser('verify');v.add_argument('--bundle',type=Path,required=True);v.add_argument('--numeric',action='store_true')
    a=p.parse_args()
    report=verify(a.bundle,a.numeric) if a.command=='verify' else build(a.event_source,a.app_source,a.tokenizer,
        {'answer_review':a.answer_review,'memory_review':a.memory_review,'event_review':a.event_review},a.output,a.patches)
    print(d.canonical(report))


if __name__=='__main__':main()
