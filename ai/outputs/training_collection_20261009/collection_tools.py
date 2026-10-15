"""Initialize and check a local experiment evidence folder. Never trains a model."""
import argparse
import copy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sys

VERSION = 'malssi-collection-v1'
PHASES = ['before', 'after_train', 'after_eval']

MANIFESTS = {
    'run_manifest.json': {
        'schema_version': VERSION, 'run_id': None, 'created_at': None,
        'purpose': None, 'status': 'not_started', 'started_at': None, 'ended_at': None,
        'model': {'model_id': None, 'revision': None, 'local_files_manifest_sha256': None},
        'tokenizer': {'model_id': None, 'files_manifest_sha256': None, 'chat_template_sha256': None},
        'code_snapshot_sha256': None,
        'environment': {'python': None, 'torch': None, 'cuda_runtime': None, 'cuda_driver': None,
                        'transformers': None, 'unsloth': None, 'peft': None, 'bitsandbytes': None,
                        'gpu_models': [], 'gpu_count': None, 'vram_bytes_per_gpu': []},
        'training_config': {'seed': None, 'max_sequence_length': None, 'packing': None, 'truncation': None,
                            'precision': None, 'quantization': None, 'lora_r': None, 'lora_alpha': None,
                            'lora_dropout': None, 'target_modules': [], 'optimizer': None,
                            'learning_rate': None, 'scheduler': None, 'warmup': None,
                            'per_device_batch_size': None, 'gradient_accumulation_steps': None,
                            'world_size': None, 'epochs_or_max_steps': None, 'gradient_checkpointing': None,
                            'logging_rule': None, 'eval_rule': None, 'save_rule': None,
                            'loss_mask_contract': None, 'loss_reduction': None},
        'evidence': {'environment_file': None, 'effective_training_config_file': None,
                     'code_snapshot_file': None, 'checkpoint_manifest_file': None,
                     'resume_verification_file': None},
        'successful_optimizer_updates': None, 'best_checkpoint_sha256': None,
        'missing_reasons': {}
    },
    'dataset_profile.json': {
        'schema_version': VERSION, 'run_id': None, 'dataset_id': None,
        'manifest_sha256': None, 'split_manifest_sha256': None, 'split_strategy': None,
        'grouping_unit': None, 'source_lineage_audit_file': None,
        'split_rows': {'train': None, 'dev': None, 'test': None},
        'split_conversations': {'train': None, 'dev': None, 'test': None},
        'split_groups': {'train': None, 'dev': None, 'test': None},
        'funnel': [], 'hold_reason_overlaps': [], 'label_action_distribution_file': None,
        'token_statistics_file': None, 'private_row_ledger_file': None,
        'quantile_method': 'nearest_rank', 'test_usage': None, 'missing_reasons': {}
    },
    'preflight.json': {
        'schema_version': VERSION, 'run_id': None, 'status': 'not_run',
        'checks': [],
        'strict_loss_reference': {'status': 'not_run', 'reference_definition': None,
                                  'atol': None, 'rtol': None, 'evidence_file': None},
        'first_optimizer_update': {'status': 'not_run', 'evidence_file': None},
        'save_resume': {'status': 'not_run', 'evidence_file': None},
        'unresolved_findings': [], 'missing_reasons': {}
    },
    'evaluation_plan.json': {
        'schema_version': VERSION, 'run_id': None, 'plan_id': None,
        'frozen_at': None, 'protocol_sha256': None, 'evaluation_dataset_sha256': None,
        'task_profile': None, 'split': None, 'prompt_sha256': None,
        'generation_config_sha256': None, 'conditions': [], 'case_manifest_file': None,
        'checkpoint_selection_rule': None, 'retry_selection_rule': None,
        'primary_metrics': [], 'reviewer_policy': None, 'uncertain_handling': None,
        'group_aggregation_rule': None, 'test_used_for_selection': None,
        'multi_turn_history_mode': None, 'missing_reasons': {}
    }
}

