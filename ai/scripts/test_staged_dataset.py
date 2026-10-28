"""CPU-only contract tests for staged data, lazy token IO and checkpoint order."""
from contextlib import redirect_stdout
from copy import deepcopy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("staged_dataset", Path(__file__).with_name("staged_dataset.py"))
dataset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dataset)


class StagedDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.course = {"schema": dataset.SCHEMA, "phases": [], "optional_auxiliary": []}
        self.partitions = {}
        for position, identity in enumerate(dataset.PRIMARY_CHAIN):
            self.add_phase(identity, None if position == 0 else dataset.PRIMARY_CHAIN[position - 1])
        self.write_bundle()

    def add_phase(self, identity, predecessor, auxiliary=False):
        phase = {"id": identity, "task": "conversation", "initial_adapter_from": predecessor,
                 "weighting": "target_token_mean", "data": {}}
        for split in dataset.SPLITS:
            base = f"data/{identity}/{split}"
            phase["data"][split] = {"messages": base + ".messages.jsonl.gz",
                                    "index": base + ".index.jsonl", "tokens": base + ".tokens.bin",
                                    "rows": 2}
            rows, indexes, tokens, offset = [], [], [], 0
            for number in range(2):
                messages = [{"role": "system", "content": "Synthetic fixture."},
                            {"role": "user", "content": "A synthetic prompt."},
                            {"role": "assistant", "content": f"A synthetic answer {number}."}]
                target = hashlib.sha256(messages[-1]["content"].encode()).hexdigest()
                row = {"row_id": f"{identity}:{split}:{number}", "task": "conversation", "split": split,
                       "messages": messages, "loss_message_mask": [0, 0, 1],
                       "weight": {"numerator": 1, "denominator": 1},
                       "source_group_ids": [f"group:{identity}:{split}:{number}"],
                       "source_root_ids": [f"root:{identity}:{split}:{number}"],
                       "source_row_sha256": "a" * 64, "target_sha256": target}
                ids = [2, 20 + number, 30 + number, 40 + number, 1]
                index = {name: deepcopy(row[name]) for name in (
                    "row_id", "task", "split", "weight", "source_group_ids", "source_root_ids",
                    "source_row_sha256", "target_sha256")}
                index.update(offset_tokens=offset, prefix_length=2, target_length=3,
                             sequence_length=5, messages_sha256=dataset.messages_digest(messages))
                rows.append(row)
                indexes.append(index)
                tokens.extend(ids)
                offset += len(ids)
            self.partitions[(identity, split)] = {"rows": rows, "indexes": indexes, "tokens": tokens}
        self.course["optional_auxiliary" if auxiliary else "phases"].append(phase)

    def write_bundle(self):
        (self.root / "COURSE.json").write_text(json.dumps(self.course), encoding="utf-8")
        counts = {}
        for phase in self.course["phases"] + self.course["optional_auxiliary"]:
            counts[phase["id"]] = {}
            for split in dataset.SPLITS:
                config = phase["data"][split]
                values = self.partitions[(phase["id"], split)]
                messages = self.root / config["messages"]
                messages.parent.mkdir(parents=True, exist_ok=True)
                with gzip.open(messages, "wt", encoding="utf-8") as handle:
                    handle.writelines(json.dumps(row) + "\n" for row in values["rows"])
                (self.root / config["index"]).write_text(
                    "".join(json.dumps(index) + "\n" for index in values["indexes"]), encoding="utf-8")
                (self.root / config["tokens"]).write_bytes(
                    struct.pack("<" + "I" * len(values["tokens"]), *values["tokens"]))
                counts[phase["id"]][split] = len(values["rows"])
        files = {str(path.relative_to(self.root)): {"bytes": path.stat().st_size,
                                                   "sha256": dataset.digest(path)}
                 for path in self.root.rglob("*")
                 if path.is_file() and path.name != "DATASET_MANIFEST.json"}
        manifest = {"files": files, "phase_counts": counts}
        (self.root / "DATASET_MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")

    def values(self, phase="01_original", split="train"):
        return self.partitions[(phase, split)]

    def add_provenance(self):
        ledger, admissions = [], []
        for split in dataset.SPLITS:
            values = self.values(split=split)
            for row, index in zip(values["rows"], values["indexes"]):
                identity = {"id": row["row_id"], "split": split,
                            "source_group_id": row["source_group_ids"][0],
                            "source_conversation_id": row["source_root_ids"][0]}
                ledger.append({**identity, "eligible": True, "source_admitted": True,
                               "source_reasons": [], "hold_reasons": [], "chosen": False,
                               "source_row_sha256": row["source_row_sha256"],
                               "target_sha256": row["target_sha256"],
                               **{name: index[name] for name in (
                                   "prefix_length", "target_length", "sequence_length")}})
                admissions.append({**identity, "admitted": True, "reasons": []})
        self.write_provenance(ledger, admissions)
        return ledger, admissions

    def write_provenance(self, ledger, admissions):
        for name, records in ((dataset.PROVENANCE_LEDGER, ledger),
                              (dataset.PROVENANCE_ADMISSIONS, admissions)):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8") as handle:
                handle.writelines(json.dumps(record) + "\n" for record in records)
        self.write_bundle()

    def test_valid_bundle_and_inspect_report_no_source_text_or_compute_imports(self):
        before = set(sys.modules)
        report = dataset.verify(self.root)
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["primary_chain"], list(dataset.PRIMARY_CHAIN))
        self.assertEqual(report["phases"]["01_original"]["counts"], {"train": 2, "validation": 2})
        with redirect_stdout(io.StringIO()) as output:
            inspected = dataset.main(["inspect", "--root", str(self.root),
                                      "--phase", "01_original", "--split", "train"])
        self.assertEqual(inspected["rows"], 2)
        self.assertEqual(inspected["target_tokens"], 6)
        self.assertNotIn("synthetic answer", output.getvalue())
        self.assertFalse({"torch", "transformers", "peft", "bitsandbytes"} & (set(sys.modules) - before))

    def test_random_access_constructs_only_final_answer_labels(self):
        config = self.course["phases"][0]["data"]["train"]
        rows = dataset.IndexedDataset(self.root / config["index"], self.root / config["tokens"])
        self.assertEqual(len(rows), 2)
        self.assertNotIn("encoded", rows._entries[0])
        self.assertEqual(rows[1]["encoded"], {
            "input_ids": [2, 21, 31, 41, 1], "labels": [-100, -100, 31, 41, 1],
            "attention_mask": [1, 1, 1, 1, 1], "prefix_length": 2,
            "target_length": 3, "sequence_length": 5})
        self.assertEqual(rows[-1], rows[1])
        self.assertEqual(rows[0]["stream"], "conversation")
        self.assertEqual(rows[0]["encoded"]["labels"], [-100, -100, 30, 40, 1])
        with self.assertRaises(IndexError):
            rows[2]
        changed = rows[0]
        changed["weight"]["numerator"] = 99
        changed["source_group_ids"].append("changed")
        self.assertEqual(rows[0]["weight"]["numerator"], 1)
        self.assertEqual(len(rows[0]["source_group_ids"]), 1)

    def test_assistant_first_source_context_is_preserved(self):
        row = self.values()["rows"][0]
        row["messages"].insert(1, {"role": "assistant", "content": "An earlier synthetic answer."})
        row["loss_message_mask"] = [0, 0, 0, 1]
        index = self.values()["indexes"][0]
        index["messages_sha256"] = dataset.messages_digest(row["messages"])
        original = deepcopy(row)
        self.write_bundle()
        self.assertEqual(dataset.verify(self.root)["status"], "passed")
        self.assertEqual(row, original)
        config = self.course["phases"][0]["data"]["train"]
        with gzip.open(self.root / config["messages"], "rt", encoding="utf-8") as handle:
            stored = json.loads(next(handle))
        self.assertEqual(stored, original)
        self.assertEqual([message["role"] for message in stored["messages"]],
                         ["system", "assistant", "user", "assistant"])

    def test_rejects_consecutive_same_role_turns(self):
        original = deepcopy(self.values())
        for inserted in (["user"], ["assistant", "assistant"]):
            with self.subTest(inserted=inserted):
                self.partitions[("01_original", "train")] = deepcopy(original)
                row = self.values()["rows"][0]
                row["messages"][1:1] = [{"role": role, "content": "Synthetic prefix."}
                                         for role in inserted]
                row["loss_message_mask"] = [0] * (len(row["messages"]) - 1) + [1]
                self.values()["indexes"][0]["messages_sha256"] = dataset.messages_digest(row["messages"])
                self.write_bundle()
                with self.assertRaisesRegex(ValueError, "message roles"):
                    dataset.verify(self.root)

    def test_rejects_loss_on_prompt_or_boolean_mask(self):
        for mask in ([0, 1, 1], [0, 0, 0], [False, False, True]):
            with self.subTest(mask=mask):
                self.values()["rows"][0]["loss_message_mask"] = mask
                self.write_bundle()
                with self.assertRaisesRegex(ValueError, "Loss message mask"):
                    dataset.verify(self.root)

    def test_rejects_cross_phase_source_group_and_root_split_leaks(self):
        for name in ("source_group_ids", "source_root_ids"):
            with self.subTest(name=name):
                original = deepcopy(self.values("02b_service_wire", "validation"))
                collision = self.values()["rows"][0][name]
                changed = self.values("02b_service_wire", "validation")
                changed["rows"][0][name] = collision
                changed["indexes"][0][name] = collision
                self.write_bundle()
                with self.assertRaisesRegex(ValueError, "overlaps train and validation"):
                    dataset.verify(self.root)
                self.partitions[("02b_service_wire", "validation")] = original

    def test_rejects_checksum_mismatch_before_content_is_used(self):
        config = self.course["phases"][0]["data"]["train"]
        with (self.root / config["tokens"]).open("ab") as handle:
            handle.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "File checksum mismatch"):
            dataset.verify(self.root)

    def test_rejects_gap_offsets_and_trailing_or_truncated_binary(self):
        original = deepcopy(self.values())
        self.values()["indexes"][1]["offset_tokens"] += 1
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Non-contiguous token offset"):
            dataset.verify(self.root)
        self.partitions[("01_original", "train")] = deepcopy(original)
        self.values()["tokens"].append(10)
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Trailing bytes"):
            dataset.verify(self.root)
        self.partitions[("01_original", "train")] = deepcopy(original)
        self.values()["tokens"].pop()
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Truncated token binary"):
            dataset.verify(self.root)

    def test_rejects_checkpoint_skip_or_main_phase_reordering(self):
        original = deepcopy(self.course)
        self.course["phases"][2]["initial_adapter_from"] = "01_original"
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "checkpoint predecessor"):
            dataset.verify(self.root)
        self.course = original
        self.course["phases"][1], self.course["phases"][2] = self.course["phases"][2], self.course["phases"][1]
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "exact three-phase chain"):
            dataset.verify(self.root)

    def test_new_lora_flag_requires_initialization_only_at_first_primary_phase(self):
        for position, phase in enumerate(self.course["phases"]):
            phase["new_lora"] = position == 0
        self.write_bundle()
        self.assertEqual(dataset.verify(self.root)["status"], "passed")
        for position in range(3):
            with self.subTest(position=position):
                self.course["phases"][position]["new_lora"] = position != 0
                self.write_bundle()
                with self.assertRaisesRegex(ValueError, "New LoRA initialization"):
                    dataset.verify(self.root)
                self.course["phases"][position]["new_lora"] = position == 0

    def test_original_provenance_covers_eligible_rows_without_sampling(self):
        ledger, _ = self.add_provenance()
        self.assertTrue(all(row["chosen"] is False for row in ledger))
        report = dataset.verify(self.root)
        self.assertTrue(report["original_provenance_bound"])
        self.assertEqual(report["original_provenance_source_rows"], 4)

    def test_rejects_orphan_lineage_even_when_message_index_and_file_hashes_agree(self):
        self.add_provenance()
        for kind in ("rows", "indexes"):
            self.values()[kind][0]["source_group_ids"] = ["orphan-group-with-no-split-collision"]
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "differs from pinned provenance: source_group_ids"):
            dataset.verify(self.root)

    def test_rejects_token_length_or_source_hash_drift_from_provenance(self):
        self.add_provenance()
        original = deepcopy(self.values())
        self.values()["indexes"][0]["prefix_length"] += 1
        self.values()["indexes"][0]["target_length"] -= 1
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "token lengths differ from pinned provenance"):
            dataset.verify(self.root)
        self.partitions[("01_original", "train")] = original
        for kind in ("rows", "indexes"):
            self.values()[kind][0]["source_row_sha256"] = "b" * 64
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "differs from pinned provenance: source_row_sha256"):
            dataset.verify(self.root)

    def test_rejects_omitted_eligible_row_even_when_historical_chosen_is_false(self):
        ledger, admissions = self.add_provenance()
        extra = {**ledger[0], "id": "extra-eligible-row", "source_group_id": "extra-group",
                 "source_conversation_id": "extra-conversation"}
        ledger.append(extra)
        admissions.append({**admissions[0], **{name: extra[name] for name in (
            "id", "source_group_id", "source_conversation_id")}})
        self.write_provenance(ledger, admissions)
        with self.assertRaisesRegex(ValueError, "inventory differs from all eligible provenance rows"):
            dataset.verify(self.root)

    def test_rejects_held_row_and_inconsistent_eligible_decision(self):
        ledger, admissions = self.add_provenance()
        ledger[0]["hold_reasons"] = ["requires-review"]
        self.write_provenance(ledger, admissions)
        with self.assertRaisesRegex(ValueError, "has hold reasons"):
            dataset.verify(self.root)
        ledger[0]["eligible"] = False
        self.write_provenance(ledger, admissions)
        with self.assertRaisesRegex(ValueError, "absent or ineligible in pinned provenance"):
            dataset.verify(self.root)

    def test_rejects_missing_partner_ledger_and_disagreeing_admission_identity(self):
        ledger, admissions = self.add_provenance()
        admissions[0]["source_group_id"] = "different-admission-group"
        self.write_provenance(ledger, admissions)
        with self.assertRaisesRegex(ValueError, "provenance identity mismatch"):
            dataset.verify(self.root)
        (self.root / dataset.PROVENANCE_ADMISSIONS).unlink()
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Both original provenance ledgers"):
            dataset.verify(self.root)

    def test_auxiliary_is_separate_but_still_part_of_split_audit(self):
        self.add_phase("aux_sentence", "01_original", auxiliary=True)
        self.write_bundle()
        result = dataset.verify(self.root)
        self.assertIn("aux_sentence", result["phases"])
        self.assertNotIn("aux_sentence", result["primary_chain"])
        for key in ("rows", "indexes"):
            self.values("aux_sentence", "validation")[key][0]["source_root_ids"] = [
                self.values()["rows"][0]["source_root_ids"][0]]
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "overlaps train and validation"):
            dataset.verify(self.root)

    def test_rejects_target_hash_or_message_hash_mismatch(self):
        original = deepcopy(self.values())
        self.values()["rows"][0]["messages"][-1]["content"] = "Changed target."
        self.values()["indexes"][0]["messages_sha256"] = dataset.messages_digest(
            self.values()["rows"][0]["messages"])
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "target hash mismatch"):
            dataset.verify(self.root)
        self.partitions[("01_original", "train")] = original
        self.values()["rows"][0]["messages"][1]["content"] = "Changed prompt."
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Messages hash differs"):
            dataset.verify(self.root)

    def test_rejects_non_reduced_weight_and_changed_weighted_target_mass(self):
        for weight, error in (({"numerator": 2, "denominator": 2}, "reduced positive"),
                              ({"numerator": 2, "denominator": 1}, "Weighted target-token mass")):
            with self.subTest(weight=weight):
                for key in ("rows", "indexes"):
                    self.values()[key][0]["weight"] = weight
                self.write_bundle()
                with self.assertRaisesRegex(ValueError, error):
                    dataset.verify(self.root)

    def test_rejects_out_of_vocab_and_excessive_prefix(self):
        self.values()["tokens"][0] = dataset.VOCAB_SIZE
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "outside the tokenizer vocabulary"):
            dataset.verify(self.root)
        self.values()["tokens"][0] = 2
        self.values()["indexes"][0]["prefix_length"] = dataset.MAX_PREFIX + 1
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "token lengths"):
            dataset.verify(self.root)

    def test_rejects_unsafe_manifest_paths_and_data_symlink(self):
        manifest_path = self.root / "DATASET_MANIFEST.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["../outside.json"] = {"bytes": 0, "sha256": "a" * 64}
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "Unsafe bundle path"):
            dataset.verify(self.root)
        self.write_bundle()
        config = self.course["phases"][0]["data"]["train"]
        path = self.root / config["tokens"]
        target = path.with_name("replacement.bin")
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            dataset.verify(self.root)


if __name__ == "__main__":
    unittest.main()
