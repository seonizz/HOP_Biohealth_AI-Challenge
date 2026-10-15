#!/usr/bin/env python3
"""Early 32-row comparison, followed by the unchanged complete source-SFT epoch.

This external driver does not edit the bound training kit, its configuration,
source data, token cache, qualification, or canary. Full baseline evaluation is
deferred until the epoch and full trained-model evaluation have finished.
"""
import argparse
from contextlib import contextmanager
import csv
import datetime as dt
import hashlib
import importlib
import io
import json
import math
import os
from pathlib import Path
import random
import sys
import time
from types import SimpleNamespace

DRIVER = Path(__file__).resolve()
SEED, SAMPLE_ROWS, EARLY_STEPS = 3407, 32, 16
TRAIN_ROWS, VALIDATION_ROWS, ACCUMULATION = 40415, 4298, 8
TOTAL_STEPS, WARMUP_STEPS = 5052, 152


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def file_sha(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def save_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(canonical(value) + b'\n')
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)


def save_once(path, value):
    if path.exists():
        require(read_json(path) == value, 'Existing evidence differs; preserve it before recovery')
    else:
        save_json(path, value)


@contextmanager
def driver_lock(directory):
    import fcntl
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / '.driver.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def status(context, phase, state='running'):
    value = {'stage': context.command, 'phase': phase, 'status': state,
             'utc': dt.datetime.now(dt.timezone.utc).isoformat(), 'pid': os.getpid(),
             'driver_sha256': context.driver_sha, 'bindings': context.bound}
    save_json(context.private / 'driver_status.json', value)
    print(json.dumps({'event': 'early_driver_phase', 'stage': context.command,
                      'phase': phase, 'status': state}), flush=True)


