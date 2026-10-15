import copy
import hashlib
import unittest
from unittest.mock import patch

from counseling_pipeline import gemma4_generation_validation as generation
from counseling_pipeline import gemma4_token_validation as tokens
from tests.test_gemma4_token_validation import FAKE_TEMPLATE, FakeTokenizer, example


class GenerationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tokenizer = FakeTokenizer()
        self.tokenizer.decode = lambda ids, **kwargs: "".join(chr(x - 1) for x in ids)
        self.tokenizer.all_special_ids = [9999]
        self.tokenizer.convert_ids_to_tokens = lambda value: "<eos>" if value == 9999 else str(value)
        p = patch.object(tokens, "PINNED_TEMPLATE_SHA256", hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest())
        p.start();self.addCleanup(p.stop)

    def prepared(self):
        return generation.prepare_generation(example(), self.tokenizer, max_new_tokens=8, context_budget=9999)

    def test_exact_native_prefix_and_target_change_invariance(self):
        row = example(); before = copy.deepcopy(row)
        left = self.prepared()
        row["messages"][-1]["content"] = "다른 비밀 목표"
        right = generation.prepare_generation(row, self.tokenizer, max_new_tokens=8, context_budget=9999)
        self.assertEqual(left, right)
        self.assertEqual(example(), before)
        rendered = self.tokenizer.apply_chat_template(before["messages"][:-1], tokenize=False,
                                                     enable_thinking=False, add_generation_prompt=True)
        self.assertEqual(left["input_ids"], [ord(c)+1 for c in rendered])

    def test_reservation_is_separate_from_training_length(self):
        row = example("짧음")
        encoded = tokens.encode_example(row, self.tokenizer)
        reserve = encoded["target_length"] + 1
        with self.assertRaisesRegex(ValueError, "reservation exceeds"):
            generation.prepare_generation(row, self.tokenizer, max_new_tokens=reserve,
                                          context_budget=encoded["sequence_length"])
        for n in [True, 0, -1, 1.5]:
            with self.assertRaises(ValueError):
                generation.prepare_generation(row, self.tokenizer, max_new_tokens=n, context_budget=9999)

    def test_eos_is_removed_only_from_suffix_not_from_prefix(self):
        p = self.prepared(); result = generation.inspect_generation(p["input_ids"]+[ord('답')+1,9999],p,self.tokenizer,stop_ids=[9999])
        self.assertEqual(result["body"],"답");self.assertEqual(result["termination"],"eos")
        self.assertEqual(result["raw_suffix_ids"], [ord('답')+1, 9999])
        self.assertEqual(result["body_sha256"], hashlib.sha256("답".encode()).hexdigest())
        self.assertIsNone(result["natural_stop"])
        self.assertEqual(result["stop_origin"], "unverified_eos")
        self.assertEqual(result["semantic_completeness"], "not_assessed")

    def test_length_limit_is_not_claimed_as_natural_stop(self):
        p=self.prepared();result=generation.inspect_generation(p["input_ids"]+[ord('답')+1]*8,p,self.tokenizer,stop_ids=[9999])
        self.assertFalse(result["stopped_on_eos"]);self.assertEqual(result["termination"],"length_limit")

    def test_tool_handoff_is_not_counted_as_completed_response(self):
        p = self.prepared()
        self.tokenizer.convert_ids_to_tokens = lambda value: "<|tool_response>"
        with self.assertRaisesRegex(ValueError, "Tool handoff"):
            generation.inspect_generation(p["input_ids"] + [9999], p, self.tokenizer, stop_ids=[9999])

    def test_early_exit_without_stop_is_not_mislabeled_as_length_limit(self):
        p = self.prepared()
        with self.assertRaisesRegex(ValueError, "ended early"):
            generation.inspect_generation(p["input_ids"] + [ord('답')+1], p, self.tokenizer, stop_ids=[9999])

    def test_changed_prefix_over_budget_and_post_stop_output_fail(self):
        p=self.prepared()
        for suffix in [[],[ord('답')+1]*9,[9999,ord('답')+1]]:
            with self.assertRaises(ValueError):generation.inspect_generation(p["input_ids"]+suffix,p,self.tokenizer,stop_ids=[9999])
        with self.assertRaises(ValueError):generation.inspect_generation([2]+p["input_ids"]+[9999],p,self.tokenizer,stop_ids=[9999])

    def test_role_and_thought_markers_are_not_silently_stripped(self):
        p=self.prepared();p["max_new_tokens"]=100
        for body in [tokens.MODEL_HEADER,tokens.EMPTY_THOUGHT]:
            with self.assertRaisesRegex(ValueError,"control token"):
                generation.inspect_generation(p["input_ids"]+[ord(c)+1 for c in body]+[9999],p,self.tokenizer,stop_ids=[9999])

    def inspect_with_profile(self, suffix, *, config=None, **kwargs):
        p = self.prepared()
        self.tokenizer.all_special_ids = [0, 1, 2, 50, 106]
        self.tokenizer.convert_ids_to_tokens = lambda value: "<turn|>" if value == 106 else str(value)
        options = {"no_extra_logits_processors": True, "no_extra_stopping_criteria": True}
        options.update(kwargs)
        return generation.inspect_generation(
            p["input_ids"] + suffix, p, self.tokenizer, stop_ids=[1, 106],
            effective_generation_config=(generation.deterministic_generation_config(max_new_tokens=8)
                                         if config is None else config), **options)

    def test_new_profile_has_no_inherited_forcing_or_tool_stop(self):
        config = generation.deterministic_generation_config(max_new_tokens=8)
        self.assertEqual(config["eos_token_id"], [1, 106])
        self.assertIsNone(config["forced_eos_token_id"])
        self.assertIs(config["do_sample"], False)
        config["eos_token_id"].append(50)
        self.assertEqual(generation.deterministic_generation_config(max_new_tokens=8)["eos_token_id"], [1, 106])
        for value in (True, 0, -1, 1.5):
            with self.assertRaises(ValueError): generation.deterministic_generation_config(max_new_tokens=value)

    def test_517_none_fallback_is_overridden_by_call_kwargs_without_model_mutation(self):
        # Mirrors the inspected 5.17 _prepare_generation_config order: None fields
        # inherit model defaults, then explicit kwargs (including None) win.
        class Config:
            def __init__(self, values): self.values = values
            def to_dict(self): return copy.deepcopy(self.values)
        class Model:
            generation_config = {"forced_eos_token_id": 106, "suppress_tokens": [1], "do_sample": True}
            def _prepare_generation_config(self, config, **kwargs):
                values = {} if config is None else config.to_dict()
                for key, value in self.generation_config.items():
                    if values.get(key) is None: values[key] = value
                values.update(kwargs)
                return Config(values), {}
        model = Model(); before = copy.deepcopy(model.generation_config)
        explicit = generation.deterministic_generation_config(max_new_tokens=8)
        unsafe, _ = model._prepare_generation_config(Config(explicit))
        self.assertEqual(unsafe.to_dict()["forced_eos_token_id"], 106)
        safe = generation.resolve_generation_call(model, max_new_tokens=8)
        self.assertIsNone(safe["effective_generation_config"]["forced_eos_token_id"])
        self.assertIsNone(safe["effective_generation_config"]["suppress_tokens"])
        effective_at_call, _ = model._prepare_generation_config(None, **safe["kwargs"])
        self.assertEqual(effective_at_call.to_dict(), safe["effective_generation_config"])
        self.assertEqual(model.generation_config, before)

    def test_unknown_active_runtime_controls_are_not_silently_allowed(self):
        config = generation.deterministic_generation_config(max_new_tokens=8)
        config["future_force_stop"] = True
        self.assertFalse(self.inspect_with_profile([106], config=config)["generation_profile_verified"])

    def test_model_eos_requires_explicit_config_and_call_provenance(self):
        result = self.inspect_with_profile([ord('답')+1, 106])
        self.assertIs(result["natural_stop"], True)
        self.assertIs(result["generation_profile_verified"], True)
        self.assertFalse(result["cap_censored"])
        self.assertEqual(result["semantic_completeness"], "not_assessed")
        for option in ("no_extra_logits_processors", "no_extra_stopping_criteria"):
            result = self.inspect_with_profile([ord('답')+1, 106], **{option: False})
            self.assertIsNone(result["natural_stop"])
            self.assertFalse(result["generation_profile_verified"])
            with self.assertRaises(ValueError):
                self.inspect_with_profile([ord('답')+1, 106], **{option: 1})

    def test_forced_eos_at_cap_is_observed_but_not_natural(self):
        config = generation.deterministic_generation_config(max_new_tokens=8)
        config["forced_eos_token_id"] = 106
        result = self.inspect_with_profile([ord('답')+1] * 7 + [106], config=config)
        self.assertEqual(result["termination"], "eos")
        self.assertEqual(result["stop_origin"], "forced_eos_at_limit")
        self.assertIs(result["natural_stop"], False)
        self.assertTrue(result["cap_censored"])
        self.assertFalse(result["generation_profile_verified"])

    def test_unforced_eos_at_cap_still_counts_as_cap_censored(self):
        result = self.inspect_with_profile([ord('답')+1] * 7 + [106])
        self.assertIs(result["natural_stop"], True)
        self.assertTrue(result["cap_censored"])
        self.assertEqual(result["semantic_completeness"], "not_assessed")

    def test_constraints_or_partial_config_do_not_establish_natural_stop(self):
        changes = [("min_new_tokens", 5), ("suppress_tokens", [1]),
                   ("sequence_bias", {"106": 100}), ("do_sample", 0),
                   ("encoder_repetition_penalty", 1.2), ("forced_decoder_ids", [[1, 106]]),
                   ("penalty_alpha", 0.6), ("remove_invalid_values", True), ("dola_layers", "low")]
        for key, value in changes:
            with self.subTest(key=key):
                config = generation.deterministic_generation_config(max_new_tokens=8)
                config[key] = value
                result = self.inspect_with_profile([ord('답')+1, 106], config=config)
                self.assertIsNone(result["natural_stop"])
                self.assertFalse(result["generation_profile_verified"])
        self.assertIsNone(self.inspect_with_profile([106], config={})["natural_stop"])
        config = generation.deterministic_generation_config(max_new_tokens=8)
        config["temperature"] = float("nan")
        with self.assertRaisesRegex(ValueError, "finite JSON"):
            self.inspect_with_profile([106], config=config)


if __name__ == "__main__":
    unittest.main()
