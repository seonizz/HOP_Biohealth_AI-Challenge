#!/usr/bin/env python3
"""Read-only checkpoint-100 evaluation on the already fixed 32-row sample."""
import argparse
from contextlib import contextmanager
import csv
import importlib.util
import io
from itertools import islice
import json
import math
import os
from pathlib import Path
import sys
from types import SimpleNamespace

DRIVER = Path(__file__).resolve()
EARLY_DRIVER_SHA256 = '1f86d192f23c7d32e97834bd22ddc2bce4582f9ad7ea7bd6bd3f971b07c284ba'
STEP, CURSOR = 100, 800


def load_early(path):
    import hashlib
    path = path.absolute()
    if path != path.resolve() or hashlib.sha256(path.read_bytes()).hexdigest() != EARLY_DRIVER_SHA256:
        raise ValueError('Original early driver path/hash changed')
    spec = importlib.util.spec_from_file_location('checkpoint100_original_early_driver', path)
    early = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(early)
    return early


@contextmanager
def readonly_training_locks(work):
    """Coordinate with both existing drivers without creating/changing lock files."""
    import fcntl
    handles = []
    try:
        for path in (work / 'early/.driver.lock', work / 'training/.runtime.lock'):
            if path != path.resolve():
                raise ValueError('Training lock path traverses a symlink')
            handle = path.open('rb')
            handles.append(handle)
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        for handle in reversed(handles):
            handle.close()


def protected_snapshot(context):
    """Every existing training file and original early result stays immutable."""
    early, work = context.early, context.work
    paths = list((work / 'training').rglob('*')) + list((work / 'early').rglob('*'))
    paths += [work / 'early_result.json', work / 'early_result.csv']
    early.require(all(not path.is_symlink() for path in paths), 'Protected evidence contains a symlink')
    return {str(path.relative_to(work)): early.file_sha(path) for path in paths if path.is_file()}


def fixed_sample(context):
    early = context.early
    original = context.original
    cache = early.read_json(context.work / 'tokens/manifest.json')
    early.require(cache['bindings'] == context.bound, 'Sample token-cache bindings changed')
    expected = early.sample_manifest(context.rows['validation'], context.bound,
                                     cache['files']['validation.jsonl.gz']['sha256'])
    early.require(early.read_json(original.private / 'sample.private.json') == expected,
                  'The originally fixed validation sample changed')
    original.sample = expected
    original.sample_rows = [context.rows['validation'][item['index']] for item in expected['selection']]
    return expected, original.sample_rows


def training_accounting(context, *, step=STEP):
    early = context.early
    run = early.read_json(context.work / 'training/RUN.json')
    order = run['plan']['order']
    early.require(len(context.rows['train']) == early.TRAIN_ROWS and len(order) == early.TRAIN_ROWS
                  and sorted(order) == list(range(early.TRAIN_ROWS)), 'Full source training order changed')
    # A resumed trainer may be appending a later line during CPU-only recovery.
    # Only this immutable prefix belongs to the requested checkpoint.
    with (context.work / 'training/train.jsonl').open() as stream:
        records = [json.loads(line) for line in islice(stream, step)]
    early.require(len(records) == step and [item['step'] for item in records] == list(range(1, step + 1)),
                  'Training log is missing or duplicates optimizer updates')
    chosen = records[:step]
    for index, record in enumerate(chosen):
        window = order[index * 8:(index + 1) * 8]
        early.require(record['mode'] == 'train' and record['microbatches'] == 8
                      and record['next_row_cursor'] == (index + 1) * 8
                      and record['supervised_tokens'] == sum(context.rows['train'][i]['target_length'] for i in window)
                      and type(record['elapsed_seconds']) in (int, float)
                      and math.isfinite(record['elapsed_seconds']) and record['elapsed_seconds'] >= 0,
                      'Training log window/token/timing accounting changed')
    selected = [context.rows['train'][index] for index in order[:step * 8]]
    return {'rows': len(selected), 'input_tokens': sum(row['sequence_length'] for row in selected),
            'supervised_tokens': sum(row['target_length'] for row in selected),
            'logged_seconds': sum(record['elapsed_seconds'] for record in chosen),
            'log_prefix_sha256': early.digest(chosen)}


