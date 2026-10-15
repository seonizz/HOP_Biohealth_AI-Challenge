"""Versioned use constraints and diagnostics; never confer clinical validity."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from itertools import zip_longest
import hashlib
import json
import math
from pathlib import Path
import sqlite3

import numpy as np

from .numeric import dump, fingerprint, tokens, terms, char_ngrams, hash_counts


REASONS = {
    'missing': 1, 'not_numeric': 2, 'not_finite': 4, 'negative': 8,
    'noninteger_count': 16, 'end_before_start': 32, 'float32_overflow': 64,
}
SOURCE_COLUMNS = {
    'utterance': ['start_point', 'end_point', 'character_count', 'cps'],
    'conversation': ['age', 'silence', 'total_time'],
}
LEXICAL_METHODS = ('tfidf', 'word_hash', 'char_hash', 'statistics')


def numeric_reasons(obj, columns):
    """Only mathematical/schema constraints, with no inferred clinical ranges."""
    flags = np.zeros(len(columns), dtype=np.uint16)
    for j, key in enumerate(columns):
        if key not in obj:
            flags[j] = REASONS['missing']
            continue
        value = obj[key]
        if type(value) not in (int, float):
            flags[j] = REASONS['not_numeric']
            continue
        try:
            finite = math.isfinite(value)
        except OverflowError:
            finite = False
        if not finite:
            flags[j] = REASONS['not_finite']
            continue
        if value < 0:
            flags[j] |= REASONS['negative']
        if key == 'character_count' and value != int(value):
            flags[j] |= REASONS['noninteger_count']
        if abs(value) > np.finfo(np.float32).max:
            flags[j] |= REASONS['float32_overflow']
    if 'start_point' in columns and 'end_point' in columns:
        start, end = columns.index('start_point'), columns.index('end_point')
        if not flags[start] and not flags[end] and obj['end_point'] < obj['start_point']:
            flags[start] |= REASONS['end_before_start']
            flags[end] |= REASONS['end_before_start']
    return flags


def aligned_rows(path, records, has_split=False):
    """Reject missing, reordered, extra, or inconsistent row mappings."""
    with Path(path).open() as stream:
        for i, pair in enumerate(zip_longest(stream, records)):
            line, record = pair
            if line is None or record is None:
                raise ValueError(f'row mapping count mismatch: {path.name}')
            mapped = json.loads(line)
            if type(mapped.get('row')) is not int or mapped['row'] != i or mapped.get('id') != record[0]:
                raise ValueError(f'row mapping identity mismatch: {path.name}')
            if has_split and mapped.get('split') != record[1]:
                raise ValueError(f'row mapping split mismatch: {path.name}')
            yield i, record


def save_array(root, name, matrix, row_mapping, columns):
    path = root / (name + '.npy')
    np.save(path, matrix)
    return {'path': path.name, 'shape': list(matrix.shape), 'dtype': str(matrix.dtype),
            'row_mapping': '../numeric/' + row_mapping, 'columns': columns}


def metadata_masks(db, root, numeric):
    artifacts, report = [], {}
    for unit, columns in SOURCE_COLUMNS.items():
        values = np.load(numeric / f'{unit}_source_numeric.npy', mmap_mode='r')
        observed = np.load(numeric / f'{unit}_source_numeric_observed.npy', mmap_mode='r')
        flags = np.zeros(values.shape, dtype=np.uint16)
        mapping = f'{unit}_metadata_rows.jsonl'
        query = f'SELECT {unit}_id,raw_json FROM {unit}s ORDER BY {unit}_id'
        duration = np.zeros((len(values), 1), dtype=np.float64) if unit == 'utterance' else None
        duration_valid = np.zeros((len(values), 1), dtype=np.uint8) if unit == 'utterance' else None
        for i, (_, raw) in aligned_rows(numeric / mapping, db.execute(query)):
            obj = json.loads(raw)
            if not isinstance(obj, dict):
                obj = {}
            flags[i] = numeric_reasons(obj, columns)
            if duration is not None and flags[i, 0] == flags[i, 1] == 0:
                duration[i, 0] = obj['end_point'] - obj['start_point']
                duration_valid[i, 0] = 1
        valid = ((flags == 0) & (observed == 1) & np.isfinite(values)).astype(np.uint8)
        artifacts.append(save_array(root, f'{unit}_source_numeric_valid', valid, mapping, columns))
        artifacts.append(save_array(root, f'{unit}_source_numeric_reasons', flags, mapping, columns))
        report[unit] = {'columns': columns, 'observed_cells': int(observed.sum()),
                        'valid_cells': int(valid.sum()),
                        'invalid_observed_cells': int(((observed == 1) & (valid == 0)).sum()),
                        'reasons_by_column': {key: {name: int(((flags[:, j] & bit) != 0).sum())
                            for name, bit in REASONS.items()} for j, key in enumerate(columns)}}
        if duration is not None:
            artifacts.append(save_array(root, 'utterance_duration', duration, mapping, ['end_minus_start_source_units']))
            artifacts.append(save_array(root, 'utterance_duration_valid', duration_valid, mapping, ['both_bounds_valid_and_ordered']))
            report[unit]['reversed_time_rows'] = int(((flags[:, 0] & REASONS['end_before_start']) != 0).sum())
            report[unit]['duration_valid_rows'] = int(duration_valid.sum())
    report['reason_bits'] = REASONS
    report['validity_scope'] = 'Finite nonnegative source quantities; integer character_count; ordered timestamps. No source accuracy, unit calibration, or clinical validity claim.'
    report['missing_timestamp_policy'] = 'A present endpoint may pass its own domain check; duration requires both valid endpoints. Zero duration is allowed and is not a usable divisor.'
    return artifacts, report


def text_masks(db, root, numeric):
    rows = db.execute('SELECT conversation_id,split,raw_json FROM conversations ORDER BY conversation_id')
    n = db.execute('SELECT count(*) FROM conversations').fetchone()[0]
    flags = np.zeros((n, 4), dtype=np.uint8)
    completeness = {}
    missing_total = affected = 0
    for i, (cid, split, raw) in aligned_rows(numeric / 'conversation_rows.jsonl', rows, True):
        obj = json.loads(raw)
        paragraphs = obj['paragraph']
        observed = [p['paragraph_text'] for p in paragraphs
                    if isinstance(p, dict) and isinstance(p.get('paragraph_text'), str)]
        missing = len(paragraphs) - len(observed)
        complete, nonblank, allowed = missing == 0, any(t.strip() for t in observed), split in ('train', 'validation')
        flags[i] = [complete, nonblank, allowed, complete and nonblank and allowed]
        completeness[cid] = complete
        missing_total += missing
        affected += missing > 0
    artifacts = [save_array(root, 'conversation_text_masks', flags, 'conversation_rows.jsonl',
        ['all_source_turns_have_string_text', 'has_nonblank_text', 'allowed_split', 'whole_conversation_usable'])]
    n = db.execute('SELECT count(*) FROM sentences').fetchone()[0]
    sentence_flags = np.zeros((n, 3), dtype=np.uint8)
    query = 'SELECT sentence_id,split,conversation_id,text FROM sentences ORDER BY sentence_id'
    for i, (_, split, cid, text) in aligned_rows(numeric / 'sentence_rows.jsonl', db.execute(query), True):
        sentence_flags[i] = [bool(text.strip()) and split in ('train', 'validation'),
                             completeness[cid], split in ('train', 'validation')]
    artifacts.append(save_array(root, 'sentence_text_masks', sentence_flags, 'sentence_rows.jsonl',
        ['local_text_usable', 'whole_conversation_text_complete', 'allowed_split']))
    return artifacts, {'nonstring_or_missing_utterances': missing_total, 'affected_conversations': affected,
        'whole_conversation_usable': int(flags[:, 3].sum()),
        'policy': 'Exclude incomplete text by default for whole-conversation features. Keep valid local sentences separately; full-context tasks require their conversation completeness flag. No label eligibility is conferred.'}


def distributional_masks(root, numeric, base):
    artifacts, report = [], {}
    for unit in ('sentence', 'conversation'):
        matrix = np.load(numeric / f'{unit}_distributional.npy', mmap_mode='r')
        statistics = np.load(numeric / f'{unit}_statistics.npy', mmap_mode='r')
        flags = np.zeros((len(matrix), 3), dtype=np.uint8)
        for start in range(0, len(matrix), 100000):
            block = matrix[start:start + 100000]
            coverage = block[:, -1]
            if np.any((coverage < 0) | (coverage > 1)):
                raise ValueError('distributional coverage outside [0,1]')
            flags[start:start + len(block), 0] = np.any(block[:, :-1] != 0, axis=1)
            flags[start:start + len(block), 1] = coverage > 0
            flags[start:start + len(block), 2] = (coverage == 1) & (statistics[start:start + len(block), 2] > 0)
        artifacts.append(save_array(root, f'{unit}_distributional_masks', flags, f'{unit}_rows.jsonl',
            ['nonzero_vector_excluding_coverage', 'any_token_in_vocabulary', 'all_tokens_in_vocabulary']))
        item = next(x for x in base['artifacts'] if x['path'] == f'{unit}_distributional.npy')
        report[unit] = {'rows': len(matrix), 'zero_vector_rows': int((flags[:, 0] == 0).sum()),
                        'full_token_coverage_rows': int(flags[:, 2].sum()), 'token_oov_rate': item['oov_rate']}
    report['policy'] = {'exploration_only': True, 'standalone_semantic_use': False,
        'nonzero_or_full_coverage_proves_meaning_preserved': False,
        'reason': 'OOV removal and mean pooling can collapse different meanings; neither vector distance nor adjacent cosine establishes emotion, risk, or clinical change.'}
    return artifacts, report


def contrast_probe(numeric, config):
    """Synthetic counterexample, never a corpus label or clinical benchmark."""
    texts = ['자살하고 싶어요', '행복하고 싶어요']
    words = json.loads((numeric / 'distributional_vocabulary.json').read_text())['words']
    index = {word: i for i, word in enumerate(words)}
    embedding = np.load(numeric / 'word_distributional.npy')
    vocabulary = json.loads((numeric / 'vocabulary.json').read_text())['terms']
    vocab_index = {term: i for i, term in enumerate(vocabulary)}
    idf = np.load(numeric / 'idf.npy')
    vectors, lexical, hashes, covered = [], [], [], []
    for text in texts:
        ts = tokens(text)
        ids = [index[t] for t in ts if t in index]
        vectors.append(embedding[ids].mean(axis=0) if ids else np.zeros(embedding.shape[1], dtype=np.float32))
        covered.append([t for t in ts if t in index])
        counts = Counter(vocab_index[t] for t in terms(text) if t in vocab_index)
        tfidf = {i: (1 + math.log(count)) * float(idf[i]) for i, count in counts.items()}
        norm = math.sqrt(sum(v * v for v in tfidf.values()))
        lexical.append({i: v / norm for i, v in tfidf.items()} if norm else {})
        hashes.append(hash_counts(char_ngrams(text), config['char_hash_dimensions']))
    return {'scope': 'two synthetic strings; no accuracy or counseling outcome claim', 'texts': texts,
            'distributional_retained_tokens': covered,
            'distributional_vectors_identical': bool(np.array_equal(*vectors)),
            'tfidf_distinguishes_this_pair': lexical[0] != lexical[1],
            'char_hash_distinguishes_this_pair': hashes[0] != hashes[1]}


def code_hashes():
    return {name: fingerprint(Path(__file__).with_name(name)) for name in
            ('suitability.py', 'evaluation_audit.py', 'numeric.py', 'text.py')}


def require_numeric_binding(base, implementations):
    # The serialized v1 numeric config_sha256 contract includes these two source
    # hashes. Preserve its exact encoding so existing matrices need no rewrite.
    encoded = (json.dumps(base['config'], sort_keys=True)
               + implementations['numeric.py'] + implementations['text.py'])
    if hashlib.sha256(encoded.encode()).hexdigest() != base['config_sha256']:
        raise ValueError('numeric implementation/config changed; rerun numeric before suitability')


def check_artifacts(root, artifacts):
    for item in artifacts:
        path = root / item['path']
        if not path.is_file() or fingerprint(path) != item.get('sha256'):
            raise ValueError('missing or changed artifact: ' + item['path'])
        if path.suffix == '.npy':
            data = np.load(path, mmap_mode='r', allow_pickle=False)
            if list(data.shape) != item['shape'] or str(data.dtype) != item['dtype'] or not np.isfinite(data).all():
                raise ValueError('invalid quality array: ' + item['path'])


def assess(output):
    """Build or reuse a hash-bound companion stage, leaving base artifacts intact."""
    from .evaluation_audit import build_evaluation_audit
    output = Path(output)
    numeric, root = output / 'numeric', output / 'suitability'
    root.mkdir(exist_ok=True)
    base = json.loads((numeric / 'manifest.json').read_text())
    implementations = code_hashes()
    require_numeric_binding(base, implementations)
    input_hash = fingerprint(output / 'corpus.sqlite')
    if base['input_sha256'] != input_hash:
        raise ValueError('numeric input does not match corpus; rerun numeric')
    # Bind every base artifact, including row mappings, before deriving new masks.
    for item in base['artifacts']:
        path = numeric / item['path']
        if not path.is_file() or fingerprint(path) != item.get('sha256'):
            raise ValueError('base artifact changed: ' + item['path'])
    binding = {'input_sha256': input_hash, 'numeric_manifest_sha256': fingerprint(numeric / 'manifest.json'),
               'implementation_sha256': implementations}
    finished = root / 'manifest.json'
    if finished.exists():
        previous = json.loads(finished.read_text())
        if all(previous.get(k) == v for k, v in binding.items()):
            try:
                check_artifacts(root, previous['artifacts'])
            except (ValueError, OSError):
                pass
            else:
                return previous
    print('suitability: source validity and text completeness', flush=True)
    db = sqlite3.connect(f'{(output / "corpus.sqlite").resolve().as_uri()}?mode=ro', uri=True)
    try:
        artifacts, metadata = metadata_masks(db, root, numeric)
        text_artifacts, text_report = text_masks(db, root, numeric)
        artifacts.extend(text_artifacts)
        dist_artifacts, distributional = distributional_masks(root, numeric, base)
        artifacts.extend(dist_artifacts)
        print('suitability: split overlap and source-label imbalance', flush=True)
        evaluation = build_evaluation_audit(db, root, numeric)
        artifacts.extend(evaluation.pop('artifacts'))
    finally:
        db.close()
    report = {'version': 1, 'scope': 'descriptive diagnostics and restricted use policy; not training/evaluation ground truth',
              'source_numeric': metadata, 'text': text_report, 'distributional': distributional,
              'synthetic_contrast': contrast_probe(numeric, base['config']), 'evaluation': evaluation,
              'clinical_training_ready': False,
              'unresolved_requirements': ['official code meanings and applicability', 'independently reviewed sentence gold labels',
                                          'verified participant identities and purpose-specific evaluation']}
    dump(root / 'report.json', report)
    artifacts.append({'path': 'report.json'})
    contract = {'version': 1, 'default_lexical_methods': list(LEXICAL_METHODS),
        'source_numeric_requires': ['observed', 'valid', 'reasons'],
        'whole_conversation_requires': 'conversation_text_masks.whole_conversation_usable',
        'full_context_sentence_requires': 'sentence_text_masks.whole_conversation_text_complete',
        'svd': distributional['policy'],
        'excluded_from_default_inputs': ['distributional', 'original_labels', 'summary', 'exploration', 'structure'],
        'allowed_purpose': 'lexical_exploration', 'clinical_training_ready': False,
        'evaluation_subsets': 'Novelty diagnostics only. Do not change training fit or original split; do not claim independent people or valid labels.',
        'numeric_validity': metadata['validity_scope']}
    dump(root / 'usage_contract.json', contract)
    artifacts.append({'path': 'usage_contract.json'})
    for item in artifacts:
        item['sha256'] = fingerprint(root / item['path'])
    result = {'version': 1, **binding, 'created_at': datetime.now(timezone.utc).isoformat(),
              'artifacts': artifacts, 'clinical_training_ready': False,
              'structural_success_is_not_semantic_validation': True}
    check_artifacts(root, artifacts)
    dump(finished, result)
    return result


def load_features(output, unit, method, *, purpose='lexical_exploration', require_complete_context=False):
    """Default reader: return restricted inputs together with masks and row IDs.

    A row_use_mask means text/feature availability, never target eligibility.
    Direct numeric/ files remain archival artifacts without these safeguards.
    """
    if purpose != 'lexical_exploration':
        raise ValueError('Unsupported purpose: clinical/sentence-label readiness has not been established')
    if unit not in ('sentence', 'conversation', 'utterance') or method not in (*LEXICAL_METHODS, 'source_numeric'):
        raise ValueError('Feature excluded from default inputs; SVD and targets are not standalone semantic inputs')
    if unit == 'utterance' and method != 'source_numeric' or unit == 'sentence' and method == 'source_numeric':
        raise ValueError('Unsupported unit/method combination')
    output = Path(output)
    root, numeric = output / 'suitability', output / 'numeric'
    # Explicitly fail rather than silently rebuilding a missing/stale contract at read time.
    manifest = json.loads((root / 'manifest.json').read_text())
    base = json.loads((numeric / 'manifest.json').read_text())
    implementations = code_hashes()
    require_numeric_binding(base, implementations)
    if manifest['implementation_sha256'] != implementations or manifest['numeric_manifest_sha256'] != fingerprint(numeric / 'manifest.json'):
        raise ValueError('stale suitability contract; rerun suitability')
    if manifest['input_sha256'] != fingerprint(output / 'corpus.sqlite'):
        raise ValueError('changed corpus; rerun numeric and suitability')
    check_artifacts(root, manifest['artifacts'])
    mapping = f'{unit}_metadata_rows.jsonl' if method == 'source_numeric' else f'{unit}_rows.jsonl'
    suffix = '.npy' if method in ('source_numeric', 'statistics') else '.npz'
    needed = {f'{unit}_{method}{suffix}', mapping}
    if method == 'source_numeric':
        needed.add(f'{unit}_source_numeric_observed.npy')
    for name in needed:
        item = next(x for x in base['artifacts'] if x['path'] == name)
        if fingerprint(numeric / name) != item['sha256']:
            raise ValueError('changed base feature or row mapping: ' + name)
    rows = [json.loads(line) for line in (numeric / mapping).open()]
    db = sqlite3.connect(f'{(output / "corpus.sqlite").resolve().as_uri()}?mode=ro', uri=True)
    try:
        if unit == 'utterance':
            # Avoid repeatedly reading the large conversation JSON column via a join.
            splits = dict(db.execute('SELECT conversation_id,split FROM conversations'))
            query = db.execute('SELECT utterance_id,conversation_id FROM utterances ORDER BY utterance_id')
            records = ((uid, splits[cid]) for uid, cid in query)
        else:
            records = db.execute(f'SELECT {unit}_id,split FROM {unit}s ORDER BY {unit}_id')
        for i, (_, split) in aligned_rows(numeric / mapping, records, method != 'source_numeric'):
            rows[i]['split'] = split
    finally:
        db.close()
    if suffix == '.npz':
        with np.load(numeric / f'{unit}_{method}{suffix}', allow_pickle=False) as archive:
            matrix = {key: archive[key].copy() for key in ('data', 'indices', 'indptr', 'shape')}
        ptr, indices, values, shape = (matrix[key] for key in ('indptr', 'indices', 'data', 'shape'))
        if (shape[0] != len(rows) or len(ptr) != len(rows) + 1 or ptr[0] != 0
                or ptr[-1] != len(values) or len(values) != len(indices)
                or np.any(np.diff(ptr) < 0) or np.any(indices < 0) or np.any(indices >= shape[1])
                or not np.isfinite(values).all()):
            raise ValueError('invalid feature CSR or row count')
        nonempty = np.diff(matrix['indptr']) > 0
    else:
        matrix = np.load(numeric / f'{unit}_{method}{suffix}', mmap_mode='r', allow_pickle=False)
        if matrix.shape[0] != len(rows) or not np.isfinite(matrix).all():
            raise ValueError('invalid feature values or row count')
        nonempty = np.ones(len(matrix), dtype=bool)
    quality = {}
    row_mask = np.array([row['split'] in ('train', 'validation') for row in rows])
    if unit in ('sentence', 'conversation'):
        text_flags = np.load(root / f'{unit}_text_masks.npy')
        quality['text_masks'] = text_flags
        row_mask &= text_flags[:, 3 if unit == 'conversation' else 0].astype(bool)
        if require_complete_context and unit == 'sentence':
            row_mask &= text_flags[:, 1].astype(bool)
    if method == 'source_numeric':
        valid = np.load(root / f'{unit}_source_numeric_valid.npy').astype(bool)
        nonempty &= valid.any(axis=1)
        quality.update(observed=np.load(numeric / f'{unit}_source_numeric_observed.npy'), valid=valid,
                       reasons=np.load(root / f'{unit}_source_numeric_reasons.npy'))
        matrix = np.ma.array(matrix, mask=~valid, copy=False)
    return {'matrix': matrix, 'rows': rows, 'row_use_mask': row_mask & nonempty,
            'quality': quality, 'purpose': purpose, 'label_eligibility': 'not established',
            'usage_contract': json.loads((root / 'usage_contract.json').read_text()),
            'clinical_training_ready': False}
