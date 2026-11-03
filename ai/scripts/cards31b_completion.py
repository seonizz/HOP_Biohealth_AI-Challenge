"""CPU-only bridge from indexed-runner journals to the frozen stopping policy.

No judgments are generated here. A new run must pin actual baseline judgments
before training; each final epoch needs externally supplied role evidence.
"""
from copy import deepcopy
import argparse
import json
import math
from pathlib import Path
import shutil
import tempfile

import training_stop as stop

SCHEMA = 'malssi-cards31b-completion-config-v1'
PHASES = ['00_original_warmup', '01_card_repair', '02_card_generation']


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def checked_reference(base, reference):
    return stop.evidence_path(base, reference)


class CompletionGate:
    def __init__(self, config_path, dataset):
        self.config_path = Path(config_path).resolve(strict=True)
        self.config = read(self.config_path)
        stop.require(self.config.get('schema') == SCHEMA, 'Unsupported completion configuration')
        stop.require(isinstance(self.config.get('run_id'), str) and self.config['run_id'].strip(), 'Missing run identity')
        base = self.config_path.parent
        self.paths = {key: checked_reference(base, self.config[key]) for key in ('policy', 'suite', 'baseline')}
        self.policy, self.suite, self.baseline = (read(self.paths[k]) for k in ('policy', 'suite', 'baseline'))
        stop.validate_policy(self.policy)
        self.model = self.policy['models']['cards_31b']
        stop.require([p['id'] for p in self.model['phases']] == PHASES, 'Wrong card curriculum')
        stop.require(self.model.get('role_evaluation_binding', {}).get('development_suite_sha256') ==
                     stop.fingerprint(self.suite), 'Freeze the development suite in the policy')
        stop.require(self.suite['schema'] == 'malssi-role-evaluation-suite-v1' and
                     self.suite['model_role'] == 'cards_31b' and self.suite['split'] == 'development', 'Wrong role suite')
        self.indexes = {pid: stop.bound_indexes(self.policy, 'cards_31b', pid, dataset)[1] for pid in PHASES}
        self.lineage = stop.bound_train_lineage(self.policy, 'cards_31b', dataset)
        cases = {r['case_id']: r for r in self.suite['cases']}
        stop.require(len(cases) == len(self.suite['cases']) and cases, 'Duplicate/empty baseline suite')
        checks = set(self.model['role_acceptance']['critical_all_pass'] + self.model['role_acceptance']['quality_checks'])
        stop.require(stop.valid_hash(self.baseline.get('baseline_checkpoint_sha256')), 'Missing baseline checkpoint')
        seen = set()
        for row in self.baseline['cases']:
            key = row['case_id']
            stop.require(key in cases and key not in seen and row['input_sha256'] == cases[key]['input_sha256'],
                         'Missing/duplicate/wrong baseline case')
            stop.require(set(row['baseline']) == checks and all(type(v) is bool for v in row['baseline'].values()),
                         'Actual boolean baseline judgments required')
            seen.add(key)
        stop.require(seen == set(cases), 'Incomplete baseline judgments')
        for row in cases.values():
            stop.require(not ({row['source_family_id']} | set(row['source_lineage_ids'])) & self.lineage,
                         'Role suite overlaps training')
        stop.require(len({row['source_family_id'] for row in cases.values()}) >=
                     self.model['role_acceptance']['minimum_source_families'], 'Too few baseline source families')
        self.baseline_hash = stop.baseline_judgments_hash(self.baseline)
        self._binding = {'config_sha256': stop.file_hash(self.config_path),
                         **{key + '_sha256': stop.file_hash(path) for key, path in self.paths.items()}}

    def binding(self):
        current = {'config_sha256': stop.file_hash(self.config_path),
                   **{key + '_sha256': stop.file_hash(path) for key, path in self.paths.items()}}
        stop.require(current == self._binding, 'Frozen completion configuration changed')
        return deepcopy(self._binding)

    def assess(self, state, phase_id, work, binding, verify_checkpoint):
        """Recompute decisions from complete journals, never trust a supplied verdict."""
        work = Path(work).resolve(strict=True)
        stop.require(binding.get('completion') == self.binding(), 'Completion inputs changed')
        stop.require(binding.get('compute_profile') == 'reference', 'Completion bridge requires reference metrics')
        stop.require(binding['course_sha256'] == self.model['binding']['course_sha256'] and
                     binding['dataset_manifest_sha256'] == self.model['binding']['manifest_sha256'],
                     'Runner and completion dataset differ')
        position = PHASES.index(phase_id)
        stop.require(state['accepted'] == PHASES[:position], 'Completion phase chain differs')
        evidence_dir = work / 'completion-evidence'
        stop.require(not evidence_dir.is_symlink(), 'Completion evidence directory link')
        evidence_dir.mkdir(exist_ok=True)
        previous = None
        decisions, sources = {}, {}

        def source(path):
            path = Path(path)
            stop.require(path.is_absolute() and path == path.resolve(strict=True) and path.is_relative_to(work),
                         'Evidence must be a canonical file inside this run')
            relative = str(path.relative_to(work))
            stop.safe_path(work, relative)
            sources[relative] = stop.file_hash(path)
            return path

        def snapshot(rows):
            content = ''.join(stop.canonical(row) + '\n' for row in rows)
            path = evidence_dir / (stop.digest(content) + '.jsonl')
            if path.exists():
                stop.require(not path.is_symlink() and path.read_text() == content, 'Evidence snapshot changed')
            else:
                with path.open('x', encoding='utf-8') as handle:
                    handle.write(content)
            return {'path': str(path.relative_to(work)), 'sha256': stop.file_hash(path)}

        for pid in PHASES[:position + 1]:
            record = state['phases'][pid]
            stop.require(not record.get('use_reference_decisions'), 'Mixed evaluator records require a separate qualification')
            checkpoints = [record['baseline_checkpoint'], *record.get('epoch_checkpoints', [])]
            stop.require(len(checkpoints) == len(record['losses']) + 1, 'Checkpoint/loss inventory differs')
            events, identities = [], []
            for epoch, name in enumerate(checkpoints):
                checkpoint = Path(name)
                stop.require(checkpoint.is_relative_to(work / 'checkpoints'), 'Checkpoint outside this run')
                manifest = verify_checkpoint(checkpoint, binding)
                required_files = {'adapter_config.json', 'adapter_model.safetensors', 'training_state.pt'}
                stop.require(required_files <= set(manifest['files']) and
                             all((checkpoint / name).stat().st_size > 0 for name in required_files),
                             'Complete adapter and optimizer checkpoint files required')
                stop.require(read(checkpoint / 'adapter_config.json').get('peft_type') == 'LORA',
                             'Checkpoint is not a LoRA adapter')
                source(checkpoint / 'CHECKPOINT.json')
                progress = manifest['progress']
                stop.require(progress['phase'] == pid and progress['epoch'] == epoch and
                             progress['cursor'] == (len(self.indexes[pid]['train']) if epoch else 0),
                             'Checkpoint is not the complete epoch boundary')
                identity = manifest['adapter_sha256']
                stop.require(stop.valid_hash(identity), 'Invalid adapter identity')
                identities.append(identity)
                label = f'e{epoch:03d}-validation' if epoch else 'baseline'
                raw = list(stop.read_rows(source(work / f'{pid}-{label}.jsonl')))
                stop.require(all(set(row) == {'row_id', 'mean_target_ce', 'target_tokens', 'adapter_sha256'} and
                                 row['adapter_sha256'] == identity for row in raw), 'Validation adapter/format differs')
                metrics = [{k: row[k] for k in ('row_id', 'mean_target_ce', 'target_tokens')} for row in raw]
                measured = stop.validation_loss(metrics, self.indexes[pid]['validation'])
                recorded = record['losses'][epoch - 1] if epoch else record['baseline']
                stop.require(type(recorded) in (int, float) and math.isclose(measured, recorded, rel_tol=1e-10, abs_tol=1e-12),
                             'Recorded aggregate differs from full validation')
                event = {'epoch': epoch, 'checkpoint_sha256': identity, 'validation': snapshot(metrics), 'train': None}
                if epoch:
                    coverage = source(work / f'{pid}-e{epoch:03d}-coverage.jsonl')
                    stop.epoch_coverage(list(stop.read_rows(coverage)), self.indexes[pid]['train'])
                    event['train'] = {'path': str(coverage.relative_to(work)), 'sha256': stop.file_hash(coverage)}
                    if pid == PHASES[-1]:
                        role_path = work / 'role-evaluations' / f'e{epoch:03d}.json'
                        if role_path.exists():
                            source(role_path)
                            event['role_evaluation'] = {'path': str(role_path.relative_to(work)),
                                                        'sha256': stop.file_hash(role_path)}
                events.append(event)
            history = {'schema': 'malssi-training-history-v2', 'policy_sha256': stop.fingerprint(self.policy),
                       'model_role': 'cards_31b', 'phase_id': pid, 'run_id': self.config['run_id'],
                       'input_checkpoint_sha256': identities[0],
                       'model_start_checkpoint_sha256': self.baseline['baseline_checkpoint_sha256'],
                       'role_eval_suite_sha256': stop.fingerprint(self.suite),
                       'role_baseline_judgments_sha256': self.baseline_hash,
                       'previous_decision_sha256': stop.fingerprint(previous) if previous else None, 'events': events}
            decision = stop.decide(self.policy, 'cards_31b', pid, history, self.indexes[pid], work,
                                   previous, self.suite, self.lineage)
            if pid != phase_id:
                stop.require(decision['status'] == 'stop_phase_accepted' and
                             record.get('selected_adapter_sha256') == decision['selected_checkpoint_sha256'],
                             'Preceding phase lacks matching performance acceptance')
            old = record.get('completion_receipt')
            if old:
                stop.require(old['binding'] == binding['completion'] and
                             all(sources.get(name) == digest for name, digest in old['sources'].items()),
                             'Previously consumed completion evidence changed')
            receipt = {'binding': binding['completion'], 'sources': dict(sources), 'decision': decision}
            decisions[pid] = receipt
            # A missing evaluation is pending, never a reusable approval.
            previous = decision
        return decisions