def previous_evidence(context):
    early, original = context.early, context.original
    early.require_early_complete(original)
    baseline = early.verify_record(original, original.private / 'mini_B0.json', original.sample)
    at16 = early.verify_record(original, original.private / 'mini_B1.json', original.sample)
    for value in (baseline, at16):
        early.verify_evaluation(value['evaluation'], original.sample_rows)
        early.require(type(value['elapsed_seconds']) in (int, float)
                      and math.isfinite(value['elapsed_seconds']) and value['elapsed_seconds'] >= 0,
                      'Original evaluation timing changed')
    _, _, checkpoint16 = early.checkpoint_evidence(original, 16, 128)
    early.require(at16['checkpoint_manifest_sha256'] == checkpoint16['checkpoint_manifest_sha256'],
                  'Original step-16 evaluation checkpoint changed')
    counts16 = training_accounting(context, step=16)
    expected = early.public_early_report(original.sample, counts16, baseline, at16, checkpoint16, counts16['logged_seconds'])
    early.require(early.read_json(context.work / 'early_result.json') == expected,
                  'Original public comparison disagrees with its bound baseline/results')
    sources = {str(path.relative_to(context.work)): early.file_sha(path) for path in (
        original.private / 'sample.private.json', original.private / 'mini_B0.json',
        original.private / 'mini_B1.json', original.private / 'early_complete.json',
        context.work / 'early_result.json', context.work / 'early_result.csv')}
    return baseline, at16, sources


def expected_run(context, model, optimizer, scheduler, tokenizer):
    """Reconstruct the bound loop's initial RUN contract before state restore."""
    early, loop, config = context.early, context.api.loop, context.config
    early.require(all(group['lr'] == 0 for group in optimizer.param_groups), 'Original warmup must start at LR zero')
    run = {'schema_version': 1, 'output_directory': str(context.work / 'training'), 'mode': 'train',
           'bindings': context.bound,
           'plan': loop.make_plan(context.rows['train'], pad_id=tokenizer.pad_token_id,
                                  max_length=config['max_length'], accumulation_steps=config['gradient_accumulation_steps'],
                                  seed=config['seed'], shuffle=True),
           'optimizer': loop._optimizer_signature(model, optimizer), 'scheduler_class': type(scheduler).__qualname__,
           'settings': {'pad_id': tokenizer.pad_token_id, 'max_length': config['max_length'],
                        'accumulation_steps': config['gradient_accumulation_steps'], 'seed': config['seed'],
                        'shuffle': True, 'epochs': 1, 'microbatch_size': 1, 'clip_grad_norm': 1.0}}
    run = json.loads(early.canonical(run))
    early.require(early.read_json(context.work / 'training/RUN.json') == run,
                  'Original full training RUN/optimizer/scheduler contract changed')
    return run


def restore_exact_checkpoint(context, model, optimizer, scheduler, run, checkpoint, *, restore_adapter=None):
    early, loop = context.early, context.api.loop
    manifest = early.read_json(checkpoint / 'CHECKPOINT.json')
    early.require(checkpoint.name == 'step-000000100' and type(manifest['step']) is int
                  and manifest['step'] == STEP and type(manifest['cursor']) is int and manifest['cursor'] == CURSOR,
                  'Evaluation requires exactly checkpoint 100 and cursor 800')
    step, cursor, restored = loop._load_checkpoint(model, optimizer, scheduler, context.work / 'training',
                                                  run, str(checkpoint), restore_adapter)
    early.require((step, cursor, restored) == (STEP, CURSOR, checkpoint), 'Restored checkpoint is not exactly step 100')
    early.require(loop._parameter_sha(model) == manifest['adapter_parameters_sha256'], 'Restored adapter hash differs')
    return manifest


def comparison(loss, reference):
    return {'delta_nll': loss - reference, 'relative_change_percent': 100 * (loss - reference) / reference if reference else None}


def public_report(context, evaluation, elapsed, baseline, at16, checkpoint, counts, sources):
    early = context.early
    loss = evaluation['target_mean_loss']
    b0, b16 = baseline['evaluation']['target_mean_loss'], at16['evaluation']['target_mean_loss']
    return {'schema_version': 'malssi.checkpoint100-result.v1', 'status': 'checkpoint100_evaluation_completed',
            'bindings': context.bound, 'evaluation_driver_sha256': context.driver_sha,
            'original_early_driver_sha256': EARLY_DRIVER_SHA256, 'source_result_sha256': sources,
            'sample_sha256': context.original.sample['sample_sha256'],
            'sample_source_sha256': context.original.sample['source_sha256'],
            'seed': early.SEED, 'validation_rows': 32, 'validation_population_rows': early.VALIDATION_ROWS,
            'validation_target_tokens': evaluation['supervised_tokens'], 'weighting': evaluation['weighting'],
            'sampling': 'Same fixed eight rows from each sequence-length rank quartile selected before mini B0',
            'optimizer_steps_evaluated': STEP, 'full_epoch_optimizer_steps': early.TOTAL_STEPS,
            'warmup_steps': early.WARMUP_STEPS, 'training_rows_completed_at_checkpoint': counts['rows'],
            'full_epoch_training_rows': early.TRAIN_ROWS, 'training_input_tokens': counts['input_tokens'],
            'training_prompt_tokens': counts['input_tokens'] - counts['supervised_tokens'],
            'training_target_tokens': counts['supervised_tokens'],
            'token_count_convention': 'Input tokens count prompt plus supervised response tokens',
            'mini_B0_nll': b0, 'checkpoint16_nll': b16, 'checkpoint100_nll': loss,
            'versus_base': comparison(loss, b0), 'versus_checkpoint16': comparison(loss, b16),
            'relative_change_denominator': 'The corresponding reference NLL; negative values mean lower NLL',
            'timing_seconds': {'training_logged_steps_1_to_100': counts['logged_seconds'], 'evaluation': elapsed},
            'timing_scope': 'Training log times exclude checkpoint saves; evaluation includes adapter hash checks',
            'checkpoint': checkpoint, 'optimizer_updates_during_evaluation': 0, 'adapter_unchanged': True,
            'training_files_unchanged': True, 'epoch_completed': False, 'independent_test': False,
            'behavioral_quality_verified': False, 'hop_deployment_ready': False,
            'limitations': ['Only the same 32 validation rows; repeated validation is not an independent test',
                            'Checkpoint 100 is within warmup 152 and is an interim result of the original 5052-step epoch',
                            'No behavioral or clinical quality claim; full training and full validation remain separate']}