def sample_manifest(rows, bound, validation_cache_sha256):
    """Eight seeded rows from each rank quartile, chosen without predictions."""
    require(len(rows) == VALIDATION_ROWS, 'Expected all 4298 validation rows')
    require(len({row['id'] for row in rows}) == len(rows), 'Duplicate validation identities')
    ranked = sorted(range(len(rows)), key=lambda index: (rows[index]['sequence_length'], rows[index]['id']))
    rng = random.Random(SEED)
    selected, strata = [], []
    for quartile in range(4):
        start, stop = quartile * len(rows) // 4, (quartile + 1) * len(rows) // 4
        ranks = sorted(rng.sample(range(start, stop), SAMPLE_ROWS // 4))
        selected.extend(ranked[rank] for rank in ranks)
        strata.append({'quartile': quartile + 1, 'population_rows': stop - start, 'sample_rows': 8,
                       'minimum_length': rows[ranked[start]]['sequence_length'],
                       'maximum_length': rows[ranked[stop - 1]]['sequence_length']})
    payload = {'schema_version': 'malssi.early-sample.v1', 'bindings': bound,
               'source_sha256': digest({'dataset_sha256': bound['dataset_sha256'],
                                        'validation_cache_sha256': validation_cache_sha256,
                                        'validation_rows': len(rows)}),
               'seed': SEED, 'method': 'sequence_length_rank_quartiles_eight_without_replacement',
               'selected_before_predictions': True, 'population_rows': len(rows), 'sample_rows': SAMPLE_ROWS,
               'strata': strata, 'selection': [
                   {'index': index, 'id': rows[index]['id'], 'encoded_row_sha256': digest(rows[index]),
                    'sequence_length': rows[index]['sequence_length'], 'target_length': rows[index]['target_length']}
                   for index in selected]}
    return {**payload, 'sample_sha256': digest(payload)}


def ensure_sample(context):
    cache = context.api.prep.read_json(context.work / 'tokens/manifest.json')
    require(cache['bindings'] == context.bound, 'Token cache bindings changed')
    expected = sample_manifest(context.rows['validation'], context.bound,
                               cache['files']['validation.jsonl.gz']['sha256'])
    path = context.private / 'sample.private.json'
    if not path.exists():
        require(context.command in ('select-sample', 'early'), 'The fixed sample must be selected first')
        require(not (context.work / 'training/RUN.json').exists()
                and not any((context.private / name).exists() for name in ('mini_B0.json', 'mini_B1.json')),
                'Cannot choose a sample after early predictions or training')
    save_once(path, expected)
    return expected, [context.rows['validation'][item['index']] for item in expected['selection']]


def scheduler_for(optimizer, config, total_rows=TRAIN_ROWS):
    """Identical LambdaLR initialization and full-epoch schedule to the bound CLI."""
    import torch
    total_steps = math.ceil(total_rows / config['gradient_accumulation_steps'])
    warmup = math.ceil(total_steps * config['warmup_ratio'])
    require((total_steps, warmup) == (TOTAL_STEPS, WARMUP_STEPS), 'Full-epoch schedule changed')
    return torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: step/max(1, warmup) if step < warmup else
        .5*(1+math.cos(math.pi*min(1, (step-warmup)/max(1,total_steps-warmup)))))


def training_kwargs(context, tokenizer, model, scheduler, *, early):
    return {'pad_id': tokenizer.pad_token_id, 'bindings': context.bound,
            'max_length': context.config['max_length'],
            'accumulation_steps': context.config['gradient_accumulation_steps'],
            'seed': context.config['seed'], 'checkpoint_every': context.config['checkpoint_every'],
            'device': model.get_input_embeddings().weight.device, 'scheduler': scheduler,
            'max_steps': EARLY_STEPS if early else None,
            'resume_from': 'latest' if (context.work / 'training/RUN.json').exists() else None}


def verify_evaluation(value, rows):
    require(value['rows'] == len(rows) and value['supervised_tokens'] == sum(row['target_length'] for row in rows)
            and value['weighting'] == 'shifted_nonignored_target_tokens'
            and value['behavioral_quality_verified'] is False
            and type(value['target_mean_loss']) in (int, float)
            and math.isfinite(value['target_mean_loss']) and value['target_mean_loss'] >= 0,
            'Evaluation accounting or finite target NLL failed')


def evaluate(context, model, tokenizer, rows):
    started = time.monotonic()
    before = context.api.loop._parameter_sha(model)
    value = context.api.loop.evaluate(model, rows, pad_id=tokenizer.pad_token_id,
                                     max_length=context.config['max_length'],
                                     device=model.get_input_embeddings().weight.device)
    require(context.api.loop._parameter_sha(model) == before, 'Evaluation changed adapter parameters')
    verify_evaluation(value, rows)
    return value, time.monotonic() - started, before


def fresh_base_hash(context, model):
    import torch
    values = [parameter for name, parameter in model.named_parameters()
              if parameter.requires_grad and 'lora_B' in name]
    require(values and all(int(torch.count_nonzero(value)) == 0 for value in values),
            'Baseline requires freshly zero-initialized LoRA B weights')
    return context.api.loop._parameter_sha(model)


def identity(context, sample=None):
    value = {'bindings': context.bound, 'driver_sha256': context.driver_sha}
    if sample is not None:
        value.update(sample_sha256=sample['sample_sha256'], sample_source_sha256=sample['source_sha256'])
    return value


def verify_record(context, path, sample=None):
    value = read_json(path)
    require(all(value.get(key) == expected for key, expected in identity(context, sample).items()),
            'Saved early evidence identity changed')
    return value


def checkpoint_evidence(context, step, cursor):
    root = context.work / 'training'
    checkpoint = root / 'checkpoints' / ('step-%09d' % step)
    require(checkpoint == checkpoint.resolve() and checkpoint.is_dir(), 'Missing/unsafe committed checkpoint')
    manifest = read_json(checkpoint / 'CHECKPOINT.json')
    run = read_json(root / 'RUN.json')
    require(run['bindings'] == context.bound and run['mode'] == 'train'
            and run['plan']['rows'] == TRAIN_ROWS and run['plan']['optimizer_steps'] == TOTAL_STEPS
            and run['settings']['seed'] == SEED and run['settings']['accumulation_steps'] == ACCUMULATION
            and run['settings']['shuffle'] is True and run['settings']['max_length'] == context.config['max_length'],
            'Checkpoint is not part of the original complete training plan')
    require(manifest['step'] == step and manifest['cursor'] == cursor
            and manifest['run_sha256'] == context.api.loop._sha(run), 'Checkpoint progress/run binding mismatch')
    context.api.cli.verify_artifact_hashes(checkpoint, manifest['files'])
    actual = {str(path.relative_to(checkpoint)) for path in checkpoint.rglob('*')
              if path.is_file() and path.name != 'CHECKPOINT.json'}
    require(actual == set(manifest['files']), 'Checkpoint file inventory changed')
    return checkpoint, manifest, {'step': step, 'cursor': cursor,
                                  'checkpoint_manifest_sha256': file_sha(checkpoint / 'CHECKPOINT.json'),
                                  'checkpoint_file_sha256': manifest['files']}


def early_training_counts(rows):
    require(len(rows) == TRAIN_ROWS, 'Early training must use every source row')
    order = list(range(len(rows)))
    random.Random(SEED).shuffle(order)
    first = [rows[index] for index in order[:EARLY_STEPS * ACCUMULATION]]
    return {'rows': len(first), 'input_tokens': sum(row['sequence_length'] for row in first),
            'supervised_tokens': sum(row['target_length'] for row in first)}


def public_early_report(sample, counts, baseline, final, checkpoint, step_seconds):
    b0, b1 = baseline['evaluation']['target_mean_loss'], final['evaluation']['target_mean_loss']
    return {'schema_version': 'malssi.early-result.v1', 'status': 'early_comparison_completed',
            'sample_sha256': sample['sample_sha256'], 'sample_source_sha256': sample['source_sha256'],
            'seed': SEED, 'validation_rows': SAMPLE_ROWS, 'validation_population_rows': VALIDATION_ROWS,
            'validation_target_tokens': baseline['evaluation']['supervised_tokens'],
            'sampling': 'Eight rows from each sequence-length rank quartile, fixed before predictions',
            'optimizer_steps_completed': EARLY_STEPS, 'full_epoch_optimizer_steps': TOTAL_STEPS,
            'warmup_steps': WARMUP_STEPS, 'training_rows_completed': counts['rows'],
            'full_epoch_training_rows': TRAIN_ROWS, 'training_input_tokens': counts['input_tokens'],
            'training_target_tokens': counts['supervised_tokens'],
            'training_prompt_tokens': counts['input_tokens'] - counts['supervised_tokens'],
            'token_count_convention': 'Input tokens count the complete tokenized sequence, including supervised response tokens',
            'mini_B0_nll': b0, 'mini_B1_nll': b1, 'delta_nll_B1_minus_B0': b1 - b0,
            'relative_change_percent': 100 * (b1 - b0) / b0 if b0 else None,
            'relative_change_denominator': 'mini_B0_nll', 'weighting': 'shifted_nonignored_target_tokens',
            'timing_seconds': {'mini_B0': baseline['elapsed_seconds'], 'training_logged_steps': step_seconds,
                               'mini_B1': final['elapsed_seconds']},
            'timing_scope': 'Evaluation includes adapter-immutability checks; step timings exclude checkpoint saves',
            'checkpoint': checkpoint, 'epoch_completed': False, 'independent_test': False,
            'behavioral_quality_verified': False, 'hop_deployment_ready': False,
            'limitations': ['Only 32 held-out rows and the first 16 updates of the original full-epoch schedule',
                            'No independent test or behavioral/clinical quality claim',
                            'Full validation B0/B1 and the remaining original training epoch are still pending']}


def publish_early(context, report):
    path = context.work / 'early_result.json'
    save_once(path, report)
    fields = ('sample_sha256', 'sample_source_sha256', 'seed', 'validation_rows', 'validation_target_tokens',
              'optimizer_steps_completed', 'full_epoch_optimizer_steps', 'training_rows_completed',
              'training_input_tokens', 'training_prompt_tokens', 'training_target_tokens', 'mini_B0_nll', 'mini_B1_nll',
              'delta_nll_B1_minus_B0', 'relative_change_percent', 'epoch_completed', 'hop_deployment_ready',
              'mini_B0_seconds', 'training_logged_steps_seconds', 'mini_B1_seconds',
              'checkpoint_manifest_sha256', 'checkpoint_file_sha256_json')
    flat = {**report, 'mini_B0_seconds': report['timing_seconds']['mini_B0'],
            'training_logged_steps_seconds': report['timing_seconds']['training_logged_steps'],
            'mini_B1_seconds': report['timing_seconds']['mini_B1'],
            'checkpoint_manifest_sha256': report['checkpoint']['checkpoint_manifest_sha256'],
            'checkpoint_file_sha256_json': canonical(report['checkpoint']['checkpoint_file_sha256']).decode()}
    data = io.StringIO(newline='')
    writer = csv.DictWriter(data, fieldnames=fields)
    writer.writeheader(); writer.writerow({key: flat[key] for key in fields})
    destination = context.work / 'early_result.csv'
    if destination.exists():
        require(destination.read_text() == data.getvalue().replace('\r\n', '\n'), 'Existing public CSV changed')
    else:
        temporary = destination.with_name(destination.name + '.tmp')
        with temporary.open('w', newline='') as stream:
            stream.write(data.getvalue()); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(destination)
    # Completion marker is written only after both public artifacts are durable.
    save_once(context.private / 'early_complete.json', {**identity(context, context.sample),
              'optimizer_steps': EARLY_STEPS, 'json_sha256': file_sha(path), 'csv_sha256': file_sha(destination)})


def require_early_complete(context):
    marker = verify_record(context, context.private / 'early_complete.json', context.sample)
    require(marker['optimizer_steps'] == EARLY_STEPS
            and marker['json_sha256'] == file_sha(context.work / 'early_result.json')
            and marker['csv_sha256'] == file_sha(context.work / 'early_result.csv'),
            'The durable early public comparison must exist before continuing')


def run_early(context, model, tokenizer):
    base = fresh_base_hash(context, model)
    baseline_path = context.private / 'mini_B0.json'
    if baseline_path.exists():
        baseline = verify_record(context, baseline_path, context.sample)
        require(baseline['base_adapter_sha256'] == base, 'Fresh baseline adapter differs from mini B0')
        verify_evaluation(baseline['evaluation'], context.sample_rows)
    else:
        require(not (context.work / 'training/RUN.json').exists(), 'Mini B0 must precede this training run')
        status(context, 'mini_B0')
        value, elapsed, observed_base = evaluate(context, model, tokenizer, context.sample_rows)
        require(observed_base == base, 'Fresh baseline adapter changed')
        baseline = {**identity(context, context.sample), 'evaluation': value,
                    'elapsed_seconds': elapsed, 'base_adapter_sha256': base}
        save_once(baseline_path, baseline)
    optimizer = context.api.cli.optimizer_for(model, context.config)
    scheduler = scheduler_for(optimizer, context.config)
    require(all(group['lr'] == 0 for group in optimizer.param_groups), 'Original warmup must initialize LR at zero')
    status(context, 'early_16_training')
    result = context.api.loop.run_training(model, optimizer, context.rows['train'], context.work / 'training',
                                          **training_kwargs(context, tokenizer, model, scheduler, early=True))
    require(result['completed_optimizer_steps'] == EARLY_STEPS and result['next_row_cursor'] == 128
            and result['epoch_completed'] is False, 'Early cap changed the complete-epoch plan')
    _, manifest, checkpoint = checkpoint_evidence(context, EARLY_STEPS, 128)
    require(context.api.loop._parameter_sha(model) == manifest['adapter_parameters_sha256'],
            'Mini B1 model differs from committed step 16')
    final_path = context.private / 'mini_B1.json'
    if final_path.exists():
        final = verify_record(context, final_path, context.sample)
        require(final['checkpoint_manifest_sha256'] == checkpoint['checkpoint_manifest_sha256'], 'Mini B1 checkpoint changed')
        verify_evaluation(final['evaluation'], context.sample_rows)
    else:
        status(context, 'mini_B1')
        value, elapsed, _ = evaluate(context, model, tokenizer, context.sample_rows)
        final = {**identity(context, context.sample), 'evaluation': value, 'elapsed_seconds': elapsed,
                 'checkpoint_manifest_sha256': checkpoint['checkpoint_manifest_sha256']}
        save_once(final_path, final)
    records = [json.loads(line) for line in (context.work / 'training/train.jsonl').read_text().splitlines()]
    require([item['step'] for item in records] == list(range(1, EARLY_STEPS + 1))
            and all(item['microbatches'] == 8 and item['next_row_cursor'] == item['step'] * 8 for item in records),
            'Early training log must cover exactly the first 16 optimizer windows')
    counts = early_training_counts(context.rows['train'])
    require(sum(item['supervised_tokens'] for item in records) == counts['supervised_tokens'], 'Early token accounting changed')
    report = public_early_report(context.sample, counts, baseline, final, checkpoint,
                                sum(item['elapsed_seconds'] for item in records))
    publish_early(context, report)
    status(context, 'early_report_durable', 'completed')


def require_full_result(context):
    result = read_json(context.work / 'training/TRAINING_RESULT.json')
    require(result['status'] == 'completed' and result['mode'] == 'train'
            and result['epoch_completed'] is True and result['completed_optimizer_steps'] == TOTAL_STEPS
            and result['next_row_cursor'] == TRAIN_ROWS and result['total_rows'] == TRAIN_ROWS,
            'The entire original epoch must complete before full evaluation finalization')
    checkpoint, manifest, evidence = checkpoint_evidence(context, TOTAL_STEPS, TRAIN_ROWS)
    require(result['checkpoint'] == str(checkpoint) and result['run_sha256'] == manifest['run_sha256'],
            'Final checkpoint path/run mismatch')
    return result, manifest, evidence


def run_continue(context, model, tokenizer):
    require_early_complete(context)
    optimizer = context.api.cli.optimizer_for(model, context.config)
    scheduler = scheduler_for(optimizer, context.config)
    require(all(group['lr'] == 0 for group in optimizer.param_groups), 'Resume RUN signature needs initial LR zero')
    kwargs = training_kwargs(context, tokenizer, model, scheduler, early=False)
    require(kwargs['resume_from'] == 'latest', 'Continue must restore the existing training run')
    status(context, 'full_training_resume')
    context.api.loop.run_training(model, optimizer, context.rows['train'], context.work / 'training', **kwargs)
    result, manifest, checkpoint = require_full_result(context)
    require(context.api.loop._parameter_sha(model) == manifest['adapter_parameters_sha256'], 'Full B1 model differs from checkpoint')
    pending_path = context.work / 'validation_B1_pending_baseline.json'
    if pending_path.exists():
        pending = verify_record(context, pending_path)
        require(pending['checkpoint_manifest_sha256'] == checkpoint['checkpoint_manifest_sha256'], 'Full B1 checkpoint changed')
        verify_evaluation(pending['evaluation'], context.rows['validation'])
    else:
        status(context, 'full_B1')
        value, elapsed, _ = evaluate(context, model, tokenizer, context.rows['validation'])
        save_once(pending_path, {**identity(context), 'evaluation': value, 'elapsed_seconds': elapsed,
                  'checkpoint': result['checkpoint'], 'checkpoint_manifest_sha256': checkpoint['checkpoint_manifest_sha256'],
                  'baseline_pending': True, 'hop_readiness': False})
    tokenizer.save_pretrained(context.work / 'training/tokenizer')
    status(context, 'full_training_and_B1_completed', 'completed')


def finalize_payloads(bound, result, baseline, pending):
    require(baseline['bindings'] == pending['bindings'] == bound
            and baseline['model'] == 'base_plus_zero_initialized_lora'
            and pending['checkpoint'] == result['checkpoint'], 'Final baseline/model/checkpoint identity mismatch')
    b1 = {'bindings': bound, 'evaluation': pending['evaluation'],
          'delta_target_mean_loss': pending['evaluation']['target_mean_loss'] - baseline['evaluation']['target_mean_loss'],
          'checkpoint': result['checkpoint'], 'hop_readiness': False}
    complete = {'status': 'stage1_epoch_completed', 'bindings': bound, 'training': result,
                'baseline': baseline['evaluation'], 'final': pending['evaluation'], 'hop_deployment_ready': False}
    return b1, complete


def run_full_baseline(context, model, tokenizer):
    require_early_complete(context)
    result, _, checkpoint = require_full_result(context)
    pending = verify_record(context, context.work / 'validation_B1_pending_baseline.json')
    require(pending['checkpoint_manifest_sha256'] == checkpoint['checkpoint_manifest_sha256'], 'Trained full B1 evidence changed')
    verify_evaluation(pending['evaluation'], context.rows['validation'])
    base = fresh_base_hash(context, model)
    mini = verify_record(context, context.private / 'mini_B0.json', context.sample)
    require(mini['base_adapter_sha256'] == base, 'Deferred B0 is not the same untrained base-plus-zero-LoRA model')
    path = context.work / 'validation_B0.json'
    if path.exists():
        baseline = verify_record(context, path)
        require(baseline['base_adapter_sha256'] == base, 'Saved full baseline model changed')
        verify_evaluation(baseline['evaluation'], context.rows['validation'])
    else:
        status(context, 'fresh_base_full_B0')
        value, elapsed, _ = evaluate(context, model, tokenizer, context.rows['validation'])
        baseline = {**identity(context), 'evaluation': value, 'elapsed_seconds': elapsed,
                    'model': 'base_plus_zero_initialized_lora', 'base_adapter_sha256': base,
                    'evaluated_after_training_on_fresh_untrained_model': True}
        save_once(path, baseline)
    status(context, 'finalize')
    b1, complete = finalize_payloads(context.bound, result, baseline, pending)
    save_once(context.work / 'validation_B1.json', b1)
    save_once(context.work / 'COMPLETE.json', complete)
    status(context, 'full_epoch_and_validation_completed', 'completed')


def load_api(kit):
    sys.path.insert(0, str(kit))
    prep = importlib.import_module('counseling_pipeline.stage1_preparation')
    cli = importlib.import_module('scripts.malssi_stage1')
    loop = importlib.import_module('counseling_pipeline.stage1_training_loop')
    require(all(Path(module.__file__).resolve().is_relative_to(kit) for module in (prep, cli, loop)),
            'Imported code does not belong to the selected bound kit')
    return SimpleNamespace(prep=prep, cli=cli, loop=loop)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('select-sample', 'early', 'continue', 'full-baseline'))
    parser.add_argument('--kit', type=Path, required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    kit = args.kit.absolute()
    require(kit == kit.resolve(), 'Kit path must not traverse symlinks')
    api = load_api(kit)
    api.prep.verify_bundle(kit)
    config = api.prep.load_config(kit)
    require(config['max_length'] == 25316 and config['layer_split'] == 28 and config['unsloth_tiled_mlp'] is True
            and config['seed'] == SEED and config['gradient_accumulation_steps'] == ACCUMULATION,
            'Early path requires the final unchanged complete-source training configuration')
    bound = api.prep.bindings(kit, config)
    work = api.prep.configure_environment(kit, config)
    private = api.prep.beneath(work / 'early', work)
    context = SimpleNamespace(command=args.command, api=api, kit=kit, work=work, private=private,
                              config=config, bound=bound, driver_sha=file_sha(DRIVER))
    with driver_lock(private):
        try:
            status(context, 'verify_inputs')
            context.rows = api.prep.load_tokens(kit, bound)
            require(len(context.rows['train']) == TRAIN_ROWS and len(context.rows['validation']) == VALIDATION_ROWS,
                    'Incomplete source dataset')
            context.sample, context.sample_rows = ensure_sample(context)
            if args.command == 'select-sample':
                status(context, 'sample_selected', 'completed')
                return 0
            api.cli.validate_preparation(work, bound)
            api.cli.validate_canary(work, bound)
            if args.command in ('continue', 'full-baseline'):
                require_early_complete(context)
            if args.command == 'full-baseline':
                require_full_result(context)
                verify_record(context, work / 'validation_B1_pending_baseline.json')
            api.prep.verify_environment(kit, config)
            lock = api.prep.gpu_lock(work)
            try:
                status(context, 'load_fresh_model')
                model, tokenizer = api.prep.load_model(config)
                {'early': run_early, 'continue': run_continue, 'full-baseline': run_full_baseline}[args.command](context, model, tokenizer)
            finally:
                lock.close()
            return 0
        except BaseException:
            status(context, 'failed', 'failed')
            raise


if __name__ == '__main__':
    raise SystemExit(main())
