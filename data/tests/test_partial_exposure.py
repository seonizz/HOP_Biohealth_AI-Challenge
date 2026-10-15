"""Synthetic exact-substring boundaries and admission propagation."""
import json
import unittest
import unicodedata

from counseling_pipeline import partial_exposure as partial
from counseling_pipeline import source_admission as admission
from counseling_pipeline import source_sft as source
from tests import test_round4_admission_boundaries as boundaries
from tests import test_source_sft as fixtures


def validation(text, identity="v"):
    return {"id": identity, "source_conversation_id": "cv", "source_group_id": "gv", "text": text}


class PartialExposureTests(unittest.TestCase):
    def test_threshold_detected_at_every_seed_alignment_and_preserves_origins(self):
        for size in (199, 200, 201):
            shared = "".join(chr(0xAC00 + i) for i in range(size))
            targets = [validation("左" * offset + shared + "右", str(offset)) for offset in range(50)]
            report = partial.audit_partial_exposure({"前" + shared + "後": {("ct", "gt", "target")}}, targets)
            self.assertEqual(report["held_validation_rows"], 0 if size == 199 else 50)
            for hit in report["matches"]:
                self.assertEqual(hit["max_shared_characters"], size)
                self.assertEqual(hit["matches"][0]["train_sources"][0]["role"], "target")
                self.assertEqual(hit["semantic_review"], "pending")
                self.assertFalse(hit["same_person_established"])

    def test_normalization_quotes_and_unicode_are_verified_without_exporting_text(self):
        shared = ('한글 "따옴표" 🙂 Ａ ' * 25).strip()
        equivalent = unicodedata.normalize('NFD', shared).replace(' ', '\t\n')
        report = partial.audit_partial_exposure({"처음 " + shared: {("ct", "gt", "past")}},
                                               [validation(equivalent + " 끝")])
        self.assertEqual(report["held_validation_rows"], 1)
        self.assertNotIn(shared, json.dumps(report, ensure_ascii=False))
        self.assertEqual(report["matches"][0]["max_shared_characters"], len(partial.normalize(shared)))

    def test_distinct_raw_messages_merge_normalized_origins_and_roles(self):
        shared = "가나다 " * 70
        report = partial.audit_partial_exposure({shared: {("c1", "g1", "past")},
            shared.replace(' ', '\n'): {("c2", "g2", "target")}}, [validation("앞" + shared + "뒤")])
        self.assertEqual(report["unique_train_assistant_messages"], 1)
        self.assertEqual(len(report["matches"][0]["matches"][0]["train_sources"]), 2)

    def test_discontinuous_short_and_different_text_are_not_long_exact_matches(self):
        report = partial.audit_partial_exposure({"가" * 199 + "나" + "다" * 199: {("ct", "gt", "past")}},
            [validation("가" * 199 + "라" + "다" * 199), validation("가" * 99, "short"), validation("마" * 500, "other")])
        self.assertEqual(report["held_validation_rows"], 0)
        self.assertEqual(report["short_targets_not_searched"], 1)

    def pipeline(self, specs):
        helper = boundaries.AdmissionBoundaryTests(methodName="runTest")
        self.addCleanup(helper.doCleanups)
        return helper.pipeline(specs)

    def test_build_holds_only_exposed_validation_target_without_changing_source(self):
        shared = "".join(chr(0xAC00 + i) for i in range(220))
        specs = [(fixtures.source_row("train", "train"), fixtures.turns([
            ("내담자", "학습 고유 질문"), ("상담사", "앞" + shared + "뒤")], "train")),
            (fixtures.source_row("validation", "validation"), fixtures.turns([
            ("내담자", "검증 고유 질문"), ("상담사", "다른 앞" + shared + "다른 뒤")], "validation"))]
        fixture, _, path = self.pipeline(specs)
        before = {p: source.sha_file(p) for p in fixture.output.rglob('*') if p.is_file()}
        output = fixture.root / 'admission'
        result = admission.build_admission(fixture.output, path, output)
        self.assertEqual(result['quarantined_source_groups'], [])
        self.assertEqual(result['held_validation_example_ids'], [])
        self.assertEqual(result['counts']['partial_validation_target_hold_rows'], 1)
        self.assertEqual(result['after']['train']['rows'], 1)
        self.assertEqual(result['after']['validation']['rows'], 0)
        rows = list(source.read_rows(output / 'admission_rows.jsonl.gz'))
        self.assertEqual(rows[1]['reasons'], [admission.PARTIAL_REASON])
        self.assertFalse(rows[1]['admitted'])
        self.assertEqual(before, {p: source.sha_file(p) for p in before})
        with self.assertRaisesRegex(ValueError, 'output already exists'):
            admission.build_admission(fixture.output, path, output)

    def test_previously_quarantined_train_messages_do_not_add_partial_holds(self):
        shared = "가" * 210
        specs = [(fixtures.source_row("train", "train"), fixtures.turns([
            ("내담자", "학습 질문"), ("상담사", shared), ("내담자", "다음 질문"),
            ("상담사", fixtures.RESPONSE)], "train"))]
        for cid, answer in [('exact', shared), ('partial', "앞" + shared + "뒤")]:
            specs.append((fixtures.source_row(cid, 'validation'), fixtures.turns([
                ('내담자', cid + ' 고유 질문'), ('상담사', answer)], cid)))
        fixture, _, path = self.pipeline(specs)
        result = admission.build_admission(fixture.output, path, fixture.root / 'admission')
        self.assertIn('group-train', result['quarantined_source_groups'])
        self.assertEqual(result['partial_overlap_held_validation_example_ids'], [])
        self.assertEqual(result['after']['validation']['rows'], 1)


if __name__ == '__main__':
    unittest.main()