def measurement_identity(context, checkpoint, counts, sources):
    return {'bindings': context.bound, 'evaluation_driver_sha256': context.driver_sha,
            'original_early_driver_sha256': EARLY_DRIVER_SHA256,
            'sample_sha256': context.original.sample['sample_sha256'],
            'sample_source_sha256': context.original.sample['source_sha256'],
            'run_file_sha256': context.early.file_sha(context.work / 'training/RUN.json'),
            'checkpoint': checkpoint, 'training_accounting': counts, 'source_result_sha256': sources}


def save_measurement(context, report, checkpoint, counts, sources):
    context.early.save_once(context.private / 'MEASUREMENT.json', {
        'schema_version': 'malssi.checkpoint100-measurement.v1',
        'identity': measurement_identity(context, checkpoint, counts, sources), 'report': report})


def recover_measurement(context, baseline, at16, checkpoint, counts, sources):
    """Validate the immutable measurement and repair publication without a GPU."""
    early = context.early
    path = context.private / 'MEASUREMENT.json'
    if not path.exists():
        early.require(not (context.private / 'RESULT_MANIFEST.json').exists(), 'Published result lost its immutable measurement')
        return False
    saved = early.read_json(path)
    early.require(saved['schema_version'] == 'malssi.checkpoint100-measurement.v1'
                  and saved['identity'] == measurement_identity(context, checkpoint, counts, sources),
                  'Saved checkpoint-100 measurement inputs changed')
    report = saved['report']
    evaluation = {'rows': report['validation_rows'], 'supervised_tokens': report['validation_target_tokens'],
                  'target_mean_loss': report['checkpoint100_nll'], 'weighting': report['weighting'],
                  'behavioral_quality_verified': report['behavioral_quality_verified']}
    early.verify_evaluation(evaluation, context.original.sample_rows)
    elapsed = report['timing_seconds']['evaluation']
    early.require(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed >= 0,
                  'Saved checkpoint-100 evaluation timing is invalid')
    expected = public_report(context, evaluation, elapsed, baseline, at16, checkpoint, counts, sources)
    early.require(report == expected, 'Saved checkpoint-100 measurement/report mismatch')
    publish(context, report)
    return True


def publish(context, report):
    early = context.early
    json_path, csv_path = context.work / 'checkpoint100_result.json', context.work / 'checkpoint100_result.csv'
    early.save_once(json_path, report)
    flat = {key: value for key, value in report.items() if not isinstance(value, (dict, list))}
    flat.update(delta_nll_vs_base=report['versus_base']['delta_nll'],
                relative_change_percent_vs_base=report['versus_base']['relative_change_percent'],
                delta_nll_vs_checkpoint16=report['versus_checkpoint16']['delta_nll'],
                relative_change_percent_vs_checkpoint16=report['versus_checkpoint16']['relative_change_percent'],
                training_logged_seconds=report['timing_seconds']['training_logged_steps_1_to_100'],
                evaluation_seconds=report['timing_seconds']['evaluation'],
                checkpoint_manifest_sha256=report['checkpoint']['checkpoint_manifest_sha256'],
                adapter_parameters_sha256=report['checkpoint']['adapter_parameters_sha256'],
                checkpoint_file_sha256_json=early.canonical(report['checkpoint']['checkpoint_file_sha256']).decode(),
                source_result_sha256_json=early.canonical(report['source_result_sha256']).decode())
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=tuple(sorted(flat)))
    writer.writeheader(); writer.writerow(flat)
    data = stream.getvalue().encode()
    if csv_path.exists():
        early.require(csv_path.read_bytes() == data, 'Existing checkpoint-100 CSV differs')
    else:
        temporary = csv_path.with_suffix('.csv.tmp')
        with temporary.open('wb') as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        temporary.replace(csv_path)
    # The sidecar binds result hashes without a self-referential result digest.
    early.save_once(context.private / 'RESULT_MANIFEST.json', {
        'schema_version': 'malssi.checkpoint100-artifacts.v1', 'bindings': context.bound,
        'evaluation_driver_sha256': context.driver_sha, 'original_early_driver_sha256': EARLY_DRIVER_SHA256,
        'sample_sha256': context.original.sample['sample_sha256'],
        'measurement_sha256': early.file_sha(context.private / 'MEASUREMENT.json'),
        'artifacts': {path.name: early.file_sha(path) for path in (json_path, csv_path)}})


