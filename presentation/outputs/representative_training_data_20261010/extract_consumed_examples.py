"""Reconstruct the recorded step100 input rows without accessing the GPU server."""
import gzip
import hashlib
import json
import random
import zipfile
from pathlib import Path

BASE = Path('/Users/chihun/Documents/ChatGPT/HOP_data/deliverables/malssi_stage1_training_20261009')
AUDIT = Path('/Users/chihun/Documents/ChatGPT/HOP_agent/outputs/ft31_step100_collection_20261009T192608Z/evidence/training_exposure.json')
OUTPUT = Path('/private/tmp/malssi_consumed_example_candidates.json')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    audit = json.loads(AUDIT.read_bytes())
    source_manifest = json.loads((BASE / 'source_reference/manifest.json').read_bytes())
    export = json.loads((BASE / 'data/export_manifest.json').read_bytes())
    archive = BASE / 'historical/round4_reproduction.zip'
    member = 'outputs/private/malssi_round3_20261009/admission_policy.json'
    with zipfile.ZipFile(archive) as bundle:
        policy_bytes = bundle.read(member)
    assert sha(policy_bytes) == export['source_admission_policy_sha256']
    policy = json.loads(policy_bytes)
    quarantined = set(policy['quarantined_source_groups'])
    held = set(policy['held_validation_example_ids'])
    order = list(range(audit['datasets']['train']['rows']))
    random.Random(3407).shuffle(order)
    order_bytes = json.dumps(order, sort_keys=True, separators=(',', ':')).encode()
    assert sha(order_bytes) == audit['training_plan_order_sha256']
    processed = {index: position for position, index in enumerate(order[:audit['checkpoint_cursor']])}
    source = BASE / 'source_reference/conversation/train.jsonl.gz'
    source_hash = hashlib.sha256()
    with source.open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            source_hash.update(block)
    assert source_hash.hexdigest() == source_manifest['files']['conversation/train.jsonl.gz']['sha256']
    raw_hash = hashlib.sha256()
    raw_bytes = source_count = admitted_count = excluded_count = 0
    candidates = []
    with gzip.open(source, 'rb') as handle:
        for source_index, line in enumerate(handle):
            source_count += 1
            row = json.loads(line)
            assert row['split'] == 'train'
            if row['source_group_id'] in quarantined or row['id'] in held:
                excluded_count += 1
                continue
            raw_hash.update(line)
            raw_bytes += len(line)
            if admitted_count in processed:
                assert row['loss_message_mask'] == [0] * (len(row['messages']) - 1) + [1]
                candidates.append({
                    'id': row['id'],
                    'source_conversation_id': row['source_conversation_id'],
                    'source_group_id': row['source_group_id'],
                    'source_file_line': source_index + 1,
                    'train_row_index_zero_based': admitted_count,
                    'processed_position_one_based': processed[admitted_count] + 1,
                    'optimizer_step': processed[admitted_count] // 8 + 1,
                    'target_start_ordinal': row['target_start_ordinal'],
                    'target_end_ordinal': row['target_end_ordinal'],
                    'message_count': len(row['messages']),
                    'original_jsonl_line_sha256': sha(line),
                    'target_sha256': row['target_sha256'],
                    'target_origin': row['target_origin'],
                    'quality_status': row['quality_status'],
                    'display_context_is_excerpt': True,
                    'last_context_messages': row['messages'][-4:-1],
                    'target': row['messages'][-1]['content'],
                })
            admitted_count += 1
    expected = audit['datasets']['train']
    assert source_count == source_manifest['files']['conversation/train.jsonl.gz']['rows']
    assert admitted_count == expected['rows']
    assert raw_hash.hexdigest() == expected['uncompressed_sha256']
    assert raw_bytes == expected['uncompressed_bytes']
    assert len(candidates) == len(processed) == audit['processed_original_rows']
    candidates.sort(key=lambda item: item['processed_position_one_based'])
    evidence = {
        'status': 'verified',
        'method': 'Exact raw dataset reconstruction and recorded permutation/cursor',
        'remote_connection_used': False,
        'recorded_observed_at': audit['observed_at'],
        'checkpoint_step': audit['checkpoint_step'],
        'checkpoint_sha256': audit['checkpoint_sha256'],
        'checkpoint_cursor': audit['checkpoint_cursor'],
        'prepared_train_rows': admitted_count,
        'prepared_validation_rows': audit['datasets']['validation']['rows'],
        'consumed_rows': len(candidates),
        'source_rows': source_count,
        'excluded_source_rows': excluded_count,
        'reconstructed_train_uncompressed_sha256': raw_hash.hexdigest(),
        'reconstructed_train_uncompressed_bytes': raw_bytes,
        'training_order_sha256': sha(order_bytes),
        'admission_policy_archive': str(archive),
        'admission_policy_member': member,
        'admission_policy_sha256': sha(policy_bytes),
        'source_file': str(source),
        'source_file_sha256': source_hash.hexdigest(),
        'source_audit_file': str(AUDIT),
        'source_audit_sha256': sha(AUDIT.read_bytes()),
        'limits': ['Recorded checkpoint exposure; no live model or optimizer state inspection.',
                   'Displayed messages are excerpts; actual training uses the whole original prefix.',
                   'Response-function descriptions are explanatory labels, not source annotations.'],
    }
    OUTPUT.write_text(json.dumps({'evidence': evidence, 'candidates': candidates}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'evidence': evidence, 'candidate_file': str(OUTPUT)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
