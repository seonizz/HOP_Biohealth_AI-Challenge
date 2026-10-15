"""Pure-Python controls; these do not establish a real model/tokenizer pass."""

import copy
import hashlib
import unittest
from unittest.mock import patch

from counseling_pipeline import gemma4_token_validation as g


FAKE_TEMPLATE = "Synthetic renderer fixture: not the pinned production template."


class FakeTokenizer:
    chat_template = FAKE_TEMPLATE
    all_special_tokens = ["<bos>", "<eos>", "<pad>", "<custom_special>"]

    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, *, tokenize, enable_thinking, add_generation_prompt):
        assert tokenize is False and enable_thinking is False
        result = "<bos>"
        for message in messages:
            role = "model" if message["role"] == "assistant" else message["role"]
            result += f"<|turn>{role}\n" + message["content"].strip() + g.TURN_END
        return result + (g.MODEL_HEADER + g.EMPTY_THOUGHT if add_generation_prompt else "")

    def __call__(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return {"input_ids": [ord(character) + 1 for character in text]}


def example(target="마지막 답변입니다."):
    messages = [
        {"role": "system", "content": "원문 상담을 이어 갑니다."},
        {"role": "assistant", "content": "먼저 오신 이야기를 들을게요."},
        {"role": "user", "content": "첫 번째 이야기예요."},
        {"role": "assistant", "content": "마지막 답변입니다."},
        {"role": "user", "content": "이번에는 무엇을 말할까요?"},
        {"role": "assistant", "content": target},
    ]
    return {"messages": messages, "loss_message_mask": [0, 0, 0, 0, 0, 1]}


class Gemma4TokenValidationTests(unittest.TestCase):
    def setUp(self):
        self.tokenizer = FakeTokenizer()
        pin = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        self.pin_patch = patch.object(g, "PINNED_TEMPLATE_SHA256", pin)
        self.pin_patch.start()
        self.addCleanup(self.pin_patch.stop)

    def test_native_mismatch_is_explicit_and_empty_thought_is_prefix_only(self):
        result = g.serialize_example(example(), self.tokenizer)
        self.assertFalse(result["raw_template_prefix_match"])
        self.assertTrue(result["canonicalization_applied"])
        self.assertTrue(result["prefix_text"].endswith(g.MODEL_HEADER + g.EMPTY_THOUGHT))
        self.assertEqual(result["full_text"], result["prefix_text"] + "마지막 답변입니다." + g.TURN_END)
        self.assertNotIn(g.EMPTY_THOUGHT, result["completion_text"])

    def test_repeated_answer_and_two_previous_assistants_do_not_move_boundary(self):
        row = example()
        before = copy.deepcopy(row)
        encoded = g.encode_example(row, self.tokenizer)
        p = encoded["prefix_length"]
        self.assertEqual(encoded["labels"][:p], [-100] * p)
        self.assertEqual(encoded["labels"][p:], [ord(c) + 1 for c in row["messages"][-1]["content"] + g.TURN_END])
        self.assertEqual(encoded["attention_mask"], [1] * len(encoded["input_ids"]))
        self.assertEqual(row, before)
        self.assertEqual(len(self.tokenizer.calls), 2)
        for _, kwargs in self.tokenizer.calls:
            self.assertEqual(kwargs, dict(add_special_tokens=False, truncation=False, padding=False, return_attention_mask=False))

    def test_initial_assistant_and_leading_unicode_whitespace_are_recorded(self):
        row = example(" \n원문 답변\t ")
        result = g.serialize_example(row, self.tokenizer)
        self.assertTrue(result["target_boundary_whitespace_trimmed"])
        self.assertEqual(result["completion_text"], "원문 답변" + g.TURN_END)
        self.assertEqual(row["messages"][-1]["content"], " \n원문 답변\t ")

    def test_unknown_template_hash_fails_closed(self):
        self.tokenizer.chat_template += " changed"
        with self.assertRaisesRegex(ValueError, "template hash"):
            g.serialize_example(example(), self.tokenizer)

    def test_changed_generation_preamble_fails_closed(self):
        original = self.tokenizer.apply_chat_template
        self.tokenizer.apply_chat_template = lambda *a, **k: original(*a, **k).replace(g.EMPTY_THOUGHT, "")
        with self.assertRaisesRegex(ValueError, "preamble changed"):
            g.serialize_example(example(), self.tokenizer)

    def test_changed_completion_or_termination_fails_closed(self):
        original = self.tokenizer.apply_chat_template
        self.tokenizer.apply_chat_template = lambda *a, **k: original(*a, **k) + ("EXTRA" if len(a[0]) == 6 else "")
        with self.assertRaisesRegex(ValueError, "content/termination changed"):
            g.serialize_example(example(), self.tokenizer)

    def test_source_special_and_unknown_control_syntax_are_held(self):
        for control in ("<|channel>thought", "<turn|>", "<|new_unknown>", "<new_unknown|>", "<bos>", "<custom_special>"):
            for index in (0, 2, 5):
                with self.subTest(control=control, index=index):
                    row = example();row["messages"][index]["content"] += control
                    with self.assertRaisesRegex(ValueError, "control-token|special token"):
                        g.serialize_example(row, self.tokenizer)

    def test_reasoning_tools_wrong_role_and_target_mask_are_rejected(self):
        changes = [lambda r: r["messages"][-1].update(reasoning="숨은 추론"),
                   lambda r: r["messages"][1].update(tool_calls=[]),
                   lambda r: r["messages"][-1].update(role="user"),
                   lambda r: r["messages"][-2].update(role="assistant"),
                   lambda r: r.update(loss_message_mask=[1] * 6),
                   lambda r: r.update(loss_message_mask=[False] * 5 + [True]),
                   lambda r: r["messages"][-1].update(content="   ")]
        for change in changes:
            row = example();change(row)
            with self.assertRaises(ValueError):
                g.serialize_example(row, self.tokenizer)

    def test_token_boundary_mismatch_is_not_repaired_by_substring_search(self):
        class MergingTokenizer(FakeTokenizer):
            def __call__(self, text, **kwargs):
                values = super().__call__(text, **kwargs)
                if text.endswith(g.EMPTY_THOUGHT):
                    values["input_ids"][-1] += 1
                return values
        with self.assertRaisesRegex(ValueError, "Token prefix mismatch"):
            g.encode_example(example(), MergingTokenizer())

    def test_zero_supervision_is_rejected(self):
        class EmptyTargetTokenizer(FakeTokenizer):
            def __call__(self, text, **kwargs):
                return {"input_ids": [1, 2, 3]}
        with self.assertRaisesRegex(ValueError, "zero supervised"):
            g.encode_example(example(), EmptyTargetTokenizer())

    def test_target_is_never_cut_at_length_boundary(self):
        row = example()
        valid = g.encode_example(row, self.tokenizer)
        size = len(valid["input_ids"])
        self.assertEqual(g.encode_example(row, self.tokenizer, size), valid)
        with self.assertRaisesRegex(ValueError, "hold untruncated"):
            g.encode_example(row, self.tokenizer, size - 1)

    def test_right_padding_excludes_only_pad_and_prefix_labels(self):
        short = g.encode_example(example("짧은 답."), self.tokenizer)
        long = g.encode_example(example("조금 더 긴 답변을 남깁니다."), self.tokenizer)
        original = copy.deepcopy([short, long])
        batch = g.collate_examples([short, long], 0, len(long["input_ids"]))
        n = len(short["input_ids"]);extra = len(long["input_ids"]) - n
        self.assertEqual(batch["input_ids"][0][n:], [0] * extra)
        self.assertEqual(batch["labels"][0][n:], [-100] * extra)
        self.assertEqual(batch["attention_mask"][0], [1] * n + [0] * extra)
        self.assertEqual(batch["labels"][0][:n], short["labels"])
        self.assertEqual([short, long], original)
        self.assertEqual(set(batch), {"input_ids", "labels", "attention_mask"})

    def test_packing_and_collator_truncation_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Packing"):
            g.encode_example(example(), self.tokenizer, packing=True)
        row = g.encode_example(example(), self.tokenizer)
        with self.assertRaisesRegex(ValueError, "Packing"):
            g.collate_examples([row], 0, 9999, packing=True)
        with self.assertRaisesRegex(ValueError, "hold untruncated"):
            g.collate_examples([row], 0, len(row["input_ids"]) - 1)

    def test_pre_shifted_labels_and_context_attention_changes_are_rejected(self):
        row = g.encode_example(example(), self.tokenizer)
        changed = copy.deepcopy(row);changed["labels"] = changed["labels"][1:] + [-100]
        with self.assertRaisesRegex(ValueError, "changed or shifted"):
            g.collate_examples([changed], 0, 9999)
        changed = copy.deepcopy(row);changed["attention_mask"][0] = 0
        with self.assertRaisesRegex(ValueError, "unpadded context"):
            g.collate_examples([changed], 0, 9999)

    def test_a_previously_encoded_target_cut_is_rejected_by_collator(self):
        row = g.encode_example(example(), self.tokenizer)
        for key in ("input_ids", "labels", "attention_mask"):
            row[key] = row[key][:-1]
        with self.assertRaisesRegex(ValueError, "length changed"):
            g.collate_examples([row], 0, 9999)

    def test_invalid_batch_limits_and_boolean_attention_are_rejected(self):
        row = g.encode_example(example(), self.tokenizer)
        for cap in (0, -1, True, 1.5, "100"):
            with self.assertRaisesRegex(ValueError, "maximum length"):
                g.collate_examples([row], 0, cap)
        row["attention_mask"][0] = True
        with self.assertRaisesRegex(ValueError, "unpadded context"):
            g.collate_examples([row], 0, 9999)


if __name__ == "__main__":
    unittest.main()
