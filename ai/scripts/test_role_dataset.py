"""CPU-only regression tests for role exports, using fabricated text only."""
from copy import deepcopy
from fractions import Fraction
import hashlib
import importlib.util
import gzip
import json
from pathlib import Path
import struct
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "role_dataset", Path(__file__).with_name("role_dataset.py"))
dataset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dataset)


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def row(identity="row-a", task="dialogue", split="train", groups=None, roots=None):
    target = "A fabricated response for " + identity + "."
    return {
        "row_id": identity,
        "task": task,
        "split": split,
        "messages": [
            {"role": "system", "content": "A fictional formatting task."},
            {"role": "user", "content": "Please label the fictional example."},
            {"role": "assistant", "content": target},
        ],
        "loss_message_mask": [0, 0, 1],
        "weight": {"numerator": 1, "denominator": 1},
        "source_group_ids": groups if groups is not None else ["group-" + identity],
        "source_root_ids": roots if roots is not None else ["root-" + identity],
        "source_row_sha256": hashlib.sha256(identity.encode()).hexdigest(),
        "target_sha256": hashlib.sha256(target.encode()).hexdigest(),
        "provenance": [{"source_row_id": identity}],
    }


def set_message(example, index, value):
    example["messages"][index]["content"] = json_text(value)
    if index == -1 or index == len(example["messages"]) - 1:
        example["target_sha256"] = hashlib.sha256(
            example["messages"][index]["content"].encode()).hexdigest()


def wire_row(identity="review-a", fields=None, stage="speech_review"):
    example = row(identity, "relationship_agent_wire")
    guide = {
        "top": "통합",
        "script": "Would you like to choose the next book together?",
        "doList": ["Ask which chapter they want to discuss."],
        "avoid": ["Avoid assigning a chapter without asking; offer a choice."],
        "next": "If they want another time, ask when the book club can meet.",
        "care": {"feel": "You said you were busy planning the book club.",
                 "tips": ["Choose a planning time that works for you."]},
    }
    fields = fields if fields is not None else ["script", "doList", "avoid", "next", "care"]
    claims = [{"id": field + ".0", "field": field,
               "claim": "Fictional claim for " + field, "certainty": "reported"}
              for field in fields]
    user = {"stage": stage, "data": {
        "answers": {"patient": [], "supporter": [{
            "subject": "supporter", "question_id": "book_club",
            "question": "What would you like to arrange?", "status": "answered",
            "answers": [{"origin": "answer_snapshot", "fields": ["rawText", "text"],
                         "question": "What would you like to arrange?",
                         "text": "I am arranging a fictional book club."}],
        }], "user_goal": []},
        "retrieval": {"documents": [{"text": "A fictional book club is being arranged."}]},
        "guide": guide,
        "script": guide["script"],
        "plan": {"draft_only": "Draft instructions must not become evidence."},
        "claims": claims,
    }, "output_schema": {"type": "object"}}
    review = {"approved": True, "issues": [], "audits": [
        {"id": claim["id"], "verdict": "supported", "reason": "Fixture-only approval."}
        for claim in claims]}
    set_message(example, 1, user)
    set_message(example, -1, review)
    return example


class RowContractTests(unittest.TestCase):
    def test_valid_row_and_final_only_multi_turn_mask(self):
        example = row()
        dataset.check_row(example)
        example["messages"][1:1] = [
            {"role": "user", "content": "An earlier fictional question."},
            {"role": "assistant", "content": "An earlier answer used only as context."},
        ]
        example["loss_message_mask"] = [0, 0, 0, 0, 1]
        dataset.check_row(example)
        example["loss_message_mask"][2] = 1
        with self.assertRaises(ValueError):
            dataset.check_row(example)

    def test_masks_are_strict_integers_and_exact_length(self):
        for mask in ([0, 0, True], [False, 0, 1], [0, 0, 1.0], [0, 1], [0, 0, 0]):
            with self.subTest(mask=mask):
                example = row()
                example["loss_message_mask"] = mask
                with self.assertRaises(ValueError):
                    dataset.check_row(example)

    def test_changed_target_hash_is_rejected(self):
        example = row()
        example["messages"][-1]["content"] += " Changed after hashing."
        with self.assertRaises(ValueError):
            dataset.check_row(example)

    def test_unknown_split_empty_lineage_and_nonpositive_weight_are_rejected(self):
        for field, value in (
            ("split", "evaluation"),
            ("source_group_ids", []),
            ("source_root_ids", []),
            ("weight", {"numerator": 0, "denominator": 1}),
            ("weight", {"numerator": 1, "denominator": 0}),
            ("weight", {"numerator": True, "denominator": 1}),
        ):
            with self.subTest(field=field, value=value):
                example = row()
                example[field] = value
                with self.assertRaises(ValueError):
                    dataset.check_row(example)