def apply_receipts(state, phase_id, receipts):
    """Return a new state; the caller commits it with the runner's atomic writer."""
    result = deepcopy(state)
    for pid, receipt in receipts.items():
        result['phases'][pid]['completion_receipt'] = receipt
    decision = receipts[phase_id]['decision']
    record = result['phases'][phase_id]
    record['decision'] = decision['status']
    if decision['status'] == 'stop_phase_accepted':
        stop.require(decision['epochs_completed'] == len(record['epoch_checkpoints']), 'Accepted checkpoint is stale')
        record['selected_checkpoint'] = record['epoch_checkpoints'][-1]
        record['selected_adapter_sha256'] = decision['selected_checkpoint_sha256']
        result['accepted'].append(phase_id)
    return result


def prepare(policy, suite, baseline, dataset, output, run_id):
    """Freeze existing judgments in a fresh directory; never fill missing labels."""
    output = Path(output).absolute()
    stop.require(output.parent.resolve() == output.parent and not output.exists(), 'Use a fresh canonical output directory')
    temporary = Path(tempfile.mkdtemp(prefix='.' + output.name + '-', dir=output.parent))
    try:
        refs = {}
        for key, path in (('policy', policy), ('suite', suite), ('baseline', baseline)):
            target = temporary / (key + '.json')
            shutil.copyfile(path, target)
            refs[key] = {'path': target.name, 'sha256': stop.file_hash(target)}
        config = {'schema': SCHEMA, 'run_id': run_id, **refs}
        (temporary / 'completion.json').write_text(stop.canonical(config) + '\n', encoding='utf-8')
        CompletionGate(temporary / 'completion.json', dataset)
        temporary.rename(output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return {'status': 'completion_inputs_frozen', 'config': str(output / 'completion.json'),
            'training_started': False, 'training_complete': False, 'automatic_deployment': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare'])
    for key in ('policy', 'suite', 'baseline', 'dataset', 'output'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    try:
        print(stop.canonical(prepare(args.policy, args.suite, args.baseline, args.dataset, args.output, args.run_id)))
    except (ValueError, KeyError, TypeError, OSError) as error:
        # Do not echo data/judgments from malformed input.
        print(stop.canonical({'status': 'completion_inputs_rejected', 'error_type': type(error).__name__,
                              'training_complete': False}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
