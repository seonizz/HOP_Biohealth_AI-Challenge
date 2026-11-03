#!/usr/bin/env python3
"""Read-only app-contract drift check; never renews a training approval.

Exit 0: available snapshots and replayed memory rows match the current contract.
Exit 2: drift, incompatible/missing evidence, or a failed check. A zero exit is
not semantic approval, model performance evidence, or permission to train.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


SNAPSHOTS = (
    ('APP_CONTRACT.json', 'contract_sha256', False),
    ('provenance/SOURCE_APP_CONTRACT.json', 'contract_sha256', False),
    ('provenance/MEMORY_REVIEW_APP_CONTRACT.json', 'app_sha256', True),
    ('provenance/review_expansion/memory_projections.jsonl.verification.json', 'app_sha256', True),
)


class CheckError(ValueError):
    """Fixed, non-sensitive diagnostic code only."""


def require(condition, code):
    if not condition:
        raise CheckError(code)


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def contained(root, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute()
            and all(p not in ('', '.', '..') for p in name.split('/')), 'unsafe_relative_path')
    target = root / name
    require(target.resolve().is_relative_to(root), 'path_outside_root')
    require(not any(p.is_symlink() for p in [target, *target.parents] if p != root.parent), 'symlink_not_allowed')
    return target


def bound_file(root, name, manifest):
    target = contained(root, name)
    expected = manifest.get('files', {}).get(name)
    require(isinstance(expected, dict) and target.is_file(), 'unbound_or_missing_bundle_file')
    require(file_hash(target) == expected.get('sha256')
            and target.stat().st_size == expected.get('bytes'), 'bundle_file_hash_mismatch')
    return target


def compare_snapshots(root, repo, manifest):
    reports = []
    for name, key, basenames in SNAPSHOTS:
        if not (root / name).exists():
            continue
        data = read_json(bound_file(root, name, manifest))
        hashes = data.get(key)
        require(isinstance(hashes, dict) and hashes, 'missing_snapshot_hashes')
        files = []
        for raw_name, expected in sorted(hashes.items()):
            require(isinstance(raw_name, str), 'invalid_snapshot_path')
            relative = 'app/src/' + raw_name if basenames else raw_name
            require(relative.startswith('app/src/') and relative.endswith('.js'), 'unexpected_snapshot_path')
            require(isinstance(expected, str) and len(expected) == 64
                    and all(c in '0123456789abcdef' for c in expected), 'invalid_snapshot_hash')
            target = contained(repo, relative)
            actual = file_hash(target) if target.is_file() else None
            files.append({'file': relative, 'snapshot_sha256': expected, 'current_sha256': actual,
                          'status': 'missing' if actual is None else 'match' if actual == expected else 'drift'})
        reports.append({'snapshot': name, 'snapshot_manifest_bound': True, 'files': files})
    require(reports, 'no_app_contract_snapshot')
    return reports


def memory_inputs(root, manifest):
    course = read_json(bound_file(root, 'COURSE.json', manifest))
    inputs, seen, expected_rows = [], set(), 0
    tasks = set()
    for phase in course.get('phases', []):
        for part in phase.get('data', {}).values():
            tasks.update(part.get('tasks', {}))
            count = part.get('tasks', {}).get('memory_review', 0)
            require(type(count) is int and count >= 0, 'invalid_memory_row_count')
            if count:
                name = part['path']
                require(name not in seen, 'duplicate_memory_partition')
                seen.add(name)
                inputs.append(bound_file(root, name, manifest))
                expected_rows += count
    return inputs, expected_rows, sorted(tasks - {'memory_review'})


def check(root, repo, node='node'):
    root, repo = root.resolve(strict=True), repo.resolve(strict=True)
    manifest_path = contained(root, 'MANIFEST.json')
    manifest_hash = file_hash(manifest_path)
    manifest = read_json(manifest_path)
    snapshots = compare_snapshots(root, repo, manifest)
    inputs, expected_rows, untested = memory_inputs(root, manifest)
    if inputs:
        helper = Path(__file__).with_name('check_training_memory_contract.mjs')
        result = subprocess.run([node, str(helper), '--repo', str(repo), *map(str, inputs)],
                                capture_output=True, text=True, timeout=120, check=False)
        try:
            replay = json.loads(result.stdout)
        except (ValueError, TypeError):
            raise CheckError('invalid_callback_check_result') from None
        require(result.returncode in (0, 2) and replay.get('status') != 'check_failed', 'callback_check_failed')
        require(replay.get('rows_checked') == expected_rows, 'memory_row_inventory_mismatch')
        require(replay.get('model_calls') == 0 and replay.get('semantic_quality_evaluated') is False
                and replay.get('previous_semantic_approval_reused') is False, 'invalid_callback_scope')
    else:
        replay = {'status': 'not_covered', 'rows_checked': 0, 'model_calls': 0,
                  'semantic_quality_evaluated': False, 'previous_semantic_approval_reused': False}
    # Freeze the evidence interval: concurrent source/data edits invalidate this run.
    require(file_hash(manifest_path) == manifest_hash, 'bundle_changed_during_check')
    require(compare_snapshots(root, repo, manifest) == snapshots, 'app_changed_during_check')
    bound_file(root, 'COURSE.json', manifest)
    for path in inputs:
        bound_file(root, path.relative_to(root).as_posix(), manifest)
    drift = sum(f['status'] != 'match' for snapshot in snapshots for f in snapshot['files'])
    unique_drift = {f['file'] for snapshot in snapshots for f in snapshot['files'] if f['status'] != 'match'}
    status = ('incompatible' if replay['status'] == 'incompatible' else
              'review_required' if drift or replay['status'] == 'compatible_with_contract_drift' else
              'snapshot_match_unvalidated_tasks' if not inputs else 'contract_match')
    return {'schema': 'malssi-training-app-contract-check-v1', 'status': status,
            'snapshots': snapshots, 'snapshot_file_mismatches': drift,
            'unique_current_file_mismatches': len(unique_drift),
            'memory_review_current_callback': replay, 'current_callback_untested_tasks': untested,
            'semantic_quality_evaluated': False, 'previous_semantic_approval_reused': False,
            'training_ready': False, 'bundle_modified': False, 'model_calls': 0,
            'bundle_integrity_scope': 'snapshots_course_and_replayed_messages_only',
            'next_action': 'new_version_and_fresh_semantic_review_if_contract_changes'
            if status in ('incompatible', 'review_required') else 'complete_remaining_role_and_semantic_evaluation'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    try:
        report = check(args.root, args.repo)
    except CheckError as error:
        report = {'status': 'check_failed', 'error': str(error), 'training_ready': False,
                  'semantic_quality_evaluated': False, 'bundle_modified': False, 'model_calls': 0}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        report = {'status': 'check_failed', 'error': 'contract_check_failed', 'training_ready': False,
                  'semantic_quality_evaluated': False, 'bundle_modified': False, 'model_calls': 0}
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report['status'] in ('contract_match', 'snapshot_match_unvalidated_tasks') else 2


if __name__ == '__main__':
    raise SystemExit(main())