class ApprovedCardTests(unittest.TestCase):
    def assert_not_derived(self, example):
        # Malformed review data may fail closed or yield no eligible fields.
        try:
            self.assertEqual(dataset.derive_cards(example), [])
        except ValueError:
            pass

    def test_approval_covers_only_claimed_fields_not_top(self):
        example = wire_row(fields=["script", "care"])
        self.assertEqual(set(dataset.approved_fields(example)), {"script", "care"})
        self.assertNotIn("top", dataset.approved_fields(example))

    def test_all_supported_fields_are_derived_without_source_mutation(self):
        example = wire_row()
        before = deepcopy(example)
        user = json.loads(example["messages"][1]["content"])
        cards = dataset.derive_cards(example)
        self.assertEqual(len(cards), 5)
        self.assertEqual(example, before)
        for card in cards:
            dataset.check_row(card)
            request = json.loads(card["messages"][1]["content"])
            target = json.loads(card["messages"][-1]["content"])
            self.assertEqual(len(target), 1)
            field = next(iter(target))
            self.assertEqual(request["stage"], "final_card_" + field)
            self.assertEqual(target[field], user["data"]["guide"][field])
            self.assertEqual(set(request["data"]), {"answers", "retrieval"})
            self.assertEqual(request["data"]["answers"], user["data"]["answers"])
            self.assertEqual(request["data"]["retrieval"], {
                "method": "all_current_answers_v1", "documents": [{
                    "subject": "supporter", "question_id": "book_club",
                    "origin": "answer_snapshot", "fields": ["rawText", "text"],
                    "question": "What would you like to arrange?",
                    "text": "I am arranging a fictional book club.",
                }],
            })
            self.assertEqual(card["source_group_ids"], example["source_group_ids"])
            self.assertEqual(card["source_root_ids"], example["source_root_ids"])
            self.assertEqual(card["split"], example["split"])
            self.assertEqual(card["loss_message_mask"], [0, 0, 1])
            self.assertTrue(card["provenance"])

    def test_rejected_review_never_becomes_positive_card_data(self):
        example = wire_row()
        review = json.loads(example["messages"][-1]["content"])
        review["approved"] = False
        review["issues"] = [{"field": "script", "reason": "Fixture contradiction."}]
        set_message(example, -1, review)
        self.assert_not_derived(example)

    def test_truthy_non_boolean_approval_is_rejected(self):
        for approved in (1, "true"):
            with self.subTest(approved=approved):
                example = wire_row()
                review = json.loads(example["messages"][-1]["content"])
                review["approved"] = approved
                set_message(example, -1, review)
                self.assert_not_derived(example)

    def test_incomplete_extra_duplicate_or_rejected_audit_is_rejected(self):
        for mutation in ("missing", "extra", "duplicate", "unsupported", "plausible"):
            with self.subTest(mutation=mutation):
                example = wire_row()
                review = json.loads(example["messages"][-1]["content"])
                if mutation == "missing":
                    review["audits"].pop()
                elif mutation == "extra":
                    review["audits"].append({"id": "unclaimed.0", "verdict": "supported"})
                elif mutation == "duplicate":
                    review["audits"].append(deepcopy(review["audits"][0]))
                else:
                    review["audits"][0]["verdict"] = mutation
                set_message(example, -1, review)
                self.assert_not_derived(example)

    def test_positive_flag_with_outstanding_issues_is_rejected(self):
        example = wire_row()
        review = json.loads(example["messages"][-1]["content"])
        review["issues"] = [{"field": "care", "reason": "Still unresolved."}]
        set_message(example, -1, review)
        self.assert_not_derived(example)

    def test_duplicate_claim_ids_are_rejected(self):
        example = wire_row()
        user = json.loads(example["messages"][1]["content"])
        user["data"]["claims"].append(deepcopy(user["data"]["claims"][0]))
        set_message(example, 1, user)
        self.assert_not_derived(example)

    def test_non_review_stage_cannot_supply_approval(self):
        self.assert_not_derived(wire_row(stage="unrecognized_stage"))

    def test_unknown_claim_field_cannot_supply_card_supervision(self):
        example = wire_row(fields=["invented_field"])
        self.assert_not_derived(example)

    def test_missing_reviewed_guide_field_is_not_invented(self):
        example = wire_row(fields=["care"])
        user = json.loads(example["messages"][1]["content"])
        del user["data"]["guide"]["care"]
        set_message(example, 1, user)
        self.assert_not_derived(example)

    def test_conflicting_script_references_are_not_positive_script_targets(self):
        example = wire_row(fields=["script"])
        user = json.loads(example["messages"][1]["content"])
        user["data"]["script"] = "A different unreviewed script."
        set_message(example, 1, user)
        self.assert_not_derived(example)

    def test_support_review_and_sound_guidance_verdict(self):
        example = wire_row(fields=["next", "care"], stage="support_review_after_repair")
        review = json.loads(example["messages"][-1]["content"])
        for audit in review["audits"]:
            audit["verdict"] = "sound_guidance"
        set_message(example, -1, review)
        self.assertEqual(set(dataset.approved_fields(example)), {"next", "care"})

    def test_legacy_avoid_target_is_preserved_as_saved_strings(self):
        example = wire_row(fields=["avoid"])
        target = json.loads(dataset.derive_cards(example)[0]["messages"][-1]["content"])
        self.assertTrue(all(isinstance(item, str) for item in target["avoid"]))

    def test_target_conditioned_legacy_retrieval_cannot_change_generation_messages(self):
        example = wire_row()
        baseline = dataset.derive_cards(example)
        request = json.loads(example["messages"][1]["content"])
        request["data"]["retrieval"] = {
            "stage": "speech_review", "retrieved_for": "draft_only",
            "claims": [{"claim": request["data"]["guide"]["script"]}],
            "documents": [{"text": "Target-dependent text absent from source answers.",
                           "draft": request["data"]["guide"], "cited_source": True, "score": 99}],
        }
        set_message(example, 1, request)
        derived = dataset.derive_cards(example)
        self.assertEqual([card["messages"] for card in derived],
                         [card["messages"] for card in baseline])
        for card in derived:
            payload = json.loads(card["messages"][1]["content"])
            self.assertNotIn("Target-dependent", json_text(payload))

    def test_valid_answers_do_not_require_historical_retrieval(self):
        example = wire_row()
        baseline = dataset.derive_cards(example)
        request = json.loads(example["messages"][1]["content"])
        del request["data"]["retrieval"]
        set_message(example, 1, request)
        self.assertEqual([card["messages"] for card in dataset.derive_cards(example)],
                         [card["messages"] for card in baseline])

    def test_empty_or_skipped_answers_cannot_produce_generation_supervision(self):
        for mode in ("empty", "skipped", "whitespace"):
            with self.subTest(mode=mode):
                example = wire_row()
                request = json.loads(example["messages"][1]["content"])
                if mode == "empty":
                    request["data"]["answers"] = {"patient": [], "supporter": [], "user_goal": []}
                elif mode == "skipped":
                    source = request["data"]["answers"]["supporter"][0]
                    source["status"] = "auto_skipped"
                    source["answers"] = []
                else:
                    request["data"]["answers"]["supporter"][0]["answers"][0]["text"] = "  \n "
                set_message(example, 1, request)
                self.assert_not_derived(example)


