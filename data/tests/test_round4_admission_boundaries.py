"""R4-04 synthetic policy boundaries; no clinical or identity conclusions."""
import copy
import unittest
from unittest.mock import patch
import unicodedata

from counseling_pipeline import source_admission as admission
from counseling_pipeline import source_selection_audit as selection
from counseling_pipeline import source_sft as source
from tests import test_source_sft as fixtures

FIRST = 'first_8_context_messages_min200chars'
RECENT = 'recent_8_context_messages_min200chars'


def messages(context):
    return [{'role': 'system', 'content': 'system'}] + context + [{'role': 'assistant', 'content': 'final target'}]


def context(count, tag='shared', width=40):
    return [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'{tag}-{i}-' + '가' * width} for i in range(count)]


def shared_prefix_spec(cid, split, tag='shared'):
    contents = []
    for i in range(4):
        contents += [('내담자', f'{tag} 공통 문맥 {i} ' + '가' * 60), ('상담사', f'{tag} 짧은 응답 {i}')]
    contents += [('내담자', f'다른 질문 {cid}'), ('상담사', f'개별 응답 {cid} ' + '의견' * 40)]
    return fixtures.source_row(cid, split), fixtures.turns(contents, cid)


class AdmissionBoundaryTests(unittest.TestCase):
    def pipeline(self, specs):
        fixture = fixtures.SourceSftTests(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.fixture(specs)
        connections = []
        original_connect = source.connect
        def tracking_connect(path):
            connection = original_connect(path)
            connections.append(connection)
            return connection
        try:
            with patch.object(source, 'connect', side_effect=tracking_connect):
                source.build(fixture.release, fixture.database, fixture.output)
                audit = selection.audit(fixture.output, fixture.release, fixture.database)
        finally:
            for connection in connections:
                connection.close()
        path = fixture.root / 'selection.json'
        source.dump_json(path, audit)
        return fixture, audit, path

    def paired_text_pipeline(self, train_text, validation_text=None):
        validation_text = train_text if validation_text is None else validation_text
        return self.pipeline([
            (fixtures.source_row('train', 'train'), fixtures.turns([
                ('내담자', '학습 원천의 서로 다른 첫 질문입니다.'), ('상담사', train_text),
                ('내담자', '추가로 이어지는 학습 원천의 질문입니다.'),
                ('상담사', '다음에 이어지는 응답입니다. ' + '확인' * 40)], 'train')),
            (fixtures.source_row('validation', 'validation'), fixtures.turns([
                ('내담자', '검증 원천의 서로 다른 질문입니다.'), ('상담사', validation_text)], 'validation'))])

    def test_normalized_199_200_201_row_hold_and_group_threshold(self):
        for length in (199, 200, 201):
            with self.subTest(normalized_codepoints=length):
                fixture, audit, path = self.paired_text_pipeline('가' * length)
                result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
                self.assertEqual(len(result['held_validation_example_ids']), 1)
                expected_groups = [] if length == 199 else ['group-train', 'group-validation']
                self.assertEqual(result['quarantined_source_groups'], expected_groups)
                self.assertEqual(result['counts']['held_rows'], 1 if length == 199 else 3)
                self.assertEqual(result['counts']['both_hold_reasons_rows'], 0 if length == 199 else 1)

    def test_nfkc_expansion_composition_and_whitespace_length_before_policy(self):
        cases = [
            ('Ⅳ' * 100, 'IV' * 100, 200),
            (unicodedata.normalize('NFD', '가' * 199), '가' * 199, 199),
            ('가 ' + '나' * 196 + '  \t\n다', '가 ' + '나' * 196 + ' 다', 200),
        ]
        for train_text, validation_text, size in cases:
            with self.subTest(normalized_codepoints=size, raw_codepoints=len(train_text)):
                self.assertEqual(selection.normalize(train_text), selection.normalize(validation_text))
                self.assertEqual(len(selection.normalize(train_text)), size)
                fixture, audit, path = self.paired_text_pipeline(train_text, validation_text)
                matches = audit['bounded_cross_split_overlap']['whole_normalized_past_assistant_group']['matches']
                self.assertEqual(matches[0]['normalized_characters'], size)
                result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
                self.assertEqual(len(result['held_validation_example_ids']), 1)
                self.assertEqual(len(result['quarantined_source_groups']), 2 if size >= 200 else 0)

    def test_zero_width_and_near_duplicate_remain_outside_exact_match(self):
        for changed in ('가' * 100 + '\u200b' + '가' * 100, '가' * 199 + '나'):
            with self.subTest(changed=repr(changed[-3:])):
                fixture, audit, path = self.paired_text_pipeline('가' * 200, changed)
                self.assertNotEqual(selection.normalize('가' * 200), selection.normalize(changed))
                result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
                self.assertEqual(result['held_validation_example_ids'], [])
                self.assertEqual(result['quarantined_source_groups'], [])
                self.assertEqual(result['counts']['admitted_rows'], 3)

    def test_character_unit_is_codepoints_not_bytes_or_graphemes(self):
        self.assertEqual(len(selection.normalize('🙂' * 200)), 200)
        self.assertEqual(len(selection.normalize('🙂' * 200).encode('utf-8')), 800)
        self.assertEqual(len(selection.normalize('☀\ufe0f' * 100)), 200)

    def test_seven_total_context_messages_do_not_form_eight_block(self):
        self.assertEqual(selection.block_keys(messages(context(7))), {})

    def test_first_seven_eight_nine_shared_messages(self):
        for shared_count in (7, 8, 9):
            with self.subTest(shared_messages=shared_count):
                left = context(9)
                right = context(shared_count) + context(9, tag='other')[shared_count:]
                a, b = selection.block_keys(messages(left)), selection.block_keys(messages(right))
                self.assertEqual(a[FIRST] == b[FIRST], shared_count >= 8)
                self.assertEqual(a[RECENT] == b[RECENT], shared_count == 9)

    def test_first_eight_aggregate_normalized_199_200_201_characters(self):
        for size in (199, 200, 201):
            block = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': '가' * (size - 7 if i == 0 else 1)} for i in range(8)]
            keys = selection.block_keys(messages(block))
            self.assertEqual(FIRST in keys, size >= 200)
            self.assertEqual(RECENT in keys, size >= 200)

    def test_inserted_message_breaks_prefix_but_recent_block_can_still_match(self):
        base = context(9)
        inserted = [{'role': 'assistant', 'content': '새로 삽입한 시작 메시지'}] + copy.deepcopy(base)
        a, b = selection.block_keys(messages(base)), selection.block_keys(messages(inserted))
        self.assertNotEqual(a[FIRST], b[FIRST])
        self.assertEqual(a[RECENT], b[RECENT])
        internal = copy.deepcopy(base)
        internal.insert(4, {'role': 'user', 'content': '중간 삽입'})
        c = selection.block_keys(messages(internal))
        self.assertNotEqual(a[FIRST], c[FIRST])
        self.assertNotEqual(a[RECENT], c[RECENT])

    def test_unicode_equivalent_blocks_match_but_roles_and_message_boundaries_matter(self):
        left = context(8)
        right = [{**m, 'content': unicodedata.normalize('NFD', m['content']).replace('가', '가')} for m in left]
        self.assertEqual(selection.block_keys(messages(left)), selection.block_keys(messages(right)))
        right[3]['role'] = 'user'
        self.assertNotEqual(selection.block_keys(messages(left))[FIRST], selection.block_keys(messages(right))[FIRST])
        split = copy.deepcopy(left)
        split[3:4] = [{'role': 'assistant', 'content': left[3]['content'][:15]}, {'role': 'assistant', 'content': left[3]['content'][15:]}]
        self.assertNotEqual(selection.block_keys(messages(left))[FIRST], selection.block_keys(messages(split))[FIRST])

    def test_one_shared_block_preserves_all_source_groups(self):
        specs = [shared_prefix_spec('train_a', 'train'), shared_prefix_spec('train_b', 'train'),
                 shared_prefix_spec('val_a', 'validation')]
        fixture, audit, path = self.pipeline(specs)
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertEqual(result['quarantined_source_groups'], ['group-train_a', 'group-train_b', 'group-val_a'])
        self.assertEqual(result['counts']['admitted_rows'], 0)

    def legacy_audit(self, audit):
        audit = copy.deepcopy(audit)
        blocks = audit['bounded_cross_split_overlap'][FIRST]
        blocks.pop('source_inventory', None)
        for block in blocks['examples']:
            block.pop('train_sources', None)
            block.pop('validation_sources', None)
        return audit

    def test_legacy_single_origin_report_is_supported_after_full_source_scan(self):
        fixture, audit, path = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('val_a', 'validation')])
        source.dump_json(path, self.legacy_audit(audit))
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertTrue(result['legacy_first_eight_evidence'])
        self.assertTrue(result['first_eight_source_inventory_verified'])
        self.assertEqual(result['counts']['admitted_rows'], 0)

    def test_legacy_hidden_second_origin_fails_closed(self):
        fixture, audit, path = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('train_b', 'train'),
                                              shared_prefix_spec('val_a', 'validation')])
        source.dump_json(path, self.legacy_audit(audit))
        with self.assertRaisesRegex(ValueError, 'source inventory incomplete'):
            admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertFalse((fixture.root / 'admission').exists())

    def test_full_inventory_missing_second_origin_fails_closed(self):
        fixture, audit, path = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('train_b', 'train'),
                                              shared_prefix_spec('val_a', 'validation')])
        audit['bounded_cross_split_overlap'][FIRST]['examples'][0]['train_sources'].pop()
        source.dump_json(path, audit)
        with self.assertRaisesRegex(ValueError, 'source inventory incomplete'):
            admission.build_admission(fixture.output, path, fixture.root / 'admission')

    def test_every_inventory_row_is_validated_not_only_display_representative(self):
        fixture, audit, path = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('train_b', 'train'),
                                              shared_prefix_spec('val_a', 'validation')])
        records = audit['bounded_cross_split_overlap'][FIRST]['examples'][0]['train_sources']
        records[1]['row_id'] = records[0]['row_id']
        source.dump_json(path, audit)
        with self.assertRaisesRegex(ValueError, 'audit row origin mismatch'):
            admission.build_admission(fixture.output, path, fixture.root / 'admission')

    def test_missing_shared_hash_cannot_be_hidden_by_redeclaring_zero_count(self):
        fixture, audit, path = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('val_a', 'validation')])
        audit['bounded_cross_split_overlap'][FIRST].update(unique_shared_blocks=0, examples=[])
        source.dump_json(path, audit)
        with self.assertRaisesRegex(ValueError, 'shared block evidence incomplete'):
            admission.build_admission(fixture.output, path, fixture.root / 'admission')

    def test_partial_inventory_duplicate_origin_and_duplicate_hash_are_rejected(self):
        _, original, _ = self.pipeline([shared_prefix_spec('train_a', 'train'), shared_prefix_spec('val_a', 'validation')])
        for variant, pattern in [('partial', 'partial block source inventory'), ('duplicate_origin', 'duplicate block source conversation'),
                                 ('duplicate_hash', 'duplicate first-eight block evidence')]:
            audit = copy.deepcopy(original)
            blocks = audit['bounded_cross_split_overlap'][FIRST]
            block = blocks['examples'][0]
            if variant == 'partial':
                block.pop('validation_sources')
            elif variant == 'duplicate_origin':
                block['train_sources'].append(copy.deepcopy(block['train_sources'][0]))
            else:
                blocks['examples'].append(copy.deepcopy(block))
                blocks['unique_shared_blocks'] += 1
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, pattern):
                admission.rule_sets(audit)

    def test_recent_only_shared_block_is_observed_but_not_a_group_hold_rule(self):
        shared = shared_prefix_spec('unused', 'train')[1][:8]
        common = [(u['speaker'], u['text']) for u in shared] + [('내담자', '같은 후속 질문입니다.')]
        specs = []
        for cid, split in [('train', 'train'), ('val', 'validation')]:
            content = ([('상담사', '삽입된 짧은 시작 인사')] if split == 'train' else [])
            content += common + [('상담사', f'{cid}만의 다음 응답입니다. ' + '의견' * 40)]
            specs.append((fixtures.source_row(cid, split), fixtures.turns(content, cid)))
        fixture, audit, path = self.pipeline(specs)
        self.assertEqual(audit['bounded_cross_split_overlap'][FIRST]['unique_shared_blocks'], 0)
        self.assertEqual(audit['bounded_cross_split_overlap'][RECENT]['unique_shared_blocks'], 1)
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertEqual(result['quarantined_source_groups'], [])
        self.assertEqual(result['counts']['admitted_rows'], 2)

    def test_connected_long_matches_union_without_spreading_short_only_edges(self):
        specs = []
        for cid, text in [('train_a', '가' * 200), ('train_b', '나' * 201), ('train_c', '다' * 199)]:
            content = [('내담자', f'{cid}의 첫 질문'), ('상담사', text), ('내담자', f'{cid}의 이어지는 질문'),
                       ('상담사', fixtures.RESPONSE + f' {cid}')]
            specs.append((fixtures.source_row(cid, 'train'), fixtures.turns(content, cid)))
        va = [('내담자', 'va 첫 질문'), ('상담사', '가' * 200), ('내담자', 'va 둘째 질문'), ('상담사', '나' * 201),
              ('내담자', 'va 셋째 질문'), ('상담사', '다' * 199)]
        vb = [('내담자', 'vb 고유 질문'), ('상담사', '나' * 201)]
        specs += [(fixtures.source_row('val_a', 'validation'), fixtures.turns(va, 'val_a')),
                  (fixtures.source_row('val_b', 'validation'), fixtures.turns(vb, 'val_b'))]
        fixture, audit, path = self.pipeline(specs)
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertEqual(result['quarantined_source_groups'], ['group-train_a', 'group-train_b', 'group-val_a', 'group-val_b'])
        self.assertEqual(result['counts'], {'all_rows': 10, 'admitted_rows': 2, 'held_rows': 8,
                                          'group_quarantine_rows': 8, 'validation_target_hold_rows': 4,
                                          'partial_validation_target_hold_rows': 0, 'both_hold_reasons_rows': 4})
        kept = [r for r in source.read_rows(fixture.root / 'admission/admission_rows.jsonl.gz') if r['admitted']]
        self.assertEqual({r['source_group_id'] for r in kept}, {'group-train_c'})
        graph = selection.overlap_graph(audit['bounded_cross_split_overlap']['whole_normalized_past_assistant_group']['matches'], 200)
        self.assertEqual(len(graph['connected_components']), 1)
        self.assertEqual(graph['conversation_pairs'], 3)

    def test_twenty_one_shared_blocks_are_not_truncated(self):
        specs = []
        for i in range(21):
            specs.extend([shared_prefix_spec(f'train_{i:02}', 'train', f'block_{i:02}'),
                          shared_prefix_spec(f'val_{i:02}', 'validation', f'block_{i:02}')])
        fixture, audit, path = self.pipeline(specs)
        blocks = audit['bounded_cross_split_overlap'][FIRST]
        self.assertEqual(blocks['unique_shared_blocks'], 21)
        self.assertEqual(len(blocks['examples']), 21)
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertEqual(len(result['quarantined_source_groups']), 42)
        self.assertEqual(result['counts']['admitted_rows'], 0)


if __name__ == '__main__':
    unittest.main()