RECORDS = {
    'train_steps.jsonl': {
        'run_id': None, 'segment_id': None, 'attempt_id': None, 'timestamp': None,
        'optimizer_attempt': None, 'successful_update_count': None, 'status': None,
        'epoch': None, 'microbatches': None, 'samples': None,
        'input_tokens': None, 'supervised_tokens': None, 'loss_reported': None,
        'loss_reduction': None, 'token_ce_sum': None, 'learning_rate': None,
        'grad_norm': None, 'gradients_finite': None,
        'step_wall_seconds': None, 'timing_method': None, 'warmup': None,
        'peak_allocated_bytes_per_gpu': None, 'peak_reserved_bytes_per_gpu': None,
        'metric_scope': None, 'error_code': None
    },
    'validation.jsonl': {
        'run_id': None, 'evaluation_id': None, 'timestamp': None,
        'checkpoint_sha256': None, 'evaluation_dataset_sha256': None,
        'split': None, 'status': None, 'aggregation_level': None, 'group_id': None,
        'assigned_rows': None, 'evaluated_rows': None, 'error_rows': None,
        'supervised_tokens': None, 'token_ce_sum': None,
        'loss_mask_sha256': None, 'elapsed_seconds': None, 'error_code': None
    },
    'events.jsonl': {
        'run_id': None, 'event_id': None, 'segment_id': None, 'timestamp': None,
        'event_type': None, 'status': None, 'successful_update_count': None,
        'elapsed_seconds': None, 'checkpoint_sha256': None,
        'evidence_file': None, 'details': None
    },
    'generations.jsonl': {
        'run_id': None, 'generation_id': None, 'timestamp': None, 'attempt_index': None,
        'model_condition': None, 'checkpoint_sha256': None,
        'case_id': None, 'source_group_id': None, 'session_id': None, 'turn_index': None,
        'split': None, 'history_mode': None, 'input_sha256': None,
        'prompt_sha256': None, 'generation_config_sha256': None,
        'seed': None, 'input_tokens': None, 'padded_input_width': None,
        'max_new_tokens': None, 'generated_tokens': None,
        'status': None, 'termination': None, 'forced_eos_at_limit': None,
        'prefill_exact_match': None, 'actual_prefill_sha256': None,
        'private_prefill_ids_file': None, 'response_sha256': None,
        'private_response_file': None, 'private_suffix_ids_file': None,
        'effective_generation_config_file': None,
        'latency_seconds': None, 'ttft_seconds': None,
        'peak_allocated_bytes_per_gpu': None, 'error_code': None
    },
    'reviews.jsonl': {
        'run_id': None, 'review_id': None, 'generation_id': None,
        'response_sha256': None, 'reviewer_id': None, 'reviewer_kind': None,
        'reviewed_at': None, 'blinded': None, 'independent': None,
        'rubric_sha256': None, 'review_status': None,
        'criteria': {k: None for k in ['request_resolution','actionable_support','subject_evidence',
                                      'question_necessity','refusal_correction','safety','completion']},
        'rationale_file': None
    }
}

SUPPORTING_RECORDS = {
    'case_manifest.jsonl': {
        'case_id': None, 'source_group_id': None, 'conversation_id': None,
        'session_id': None, 'split': None, 'input_sha256': None,
        'target_behavior': None, 'safety_category': None,
        'criterion_applicability': {k: None for k in RECORDS['reviews.jsonl']['criteria']},
        'applicability_rationale': None, 'protocol_sha256': None
    }
}

REQUIRED = {
    'run_manifest.json': ['run_id','purpose','model.model_id','model.local_files_manifest_sha256',
                          'tokenizer.files_manifest_sha256','tokenizer.chat_template_sha256',
                          'code_snapshot_sha256','environment.python','environment.torch',
                          'environment.transformers','environment.gpu_count','training_config.seed',
                          'training_config.max_sequence_length','training_config.loss_mask_contract',
                          'training_config.optimizer','training_config.learning_rate',
                          'training_config.per_device_batch_size','training_config.gradient_accumulation_steps',
                          'training_config.world_size','training_config.eval_rule','training_config.save_rule'],
    'dataset_profile.json': ['run_id','dataset_id','manifest_sha256','split_manifest_sha256',
                            'split_strategy','grouping_unit','split_rows.train','split_rows.dev',
                            'token_statistics_file','private_row_ledger_file','test_usage'],
    'preflight.json': ['run_id','status'],
    'evaluation_plan.json': ['run_id','plan_id','frozen_at','protocol_sha256','evaluation_dataset_sha256',
                             'task_profile','split','prompt_sha256','generation_config_sha256',
                             'checkpoint_selection_rule','retry_selection_rule','reviewer_policy',
                             'uncertain_handling','group_aggregation_rule','test_used_for_selection'],
    'train_steps.jsonl': ['run_id','segment_id','attempt_id','timestamp','optimizer_attempt',
                          'successful_update_count','status'],
    'validation.jsonl': ['run_id','evaluation_id','timestamp','checkpoint_sha256',
                         'evaluation_dataset_sha256','split','status','aggregation_level'],
    'events.jsonl': ['run_id','event_id','segment_id','timestamp','event_type','status'],
    'generations.jsonl': ['run_id','generation_id','timestamp','attempt_index','model_condition',
                          'checkpoint_sha256','case_id','source_group_id','split','input_sha256',
                          'prompt_sha256','generation_config_sha256','status'],
    'reviews.jsonl': ['run_id','review_id','generation_id','response_sha256','reviewer_id',
                      'reviewer_kind','reviewed_at','blinded','independent','rubric_sha256','review_status']
}