def run_evaluation(context, model, tokenizer, checkpoint, evidence, baseline, at16, counts, sources):
    early, loop = context.early, context.api.loop
    optimizer = context.api.cli.optimizer_for(model, context.config)
    scheduler = early.scheduler_for(optimizer, context.config)
    run = expected_run(context, model, optimizer, scheduler, tokenizer)
    manifest = restore_exact_checkpoint(context, model, optimizer, scheduler, run, checkpoint)
    before = loop._parameter_sha(model)
    early.status(context, 'evaluate_exact_checkpoint100')
    value, elapsed, evaluated_hash = early.evaluate(context, model, tokenizer, context.original.sample_rows)
    early.require(before == evaluated_hash == loop._parameter_sha(model) == manifest['adapter_parameters_sha256'],
                  'Checkpoint-100 evaluation changed adapter parameters')
    return public_report(context, value, elapsed, baseline, at16,
                         {**evidence, 'adapter_parameters_sha256': before}, counts, sources)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kit', type=Path, required=True)
    parser.add_argument('--early-driver', type=Path, default=DRIVER.with_name('early_training_driver.py'))
    args = parser.parse_args(argv)
    os.umask(0o077)
    early = load_early(args.early_driver)
    kit = args.kit.absolute()
    early.require(kit == kit.resolve(), 'Kit path must not traverse symlinks')
    api = early.load_api(kit)
    api.prep.verify_bundle(kit)
    config = api.prep.load_config(kit)
    early.require(config['max_length'] == 25316 and config['layer_split'] == 28 and config['unsloth_tiled_mlp'] is True,
                  'Final complete-source model configuration changed')
    bound = api.prep.bindings(kit, config)
    work = api.prep.configure_environment(kit, config)
    original = SimpleNamespace(api=api, work=work, private=work / 'early', config=config,
                               bound=bound, driver_sha=EARLY_DRIVER_SHA256)
    context = SimpleNamespace(early=early, api=api, work=work, private=api.prep.beneath(work / 'checkpoint100_evaluation', work),
                              config=config, bound=bound, original=original, driver_sha=early.file_sha(DRIVER),
                              command='checkpoint100-evaluation')
    with early.driver_lock(context.private):
        try:
            early.status(context, 'verify_fixed_sample_and_baselines')
            context.rows = api.prep.load_tokens(kit, bound)
            early.require(len(context.rows['train']) == early.TRAIN_ROWS and len(context.rows['validation']) == early.VALIDATION_ROWS,
                          'Complete source rows are required')
            fixed_sample(context)
            baseline, at16, sources = previous_evidence(context)
            checkpoint, manifest, evidence = early.checkpoint_evidence(original, STEP, CURSOR)
            evidence = {**evidence, 'adapter_parameters_sha256': manifest['adapter_parameters_sha256']}
            counts = training_accounting(context)
            api.cli.validate_preparation(work, bound)
            api.cli.validate_canary(work, bound)
            api.prep.verify_environment(kit, config)
            # Recovery requires only immutable checkpoint-100 inputs, so a later
            # training process may keep its runtime/GPU locks and add checkpoints.
            if recover_measurement(context, baseline, at16, evidence, counts, sources):
                early.status(context, 'checkpoint100_report_recovered', 'completed')
                return 0
            with readonly_training_locks(work):
                protected = protected_snapshot(context)
                lock = api.prep.gpu_lock(work)
                try:
                    early.status(context, 'load_fresh_model_then_restore100')
                    model, tokenizer = api.prep.load_model(config)
                    report = run_evaluation(context, model, tokenizer, checkpoint, evidence, baseline, at16, counts, sources)
                finally:
                    lock.close()
                    early.require(protected_snapshot(context) == protected, 'Evaluation changed protected training/early files')
                save_measurement(context, report, evidence, counts, sources)
            publish(context, report)
            early.status(context, 'checkpoint100_report_durable', 'completed')
            return 0
        except BaseException:
            early.status(context, 'failed', 'failed')
            raise


if __name__ == '__main__':
    raise SystemExit(main())
