#!/usr/bin/env python3
"""Offline source-counselor QLoRA kit: preparation is separate from optimizer updates."""
import argparse
import math
import os
from pathlib import Path
import sys
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from counseling_pipeline.stage1_preparation import (require, read_json, write_json, sha_file, verify_bundle, load_config,
    bindings, read_rows, configure_environment, verify_environment, prepare_tokens, load_tokens,
    gpu_lock, load_model, beneath, REQUIRED_CHECKS)
from counseling_pipeline.stage1_readiness import validate_report, verify_artifact_hashes

CANARY_CHECKS = ('weights_updated', 'checkpoint_saved', 'checkpoint_resumed', 'length_4096')
CONTRACTS = {'fused_loss': 'bf16_linear_fp32_softcap_v1', 'fused_gradient': 'hidden_gradient_bf16_v1'}


def optimizer_for(model, config):
    import torch
    return torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=config['learning_rate'],
                             weight_decay=config['weight_decay'], foreach=False)


def validate_preparation(work, bound):
    return validate_report(read_json(work / 'qualification.json'), expected_bindings=bound,
                           required_checks=REQUIRED_CHECKS, mode='preparation', expected_check_contracts=CONTRACTS)


def validate_canary(work, bound):
    report = read_json(work / 'canary_gate.json')
    validate_report(report, expected_bindings=bound, required_checks=CANARY_CHECKS, mode='optimizer_canary')
    require(report['optimizer_steps'] == 3, 'Canary must complete two initial and one resumed updates')
    verify_artifact_hashes(work, report['artifacts'])
    result = read_json(work / 'canary/TRAINING_RESULT.json')
    require(result['completed_optimizer_steps'] == 3 and result['epoch_completed'] is True, 'Canary did not complete')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'prepare', 'verify-cache', 'qualify', 'canary', 'canary-resume', 'train', 'resume', 'evaluate'])
    parser.add_argument('--kit', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(); kit = args.kit.resolve()
    verify_bundle(kit); config = load_config(kit); bound = bindings(kit, config)
    if args.command == 'verify':
        rows, _ = read_rows(kit)
        print({'status': 'passed', 'rows': {k: len(v) for k, v in rows.items()}, 'bindings': bound})
        return 0
    work = configure_environment(kit, config)
    verify_environment(kit, config)  # fresh installed source + all model shard fingerprints
    if args.command == 'prepare':
        if (work / 'tokens/manifest.json').exists():
            values = load_tokens(kit, bound)
            print({'status': 'existing_cache_verified', 'rows': {k: len(v) for k, v in values.items()}})
        else:
            print(prepare_tokens(kit, config, bound))
        return 0
    if args.command == 'verify-cache':
        values = load_tokens(kit, bound); print({'status': 'passed', 'rows': {k: len(v) for k, v in values.items()}})
        return 0
    lock = gpu_lock(work)  # retained throughout process; no alternate-GPU fallback
    try:
        if args.command != 'qualify':
            validate_preparation(work, bound)
        if args.command in ('train', 'resume', 'evaluate'):
            validate_canary(work, bound)
        import torch
        from counseling_pipeline.stage1_training_loop import run_training, evaluate
        from counseling_pipeline.stage1_runtime_probe import qualify, adapter_hash
        model, tokenizer = load_model(config)
        if args.command == 'qualify':
            require(not (work / 'qualification.json').exists(), 'Qualification evidence exists; preserve it before rerun')
            raw, lengths = read_rows(kit)
            qualify(model, tokenizer, raw['train'], lengths, bound, work / 'qualification.json')
            return 0
        rows = load_tokens(kit, bound)
        optimizer = optimizer_for(model, config)
        if args.command in ('canary', 'canary-resume'):
            longest = sorted(rows['train'], key=lambda r: (-r['sequence_length'], r['id']))[:24]
            require(len(longest) == 24 and longest[0]['sequence_length'] == 4096, 'Missing full-length canary rows')
            before = adapter_hash(model)
            if args.command == 'canary':
                require(not (work / 'canary_gate.json').exists(), 'Existing canary evidence must be preserved')
            else:
                checkpoint = work / 'canary/checkpoints/step-000000002'
                require(checkpoint.is_dir(), 'Resume requires committed step2 checkpoint')
                require(checkpoint.resolve().is_relative_to((work / 'canary/checkpoints').resolve()), 'Canary checkpoint outside run')
                restored_manifest_sha = sha_file(checkpoint / 'CHECKPOINT.json')
            torch.cuda.reset_peak_memory_stats()
            result = run_training(model, optimizer, longest, work / 'canary', pad_id=tokenizer.pad_token_id, bindings=bound,
                                  max_steps=2 if args.command == 'canary' else 3, checkpoint_every=1, mode='canary', shuffle=False,
                                  resume_from=None if args.command == 'canary' else 'latest')
            after = adapter_hash(model)
            require(before != after, 'No adapter change after canary')
            write_json(work / (args.command + '_execution.json'), {'result': result, 'initial_base_adapter_sha256': before,
                       'after_adapter_sha256': after, 'peak_allocated_gib': torch.cuda.max_memory_allocated()/2**30,
                       'peak_reserved_gib': torch.cuda.max_memory_reserved()/2**30})
            if args.command == 'canary-resume':
                require(result['completed_optimizer_steps'] == 3 and result['epoch_completed'], 'Canary resume incomplete')
                step2 = read_json(work / 'canary/checkpoints/step-000000002/CHECKPOINT.json')
                step3 = read_json(work / 'canary/checkpoints/step-000000003/CHECKPOINT.json')
                require(step2['adapter_parameters_sha256'] != step3['adapter_parameters_sha256'], 'Resumed optimizer step did not change adapter')
                paths = ['canary/RUN.json', 'canary/TRAINING_RESULT.json', 'canary_execution.json', 'canary-resume_execution.json',
                         'canary/checkpoints/step-000000002/CHECKPOINT.json', 'canary/checkpoints/step-000000003/CHECKPOINT.json', 'canary/train.jsonl']
                report = {'schema_version': 'malssi.stage1-readiness.v1', 'mode': 'optimizer_canary', 'status': 'passed',
                          'optimizer_steps': 3, 'bindings': bound, 'checks': [
                          {'name': 'weights_updated', 'passed': True, 'evidence': {'before': before, 'after': after}},
                          {'name': 'checkpoint_saved', 'passed': True, 'evidence': {'checkpoint': result['checkpoint']}},
                          {'name': 'checkpoint_resumed', 'passed': True, 'evidence': {'step2_manifest_sha256': restored_manifest_sha, 'step2_adapter_sha256': step2['adapter_parameters_sha256'], 'step3_adapter_sha256': step3['adapter_parameters_sha256'], 'resumed_in_separate_process': True}},
                          {'name': 'length_4096', 'passed': True, 'evidence': {'max_length': longest[0]['sequence_length'], 'microbatch_size': 1, 'accumulation_steps': 8}}],
                          'artifacts': {p: sha_file(work/p) for p in paths}, 'hop_readiness': False}
                write_json(work / 'canary_gate.json', report); validate_canary(work, bound)
            return 0
        train_dir = beneath(work / 'training', work)
        total_steps = math.ceil(len(rows['train']) / config['gradient_accumulation_steps'])
        warmup = math.ceil(total_steps * config['warmup_ratio'])
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: step/max(1, warmup) if step < warmup else .5*(1+math.cos(math.pi*min(1, (step-warmup)/max(1,total_steps-warmup)))))
        if args.command == 'train':
            require(not train_dir.exists(), 'Existing training output; use resume')
            # B0 is measured on exactly the same held-out rows and target-token weighting as B1.
            baseline = evaluate(model, rows['validation'], pad_id=tokenizer.pad_token_id)
            write_json(work / 'validation_B0.json', {'bindings': bound, 'evaluation': baseline, 'model': 'base_plus_zero_initialized_lora'})
        if args.command == 'evaluate':
            completed = read_json(train_dir / 'TRAINING_RESULT.json')
            require(completed['epoch_completed'] is True and completed['completed_optimizer_steps'] == total_steps, 'Evaluation-only requires a completed epoch')
        result = run_training(model, optimizer, rows['train'], train_dir, pad_id=tokenizer.pad_token_id, bindings=bound,
                              scheduler=scheduler, resume_from=None if args.command == 'train' else 'latest')
        require(result['epoch_completed'], 'Full epoch incomplete')
        final = evaluate(model, rows['validation'], pad_id=tokenizer.pad_token_id)
        baseline = read_json(work / 'validation_B0.json')
        require(baseline['bindings'] == bound, 'Baseline identity mismatch')
        write_json(work / 'validation_B1.json', {'bindings': bound, 'evaluation': final,
                   'delta_target_mean_loss': final['target_mean_loss']-baseline['evaluation']['target_mean_loss'],
                   'checkpoint': result['checkpoint'], 'hop_readiness': False})
        tokenizer.save_pretrained(train_dir / 'tokenizer')
        write_json(work / 'COMPLETE.json', {'status': 'stage1_epoch_completed', 'bindings': bound, 'training': result,
                   'baseline': baseline['evaluation'], 'final': final, 'hop_deployment_ready': False})
        return 0
    finally:
        lock.close()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        traceback.print_exc()
        raise SystemExit(1)