class DeduplicationTests(unittest.TestCase):
    def test_duplicate_messages_merge_lineage_and_provenance(self):
        first = row("first")
        second = row("second")
        second["messages"] = deepcopy(first["messages"])
        second["target_sha256"] = first["target_sha256"]
        original = deepcopy([first, second])
        result = dataset.deduplicate([first, second])
        self.assertEqual(len(result), 1)
        self.assertEqual(set(result[0]["source_group_ids"]), {"group-first", "group-second"})
        self.assertEqual(set(result[0]["source_root_ids"]), {"root-first", "root-second"})
        self.assertEqual(len(result[0]["provenance"]), 2)
        self.assertEqual([first, second], original)

    def test_splits_and_tasks_are_never_combined(self):
        first = row()
        validation = deepcopy(first)
        validation["split"] = "validation"
        different_task = deepcopy(first)
        different_task["task"] = "another_task"
        self.assertEqual(len(dataset.deduplicate([first, validation, different_task])), 3)

    def test_same_prompt_with_different_targets_is_not_silently_discarded(self):
        self.assertEqual(len(dataset.deduplicate([row("first"), row("second")])), 2)


class BalanceTests(unittest.TestCase):
    @staticmethod
    def weight(example):
        return Fraction(**example["weight"])

    def test_exact_task_and_family_balance(self):
        examples = [row("a1", "task-a", groups=["shared-a"]),
                    row("a2", "task-a", groups=["shared-a"]),
                    row("b1", "task-a"), row("c1", "task-b")]
        before = deepcopy(examples)
        result = dataset.balance(examples)
        weights = {r["row_id"]: self.weight(r) for r in result}
        self.assertEqual(sum(weights.values()), 4)
        self.assertEqual(weights, {"a1": Fraction(1, 2), "a2": Fraction(1, 2),
                                   "b1": Fraction(1), "c1": Fraction(2)})
        self.assertEqual(examples, before)

    def test_multi_group_bridge_forms_one_connected_family(self):
        examples = [row("left", groups=["g-left"]),
                    row("bridge", groups=["g-left", "g-right"]),
                    row("right", groups=["g-right"]),
                    row("independent", groups=["g-independent"])]
        result = {r["row_id"]: self.weight(r) for r in dataset.balance(examples)}
        self.assertEqual(result, {"left": Fraction(2, 3), "bridge": Fraction(2, 3),
                                  "right": Fraction(2, 3), "independent": Fraction(2)})

    def test_shared_root_also_links_a_family(self):
        examples = [row("a", roots=["common-root"]),
                    row("b", roots=["common-root"]), row("c")]
        result = {r["row_id"]: self.weight(r) for r in dataset.balance(examples)}
        self.assertEqual(result, {"a": Fraction(3, 4), "b": Fraction(3, 4),
                                  "c": Fraction(3, 2)})

    def test_validation_cannot_change_training_weights(self):
        training = [row("a", groups=["g"]), row("b", groups=["g"]), row("c")]
        validation = [row("v1", split="validation"), row("v2", split="validation")]
        alone = {r["row_id"]: self.weight(r) for r in dataset.balance(training)}
        combined = {r["row_id"]: self.weight(r) for r in dataset.balance(training + validation)}
        self.assertEqual({key: combined[key] for key in alone}, alone)
        self.assertEqual(combined["v1"] + combined["v2"], 2)


class OriginalSelectionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.train = [row("shared-opener", "original_counselor_continuation", groups=["family-a"]),
                      row("keep-a", "original_counselor_continuation", groups=["family-a"]),
                      row("keep-b", "original_counselor_continuation", groups=["family-a"]),
                      row("keep-c", "original_counselor_continuation", groups=["family-c"])]
        self.validation = [row("validation-opener", "original_counselor_continuation", "validation")]
        for example in self.train:
            example["messages"][1]["content"] = "Fictional prompt for " + example["row_id"]
        self.validation[0]["messages"][:-1] = deepcopy(self.train[0]["messages"][:-1])
        self.phase = {"data": {}}
        for split, examples in (("train", self.train), ("validation", self.validation)):
            messages_path = self.root / f"{split}.messages.jsonl.gz"
            index_path = self.root / f"{split}.index.jsonl"
            with gzip.open(messages_path, "wt", encoding="utf-8") as handle:
                handle.writelines(json_text(example) + "\n" for example in examples)
            indexes = []
            for example in examples:
                index = {key: deepcopy(example[key]) for key in (
                    "row_id", "task", "split", "source_group_ids", "source_root_ids", "weight")}
                index.update(prefix_length=3, target_length=2, sequence_length=5)
                indexes.append(index)
            index_path.write_text("".join(json_text(index) + "\n" for index in indexes), encoding="utf-8")
            self.phase["data"][split] = {"messages": messages_path.name, "index": index_path.name}

    def test_exact_shared_input_holds_training_id_despite_different_target(self):
        self.assertNotEqual(self.train[0]["messages"][-1], self.validation[0]["messages"][-1])
        held = dataset.shared_original_inputs(self.root, self.phase)
        self.assertEqual(held, {"shared-opener"})
        self.assertNotIn("validation-opener", held)
        validation = list(dataset.original_rows(self.root, self.phase, "validation", set()))
        self.assertEqual([item["row_id"] for item in validation], ["validation-opener"])
        self.assertEqual(validation[0]["split"], "validation")
        self.assertEqual(validation[0]["messages"], self.validation[0]["messages"])

    def test_selected_and_held_rows_preserve_full_inventory_and_source_bytes(self):
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        held = dataset.shared_original_inputs(self.root, self.phase)
        selected = list(dataset.original_rows(self.root, self.phase, "train", held))
        excluded = list(dataset.original_rows(self.root, self.phase, "train", held, hold_only=True))
        selected_ids = {item["row_id"] for item in selected}
        held_ids = {item["row_id"] for item in excluded}
        self.assertFalse(selected_ids & held_ids)
        self.assertEqual(selected_ids | held_ids, {item["row_id"] for item in self.train})
        originals = {item["row_id"]: item for item in self.train}
        for example in selected + excluded:
            original = originals[example["row_id"]]
            self.assertEqual(example["split"], "train")
            self.assertEqual(example["messages"], original["messages"])
            self.assertEqual(example["loss_message_mask"], original["loss_message_mask"])
            self.assertEqual(example["source_weight"], original["weight"])
            self.assertEqual(example["reference_gemma31b_lengths"],
                             {"prefix_length": 3, "target_length": 2, "sequence_length": 5})
        self.assertEqual({path.name: path.read_bytes() for path in self.root.iterdir()}, before)

    def test_family_weights_are_recomputed_after_holding_a_shared_opener(self):
        held = dataset.shared_original_inputs(self.root, self.phase)
        selected = list(dataset.original_rows(self.root, self.phase, "train", held))
        weights = {item["row_id"]: Fraction(**item["weight"]) for item in selected}
        self.assertEqual(weights, {"keep-a": Fraction(3, 4), "keep-b": Fraction(3, 4),
                                   "keep-c": Fraction(3, 2)})
        excluded = list(dataset.original_rows(self.root, self.phase, "train", held, hold_only=True))
        self.assertEqual(Fraction(**excluded[0]["weight"]), 1)


class IndexedTokenTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.index = self.root / "tokens.index.jsonl"
        self.binary = self.root / "tokens.bin"
        self.entries = [
            {"row_id": "first", "offset_tokens": 0, "prefix_length": 2,
             "target_length": 2, "sequence_length": 4, "target_boundary_whitespace_trimmed": False},
            {"row_id": "second", "offset_tokens": 4, "prefix_length": 1,
             "target_length": 2, "sequence_length": 3, "target_boundary_whitespace_trimmed": True},
        ]
        self.ids = [2, 65536, 123456, 1, 10, 262143, 1]
        self.write_files()

    def write_files(self):
        self.index.write_text("".join(json_text(item) + "\n" for item in self.entries), encoding="utf-8")
        self.binary.write_bytes(struct.pack("<" + "I" * len(self.ids), *self.ids))

    def test_uint32_little_endian_offsets_and_final_target_labels(self):
        loader = dataset.IndexedTokens(self.index, self.binary)
        self.assertEqual(len(loader), 2)
        first = loader[0]["encoded"]
        self.assertEqual(first["input_ids"], [2, 65536, 123456, 1])
        self.assertEqual(first["labels"], [-100, -100, 123456, 1])
        self.assertEqual(first["attention_mask"], [1, 1, 1, 1])
        second = loader[1]["encoded"]
        self.assertEqual(second["input_ids"], [10, 262143, 1])
        self.assertEqual(second["labels"], [-100, 262143, 1])
        self.assertEqual(second["target_length"], 2)
        self.assertTrue(second["target_boundary_whitespace_trimmed"])
        self.assertEqual(loader[-1]["encoded"], second)
        with self.assertRaises(IndexError):
            _ = loader[2]

    def test_truncated_binary_is_rejected_at_open_and_read(self):
        loader = dataset.IndexedTokens(self.index, self.binary)
        self.binary.write_bytes(self.binary.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            dataset.IndexedTokens(self.index, self.binary)
        with self.assertRaises(ValueError):
            _ = loader[1]

    def test_trailing_bytes_are_not_silently_ignored(self):
        with self.binary.open("ab") as handle:
            handle.write(b"\x00\x00\x00\x00")
        with self.assertRaises(ValueError):
            dataset.IndexedTokens(self.index, self.binary)

    def test_invalid_lengths_and_offsets_fail_before_random_access(self):
        original = deepcopy(self.entries)
        for position, field, value in (
            (0, "prefix_length", 0), (0, "prefix_length", True),
            (0, "prefix_length", 2.0), (0, "target_length", 0),
            (0, "target_length", -2), (0, "target_length", 2.0),
            (0, "sequence_length", 5), (0, "offset_tokens", 1),
            (0, "offset_tokens", -1), (0, "offset_tokens", False),
            (0, "offset_tokens", 0.0), (1, "offset_tokens", 5),
        ):
            with self.subTest(position=position, field=field, value=value):
                self.entries = deepcopy(original)
                self.entries[position][field] = value
                self.write_files()
                with self.assertRaises(ValueError):
                    dataset.IndexedTokens(self.index, self.binary)

    def test_out_of_vocabulary_uint32_tokens_are_rejected(self):
        for token in (262144, 0xFFFFFFFF):
            with self.subTest(token=token):
                self.ids[-1] = token
                self.write_files()
                loader = dataset.IndexedTokens(self.index, self.binary)
                with self.assertRaisesRegex(ValueError, "vocabulary"):
                    _ = loader[1]


class BundleVerificationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.sources = {}
        for split in ("train", "validation"):
            dialogue = []
            for i in range(2):
                example = row(f"dialogue-{split}-{i}", "conversation", split)
                example["messages"][1]["content"] = f"Fictional prompt {split} {i}."
                dialogue.append(example)
            self.sources[("chat_12b", split)] = dialogue
            source = wire_row(f"review-{split}", fields=["script"])
            source["split"] = split
            request = json.loads(source["messages"][1]["content"])
            request["data"]["answers"]["supporter"][0]["answers"][0]["text"] += " " + split
            set_message(source, 1, request)
            self.sources[("cards_31b", split)] = [source]
        self.partitions = {}
        self.write_fixture()

    def write_fixture(self):
        provenance = self.root / "provenance"
        provenance.mkdir(exist_ok=True)
        (self.root / "BUILD.json").write_text(
            json_text({"role_paths": ["chat_12b", "cards_31b"]}), encoding="utf-8")
        (provenance / "service_source_rows.jsonl").write_text(
            "".join(json_text(example) + "\n" for examples in self.sources.values()
                    for example in examples), encoding="utf-8")
        for role in ("chat_12b", "cards_31b"):
            folder = self.root / role
            folder.mkdir(exist_ok=True)
            phase = "chat_calibration" if role == "chat_12b" else "01_card_generation"
            config = {"role": role, "validation_used_for_gradient": False,
                      "truncation": False, "phases": [], "optional": []}
            data = {}
            for split in ("train", "validation"):
                path = folder / "data" / phase / f"{split}.jsonl.gz"
                if path.exists():
                    path.unlink()
                sources = self.sources[(role, split)]
                examples = ([dataset.preserved(source) for source in sources] if role == "chat_12b"
                            else [card for source in sources for card in dataset.derive_cards(source)])
                data[split] = dataset.write_partition(folder, phase, split, dataset.balance(examples))
                self.partitions[(role, split)] = path
            config["phases"].append({"id": phase, "data": data})
            (folder / "COURSE.json").write_text(json_text(config), encoding="utf-8")
        dataset.refresh_manifest(self.root)

    def mutate_partition(self, role, split, mutate):
        path = self.partitions[(role, split)]
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            examples = [json.loads(line) for line in handle]
        mutate(examples)
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            handle.writelines(json_text(example) + "\n" for example in examples)
        dataset.refresh_manifest(self.root)

    def test_valid_bundle_reports_structure_without_source_text(self):
        result = dataset.verify_bundle(self.root)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["cross_role_lineage_overlap"], 0)
        self.assertEqual(result["roles"]["chat_12b"]["chat_calibration"],
                         {"train": 2, "validation": 2})
        self.assertEqual(result["roles"]["cards_31b"]["01_card_generation"],
                         {"train": 1, "validation": 1})
        self.assertFalse(result["validation_is_independent_test"])
        self.assertNotIn("fictional", json.dumps(result).lower())

    def test_file_checksum_tampering_is_rejected(self):
        path = self.partitions[("chat_12b", "train")]
        with path.open("ab") as handle:
            handle.write(b"unexpected bytes")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            dataset.verify_bundle(self.root)

    def test_unmanifested_file_is_rejected(self):
        (self.root / "unlisted.jsonl").write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unmanifested"):
            dataset.verify_bundle(self.root)

    def test_rehashed_invalid_loss_mask_still_fails(self):
        self.mutate_partition("chat_12b", "train",
                              lambda examples: examples[0].update(loss_message_mask=[1, 1, 1]))
        with self.assertRaisesRegex(ValueError, "Loss mask"):
            dataset.verify_bundle(self.root)

    def test_rehashed_changed_positive_target_still_fails_provenance(self):
        def change_target(examples):
            set_message(examples[0], -1, {"script": "An unreviewed replacement."})
        self.mutate_partition("cards_31b", "train", change_target)
        with self.assertRaisesRegex(ValueError, "projection"):
            dataset.verify_bundle(self.root)

    def test_rehashed_answer_bearing_generation_input_is_rejected(self):
        def add_target_to_prompt(examples):
            request = json.loads(examples[0]["messages"][1]["content"])
            request["data"]["current"] = json.loads(examples[0]["messages"][-1]["content"])
            set_message(examples[0], 1, request)
        self.mutate_partition("cards_31b", "train", add_target_to_prompt)
        with self.assertRaises(ValueError):
            dataset.verify_bundle(self.root)

    def test_cross_role_group_leak_is_rejected_even_with_valid_hashes(self):
        self.sources[("cards_31b", "validation")][0]["source_group_ids"] = list(
            self.sources[("chat_12b", "train")][0]["source_group_ids"])
        self.write_fixture()
        with self.assertRaisesRegex(ValueError, "lineage leakage"):
            dataset.verify_bundle(self.root)

    def test_cross_role_root_leak_is_rejected_even_with_valid_hashes(self):
        self.sources[("cards_31b", "validation")][0]["source_root_ids"] = list(
            self.sources[("chat_12b", "train")][0]["source_root_ids"])
        self.write_fixture()
        with self.assertRaisesRegex(ValueError, "lineage leakage"):
            dataset.verify_bundle(self.root)

    def test_preserving_total_weight_cannot_hide_wrong_family_weights(self):
        def change_weights(examples):
            examples[0]["weight"] = {"numerator": 3, "denominator": 2}
            examples[1]["weight"] = {"numerator": 1, "denominator": 2}
        self.mutate_partition("chat_12b", "train", change_weights)
        with self.assertRaisesRegex(ValueError, "Unbalanced"):
            dataset.verify_bundle(self.root)


if __name__ == "__main__":
    unittest.main()