ENUMS = {
    'run_manifest.json': {'purpose': ['pilot','source_response_sft','caregiver_support_sft'],
                          'status': ['not_started','running','completed','failed','interrupted']},
    'preflight.json': {'status': ['not_run','passed','failed','partial']},
    'train_steps.jsonl': {'status': ['updated','skipped','oom','failed']},
    'validation.jsonl': {'status':['completed','partial','failed'], 'split':['dev','test'],
                         'aggregation_level':['overall','conversation','group']},
    'generations.jsonl': {'status':['completed','error','timeout','oom'], 'split':['dev','test'],
                          'termination':['eos_observed','length_limit','tool_handoff','custom_stop','error','unknown'],
                          'history_mode':['single_turn','teacher_forced_history','model_accumulated_history']},
    'reviews.jsonl': {'reviewer_kind':['human','expert','ai'], 'review_status':['completed','pending','conflict']}
}

def write_json(path, value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')

def get(obj, dotted):
    for key in dotted.split('.'):
        if not isinstance(obj,dict): return None
        obj=obj.get(key)
    return obj

def absent(value):
    return value is None or value == '' or value == [] or value == {}

def inspect_values(obj, label, errors):
    if isinstance(obj,dict):
        for k,v in obj.items():
            if k.endswith('_sha256') and v is not None and not (isinstance(v,str) and re.fullmatch('[0-9a-f]{64}',v)):
                errors.append(f'{label}.{k}: SHA-256 must be 64 lowercase hex characters')
            inspect_values(v,f'{label}.{k}',errors)
    elif isinstance(obj,list):
        for i,v in enumerate(obj): inspect_values(v,f'{label}[{i}]',errors)
    elif isinstance(obj,float) and not math.isfinite(obj):
        errors.append(f'{label}: non-finite number; use null plus an explicit error record')

def check_record(name, row, location, run_id, errors):
    if not isinstance(row,dict):
        errors.append(f'{location}: expected an object');return
    for key in REQUIRED[name]:
        if absent(get(row,key)):errors.append(f'{location}: missing {key}')
    if row.get('run_id')!=run_id:errors.append(f'{location}: run_id mismatch')
    for key,allowed in ENUMS.get(name,{}).items():
        if row.get(key) is not None and row[key] not in allowed:errors.append(f'{location}: invalid {key}')
    for key in ['timestamp','reviewed_at','frozen_at']:
        if row.get(key):
            try:
                dt=datetime.fromisoformat(row[key].replace('Z','+00:00'))
                if dt.tzinfo is None:raise ValueError('timezone missing')
            except (ValueError,TypeError,AttributeError):errors.append(f'{location}: invalid timezone-aware {key}')
    inspect_values(row,location,errors)
    for key in ['optimizer_attempt','successful_update_count','microbatches','samples','input_tokens',
                'supervised_tokens','assigned_rows','evaluated_rows','error_rows','attempt_index',
                'turn_index','padded_input_width','max_new_tokens','generated_tokens']:
        v=row.get(key)
        if v is not None and (type(v) is not int or v<0):errors.append(f'{location}: {key} must be a nonnegative integer')
    for key in ['loss_reported','token_ce_sum','learning_rate','grad_norm','step_wall_seconds',
                'elapsed_seconds','latency_seconds','ttft_seconds','epoch']:
        v=row.get(key)
        if v is not None and (type(v) not in [int,float] or v<0):errors.append(f'{location}: {key} must be a nonnegative number')
    for key in ['gradients_finite','warmup','forced_eos_at_limit','prefill_exact_match','blinded','independent','test_used_for_selection']:
        v=row.get(key)
        if v is not None and type(v) is not bool:errors.append(f'{location}: {key} must be boolean or null')
    if name=='train_steps.jsonl' and row.get('status')=='updated':
        for key in ['input_tokens','supervised_tokens','learning_rate','loss_reported','step_wall_seconds','loss_reduction','metric_scope']:
            if absent(row.get(key)):errors.append(f'{location}: updated step missing {key}')
        for key in ['input_tokens','supervised_tokens','step_wall_seconds','successful_update_count']:
            if type(row.get(key)) in [int,float] and row[key]<=0:errors.append(f'{location}: updated step requires positive {key}')
    if name=='train_steps.jsonl':
        if all(type(row.get(k)) is int for k in ['input_tokens','supervised_tokens']) and row['supervised_tokens']>row['input_tokens']:
            errors.append(f'{location}: supervised_tokens exceeds input_tokens')
    if name=='validation.jsonl' and row.get('status')=='completed':
        for key in ['assigned_rows','evaluated_rows','error_rows','supervised_tokens','token_ce_sum','loss_mask_sha256']:
            if absent(row.get(key)):errors.append(f'{location}: completed validation missing {key}')
        if row.get('supervised_tokens')==0:errors.append(f'{location}: completed CE cannot have zero supervised tokens')
        if row.get('aggregation_level') in ['group','conversation'] and absent(row.get('group_id')):
            errors.append(f'{location}: grouped validation needs the aggregation ID in group_id')
    if name=='validation.jsonl' and all(type(row.get(k)) is int for k in ['assigned_rows','evaluated_rows','error_rows']):
        processed=row['evaluated_rows']+row['error_rows']
        if processed>row['assigned_rows']:errors.append(f'{location}: evaluated_rows + error_rows exceeds assigned_rows')
        elif row.get('status')=='completed' and processed!=row['assigned_rows']:
            errors.append(f'{location}: completed validation has unaccounted assigned rows')
    if name=='generations.jsonl' and row.get('status')=='completed':
        for key in ['input_tokens','max_new_tokens','generated_tokens','termination','response_sha256',
                     'private_response_file','private_suffix_ids_file','actual_prefill_sha256',
                     'private_prefill_ids_file','effective_generation_config_file','latency_seconds']:
            if absent(row.get(key)):errors.append(f'{location}: completed generation missing {key}')
    if name=='generations.jsonl' and all(type(row.get(k)) is int for k in ['generated_tokens','max_new_tokens']):
        if row['generated_tokens']>row['max_new_tokens']:errors.append(f'{location}: generated_tokens exceeds max_new_tokens')
    if name=='reviews.jsonl' and row.get('review_status')=='completed':
        criteria=row.get('criteria')
        if not isinstance(criteria,dict):errors.append(f'{location}: criteria must be an object')
        else:
            for key in RECORDS[name]['criteria']:
                if criteria.get(key) not in ['pass','fail','uncertain','not_applicable']:
                    errors.append(f'{location}: missing/invalid criteria.{key}')

def check(folder, phase):
    errors=[];warnings=[];counts={};objects={};logs={}
    for name in MANIFESTS:
        try:
            value=json.loads((folder/name).read_text())
            if isinstance(value,dict):objects[name]=value
            else:errors.append(f'{name}: expected an object')
        except (OSError,ValueError) as e:errors.append(f'{name}: {e}')
    run_id=get(objects.get('run_manifest.json',{}),'run_id')
    for name,obj in objects.items():check_record(name,obj,name,run_id,errors)
    for name in RECORDS:
        records=[]
        try:
            for n,line in enumerate((folder/name).read_text().splitlines(),1):
                if not line.strip():continue
                try:row=json.loads(line)
                except ValueError as e:errors.append(f'{name}:{n}: {e}');continue
                check_record(name,row,f'{name}:{n}',run_id,errors)
                if isinstance(row,dict):records.append(row)
        except OSError as e:errors.append(f'{name}: {e}')
        logs[name]=records;counts[name]=len(records)
    successful=0
    for i,r in enumerate(logs['train_steps.jsonl'],1):
        if r.get('optimizer_attempt')!=i:errors.append(f'train_steps.jsonl:{i}: optimizer_attempt must start at 1 and remain contiguous across resumed segments')
        if r.get('status')=='updated':successful+=1
        if r.get('successful_update_count')!=successful:errors.append(f'train_steps.jsonl:{i}: successful_update_count disagrees with updated/skip/failure ledger')
    ids={}
    for name,key in [('train_steps.jsonl','attempt_id'),('events.jsonl','event_id'),('generations.jsonl','generation_id'),('reviews.jsonl','review_id')]:
        values=[r.get(key) for r in logs[name] if r.get(key)]
        if len(set(values))!=len(values):errors.append(f'{name}: duplicate {key}')
        ids[name]=set(values)
    generations={r.get('generation_id'):r for r in logs['generations.jsonl']}
    for r in logs['reviews.jsonl']:
        g=generations.get(r.get('generation_id'))
        if g is None:errors.append('reviews.jsonl: generation_id is missing from generations.jsonl')
        elif g.get('response_sha256')!=r.get('response_sha256'):errors.append('reviews.jsonl: response hash mismatch')
    if phase in ['after_train','after_eval']:
        for name in ['train_steps.jsonl','validation.jsonl','events.jsonl']:
            if counts[name]==0:errors.append(f'{name}: empty at {phase}; preserve failed runs and explain missing evidence')
        for key in ['successful_optimizer_updates','evidence.checkpoint_manifest_file','evidence.resume_verification_file']:
            if absent(get(objects.get('run_manifest.json',{}),key)):errors.append(f'run_manifest.json: missing {key}')
        declared=get(objects.get('run_manifest.json',{}),'successful_optimizer_updates')
        if declared is not None and declared!=successful:errors.append('run_manifest.json: successful_optimizer_updates disagrees with step ledger')
    if phase=='after_eval':
        for name in ['generations.jsonl','reviews.jsonl']:
            if counts[name]==0:errors.append(f'{name}: empty at after_eval')
        conditions={r.get('model_condition') for r in logs['generations.jsonl'] if r.get('model_condition')}
        if len(conditions)<2:warnings.append('Fewer than two model conditions; no measured before/after comparison established')
    pre=objects.get('preflight.json',{})
    if pre.get('status')!='passed':warnings.append('Preflight has not passed; this checker does not grant a training or quality verdict')
    if get(pre,'strict_loss_reference.status')!='passed':warnings.append('Strict loss reference remains unverified or failed')
    plan=objects.get('evaluation_plan.json',{})
    if plan.get('test_used_for_selection') is True:warnings.append('Test was used for selection; treat it as development evidence')
    warnings.append('This is a structural minimum check. It does not verify external evidence files, statistics, consent, review quality, or full protocol completion.')
    return {'schema_version':VERSION,'phase':phase,'run_id':run_id,'structural_check_passed':not errors,
            'record_counts':counts,'errors':errors,'warnings':warnings}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('init');p.add_argument('--run-id',required=True);p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('check');p.add_argument('--run',type=Path,required=True);p.add_argument('--phase',choices=PHASES,required=True)
    p.add_argument('--report',type=Path)
    p=sub.add_parser('templates');p.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.command=='init':
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',args.run_id):parser.error('Use a short ASCII run ID')
        if args.output.exists():parser.error('Output already exists; choose a new directory')
        args.output.mkdir(parents=True)
        for name,value in MANIFESTS.items():
            record=copy.deepcopy(value);record['run_id']=args.run_id
            if name=='run_manifest.json':record['created_at']=datetime.now(timezone.utc).isoformat()
            write_json(args.output/name,record)
        for name in RECORDS:(args.output/name).write_text('',encoding='utf-8')
        for name in ['artifacts','private']:(args.output/name).mkdir()
        print(f'Created {args.output}. Null fields and empty logs are intentionally unmeasured.');return 0
    if args.command=='templates':
        args.output.parent.mkdir(parents=True,exist_ok=True)
        write_json(args.output,{'schema_version':VERSION,'note':'Blank templates, not observations. Do not copy placeholders into result logs.',
                                'manifests':MANIFESTS,'jsonl_records':RECORDS,'supporting_records':SUPPORTING_RECORDS,
                                'required_minimum_fields':REQUIRED,'allowed_values':ENUMS})
        return 0
    result=check(args.run,args.phase)
    if args.report:write_json(args.report,result)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0 if result['structural_check_passed'] else 2

if __name__=='__main__':sys.exit(main())
