"""CPU-only regression checks for semantic weights and paired scheduling."""
from array import array
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import sys
import unittest

import review_bias_curriculum as curriculum


def projected(number=1):
    events, facts = curriculum.enhanced.source(curriculum.SEED, number)
    return curriculum.project(events, facts, f'test-review-root-{number}', 'train')


def binary(kind, values):
    result = array(kind, values)
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tobytes()


def artifact(row, tokenizer):
    ids, weights, focus, prefix = curriculum.encode_row(row, tokenizer)
    tokens, weighted = binary('I', ids), binary('f', weights)
    item = dict(row_id=row['row_id'], task=row['task'], split=row['split'],
                sequence_length=len(ids), prefix_length=prefix,
                target_length=len(ids)-prefix, focus_positions=focus,
                token_sha256=hashlib.sha256(tokens).hexdigest(),
                weight_sha256=hashlib.sha256(weighted).hexdigest())
    return item, tokens, weighted, ids, weights


class ProjectionAndScheduleTests(unittest.TestCase):
    def test_every_challenge_encoding_is_semantically_paired(self):
        records = projected()
        self.assertEqual(len(records), 54)
        groups = defaultdict(list)
        for request, reference, row in records:
            payload = json.loads(request['messages'][-1]['content'])
            self.assertEqual(curriculum.oracle(payload, request['task']), reference['target'])
            self.assertEqual(json.loads(row['messages'][-1]['content']), reference['target'])
            if request['task'] == 'event_review':
                encoding = 'pipe' if isinstance(payload['data']['events'][0], str) else 'object'
                groups[encoding, request['challenge']].append((request, reference, payload))
        self.assertEqual(set(groups), {(encoding, challenge) for encoding in ('pipe', 'object')
                                     for challenge in curriculum.CHALLENGES})
        for pair in groups.values():
            self.assertEqual(sorted(ref['target']['approved'] for _, ref, _ in pair), [False, True])
            self.assertEqual(pair[0][0]['pair_id'], pair[1][0]['pair_id'])
            a, b = [payload['data'] for _, _, payload in pair]
            self.assertEqual(a['events'], b['events'])
            self.assertEqual(sum(x[field] != y[field] for x, y in zip(a['draft'], b['draft'])
                                 for field in curriculum.event.FIELDS), 1)

    @classmethod
    def setUpClass(cls):
        cls.training = [row for number in range(1, 61) for _, _, row in projected(number)]
        source = curriculum.ROOT / 'training_data/gemma4_12b_additional_training_ready_20261112_v1/panels/app/data/train.jsonl'
        for row in curriculum.rows(source):
            row['pair_id'] = curriculum.digest([curriculum.VERSION, row['source_root_ids'],
                row['task'], row['review_metadata']['stage']])[:24]
            cls.training.append(row)
        cls.schedule = curriculum.fair_schedule(cls.training)

    def test_real_joint_schedule_preserves_pairs_and_task_coverage(self):
        curriculum.verify_schedule(self.training, self.schedule)
        self.assertEqual(Counter(map(len, self.schedule['windows'])), {8: 565})
        by_id = {row['row_id']: row for row in self.training}
        for window in self.schedule['windows']:
            decisions = [curriculum.decision(by_id[rid]['task'],
                json.loads(by_id[rid]['messages'][-1]['content'])) for rid in window
                if by_id[rid]['task'] != 'event_state']
            self.assertEqual(decisions.count(True), decisions.count(False))

    def test_oversized_window_rejected(self):
        schedule = deepcopy(self.schedule)
        schedule['windows'][:2] = [schedule['windows'][0] + schedule['windows'][1]]
        with self.assertRaisesRegex(ValueError, 'Accumulation window size'):
            curriculum.verify_schedule(self.training, schedule)

    def test_app_only_suffix_rejected_with_all_rows_and_pairs_preserved(self):
        schedule = deepcopy(self.schedule)
        event_rows = [r for r in self.training if r['task'].startswith('event_')]
        app_rows = [r for r in self.training if not r['task'].startswith('event_')]
        schedule['windows'] = (curriculum.fair_schedule(event_rows)['windows'] +
                               curriculum.fair_schedule(app_rows)['windows'])
        with self.assertRaisesRegex(ValueError, 'Task absent from schedule quarter'):
            curriculum.verify_schedule(self.training, schedule)


class ActualTokenizerWeightsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from transformers import AutoTokenizer
        cls.tokenizers = {
            name: AutoTokenizer.from_pretrained(str(curriculum.ROOT / path), local_files_only=True)
            for name, path in {
                '12b': 'training_data/gemma4_12b_additional_training_ready_20261112_v1/tokenizer',
                '31b': 'training_data/gemma4_31b_expanded_20261025/tokenizer',
            }.items()
        }
        cls.records = projected()
        cls.normal = next(row for _, ref, row in cls.records if ref['target'].get('approved') is True)
        cls.bad = next(row for _, ref, row in cls.records if ref['target'].get('approved') is False)
        cls.state = next(row for _, _, row in cls.records if row['task'] == 'event_state')

    def test_decision_mass_equal_despite_different_target_lengths(self):
        for name, tokenizer in self.tokenizers.items():
            with self.subTest(model=name):
                lengths = []
                for row in (self.normal, self.bad):
                    item, tokens, weighted, ids, weights = artifact(row, tokenizer)
                    curriculum.verify_encoded_row(row, item, tokens, weighted, tokenizer, 'train')
                    focus = item['focus_positions']
                    self.assertEqual(len(focus), 1)
                    literal = tokenizer.decode([ids[i] for i in focus[0]])
                    self.assertEqual(literal, str(json.loads(row['messages'][-1]['content'])['approved']).lower())
                    self.assertAlmostEqual(sum(weights[i] for i in focus[0]), .5)
                    self.assertEqual(set(weights[:item['prefix_length']]), {0.0})
                    self.assertAlmostEqual(sum(weights), 1)
                    lengths.append(item['target_length'])
                self.assertLess(lengths[0], lengths[1])

    def test_time_fields_receive_equal_mass_and_zero_prompt_mass(self):
        expected = json.loads(self.state['messages'][-1]['content'])['facts']
        for name, tokenizer in self.tokenizers.items():
            with self.subTest(model=name):
                item, tokens, weighted, ids, weights = artifact(self.state, tokenizer)
                curriculum.verify_encoded_row(self.state, item, tokens, weighted, tokenizer, 'train')
                groups = item['focus_positions']
                self.assertEqual(len(groups), len(expected))
                self.assertEqual([tokenizer.decode([ids[i] for i in group]) for group in groups],
                                 [fact['time'] for fact in expected])
                for group in groups:
                    self.assertAlmostEqual(sum(weights[i] for i in group), .5/len(expected))
                self.assertTrue(all(w == 0 for w in weights[:item['prefix_length']]))

    def test_nested_memory_decision_uses_approved_not_other_booleans(self):
        source = curriculum.ROOT / 'training_data/gemma4_12b_additional_training_ready_20261112_v1/panels/app/data/train.jsonl'
        chosen = {}
        for row in curriculum.rows(source):
            if row['task'] == 'memory_review':
                target = json.loads(row['messages'][-1]['content'])
                row['messages'][-1]['content'] = curriculum.canonical(target)
                chosen.setdefault(target['state']['approved'], row)
        self.assertEqual(set(chosen), {True, False})
        tokenizer = self.tokenizers['12b']
        for approved, row in chosen.items():
            item, tokens, weighted, ids, weights = artifact(row, tokenizer)
            curriculum.verify_encoded_row(row, item, tokens, weighted, tokenizer, 'train')
            focus = item['focus_positions'][0]
            self.assertEqual(tokenizer.decode([ids[i] for i in focus]), str(approved).lower())
            self.assertAlmostEqual(sum(weights[i] for i in focus), .5)

    def test_semantically_wrong_focus_rejected_even_after_rehash(self):
        tokenizer = self.tokenizers['12b']
        item, tokens, _, _, weights = artifact(self.bad, tokenizer)
        old = item['focus_positions'][0][0]
        other = next(i for i in range(item['prefix_length'], item['sequence_length']) if i != old)
        weights[old], weights[other] = weights[other], weights[old]
        item['focus_positions'] = [[other]]
        weighted = binary('f', weights)
        item['weight_sha256'] = hashlib.sha256(weighted).hexdigest()
        with self.assertRaisesRegex(ValueError, 'Semantic focus positions'):
            curriculum.verify_encoded_row(self.bad, item, tokens, weighted, tokenizer, 'train')

    def test_wrong_row_identity_rejected(self):
        tokenizer = self.tokenizers['12b']
        item, tokens, weighted, _, _ = artifact(self.bad, tokenizer)
        item['row_id'] = self.normal['row_id']
        with self.assertRaisesRegex(ValueError, 'Encoded row identity'):
            curriculum.verify_encoded_row(self.bad, item, tokens, weighted, tokenizer, 'train')

    def test_corrupt_tokens_weights_and_truncated_binary_rejected(self):
        tokenizer = self.tokenizers['12b']
        original, tokens, weighted, ids, weights = artifact(self.bad, tokenizer)
        wrong_ids = ids[:]
        wrong_ids[-1] += 1
        bad_weights = []
        for replacement in (float('nan'), -.1, .01):
            changed = weights[:]
            changed[0] = replacement
            bad_weights.append(binary('f', changed))
        variants = [('tokens', binary('I', wrong_ids), weighted),
                    ('partial-token', tokens[:-1], weighted),
                    ('partial-weight', tokens, weighted[:-1])]
        variants += [(f'weight-{i}', tokens, value) for i, value in enumerate(bad_weights)]
        for kind, changed_tokens, changed_weights in variants:
            with self.subTest(kind=kind):
                item = deepcopy(original)
                item['token_sha256'] = hashlib.sha256(changed_tokens).hexdigest()
                item['weight_sha256'] = hashlib.sha256(changed_weights).hexdigest()
                with self.assertRaises(ValueError):
                    curriculum.verify_encoded_row(self.bad, item, changed_tokens, changed_weights, tokenizer, 'train')


if __name__ == '__main__':
    unittest.main()
