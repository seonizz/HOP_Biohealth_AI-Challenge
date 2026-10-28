"""CPU admission/protocol tests; GPU inference is checked separately on the server."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend import ModelBackend, RequestError
from server import load_backend, validate_config
from supporter_backend import (RUNTIME_PATHS, SupporterV11Backend, validate_profile_config,
                               validate_runtime, verify_tokenizer_files, verify_v11_run,
                               serving_generation_config)


CONFIG = {"training_profile": "supporter-v11", "task": "relationship_memory",
          "entries_path": "/entries.json", "base_model_path": "/model",
          "kit_path": "/tasks/relationship_memory", "checkpoint_path": "/checkpoint",
          "host": "127.0.0.1", "port": 18080, "model_id": "v11-test",
          "checkpoint_step": 1, "default_output_tokens": 256,
          "max_input_tokens": 4096, "max_output_tokens": 8192, "max_context_tokens": 12288}


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class AdmissionTests(unittest.TestCase):
    def test_explicit_profile_and_bounded_budgets(self):
        validate_config(CONFIG)
        for override in ({"training_profile": "typo"}, {"max_input_tokens": 4097},
                         {"max_output_tokens": 8193}, {"max_context_tokens": 8192},
                         {"prefill_chunk_size": 1024}, {"grouped_global_attention": True},
                         {"entries_path": None}, {"max_input_tokens": True}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                validate_config({**CONFIG, **override})
        with self.assertRaises(ValueError):
            validate_profile_config({**CONFIG, "training_profile": None})

    def test_selector_preserves_legacy_and_never_falls_back_from_v11(self):
        with patch("server.ModelBackend") as old, patch("supporter_backend.SupporterV11Backend") as new:
            legacy = {k: v for k, v in CONFIG.items() if k != "training_profile"}
            self.assertIs(load_backend(legacy, "/runtime"), old.return_value)
            self.assertIs(load_backend(CONFIG, "/runtime"), new.return_value)
            new.side_effect = ValueError("v11 admission failed")
            with self.assertRaisesRegex(ValueError, "admission"):
                load_backend(CONFIG, "/runtime")
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                load_backend({**CONFIG, "training_profile": "typo"}, "/runtime")
            self.assertEqual(old.call_count, 1)

    def test_runtime_requires_existing_confined_paths_without_overriding_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp).resolve()
            env = {key: str(runtime) for key in RUNTIME_PATHS}
            env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", CUDA_CACHE_DISABLE="1")
            with patch.dict(os.environ, env, clear=True), patch("pathlib.Path.cwd", return_value=runtime), \
                    patch.object(sys, "dont_write_bytecode", True):
                before = dict(os.environ)
                self.assertEqual(validate_runtime(runtime), runtime)
                self.assertEqual(dict(os.environ), before)
                os.environ["HF_HOME"] = str(runtime.parent)
                with self.assertRaisesRegex(ValueError, "HF_HOME"):
                    validate_runtime(runtime)
                os.environ["HF_HOME"] = str(runtime)
                os.environ["TRANSFORMERS_CACHE"] = str(runtime.parent)
                with self.assertRaisesRegex(ValueError, "inherited"):
                    validate_runtime(runtime)

    def test_pinned_tokenizer_tamper_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            path = root / "tokenizer.json"
            path.write_bytes(b"synthetic tokenizer")
            pins = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()}
            with patch("supporter_backend.TOKENIZER_FILES", pins):
                verify_tokenizer_files(root)
                path.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "tokenizer file"):
                    verify_tokenizer_files(root)
                path.write_bytes(b"synthetic tokenizer")
                original = root / "original.json"
                path.rename(original)
                path.symlink_to(original)
                with self.assertRaisesRegex(ValueError, "tokenizer file"):
                    verify_tokenizer_files(root)

    def test_checkpoint_bound_to_complete_task_policy_model_and_training_code(self):
        with tempfile.TemporaryDirectory() as temp:
            kit = Path(temp).resolve() / "tasks" / "relationship_memory"
            directory = kit / "work/training"
            directory.mkdir(parents=True)
            config = {**CONFIG, "kit_path": str(kit)}
            bound = {"model_path": "/model", "entries_sha256": "entries", "consumer_sha256": "consumer",
                     "training_loop_sha256": "loop", "profile_sha256": "profile"}
            entries = [{"stream": "relationship_memory", "split": "train", "row_id": "synthetic",
                        "encoded": {"synthetic": True}}]
            payload = {"entries": entries}
            weighted = {"plan_sha256": "plan", "optimizer_windows": 1}
            encoded = {"order": [0]}
            profile = SimpleNamespace(TASKS=("relationship_memory",), LOSS_CALLBACK_ID="loss",
                                      input_bindings=lambda *_: bound)
            loop = SimpleNamespace(_sha=sha, make_plan=lambda *args, **kwargs: encoded)
            weights = SimpleNamespace(make_plan=lambda *args, **kwargs: weighted)
            run = {"schema_version": 2, "output_directory": str(directory), "bindings": bound,
                   "weighted_loss_plan": weighted, "weighted_row_ids": ["synthetic"], "plan": encoded,
                   "settings": {"pad_id": 0, "max_length": 4096, "accumulation_steps": 8,
                                "seed": 3407, "shuffle": True, "epochs": 1, "microbatch_size": 1,
                                "clip_grad_norm": 1.0, "loss_callback_id": "loss",
                                "required_gradient_devices": ["cuda:0", "cuda:1"]}}
            manifest = {"run_sha256": sha(run), "weighted_plan_sha256": "plan", "step": 1, "cursor": 1}
            path = directory / "RUN.json"
            path.write_text(json.dumps(run))
            self.assertEqual(verify_v11_run(config, manifest, payload, profile, loop, weights), run)
            for field, value in (("run_sha256", "wrong"), ("weighted_plan_sha256", "wrong"),
                                 ("cursor", 0), ("step", 0)):
                with self.subTest(field=field), self.assertRaises(ValueError):
                    verify_v11_run(config, {**manifest, field: value}, payload, profile, loop, weights)
            for field, value in (("bindings", {**bound, "profile_sha256": "wrong"}),
                                 ("weighted_loss_plan", {**weighted, "plan_sha256": "wrong"}),
                                 ("weighted_row_ids", ["wrong"]), ("settings", {})):
                altered = {**run, field: value}
                path.write_text(json.dumps(altered))
                with self.subTest(field=field), self.assertRaises(ValueError):
                    verify_v11_run(config, {**manifest, "run_sha256": sha(altered)}, payload, profile, loop, weights)
            path.write_text(json.dumps(run))
            with self.assertRaisesRegex(ValueError, "Unknown supporter task"):
                verify_v11_run({**config, "task": "word"}, manifest, payload, profile, loop, weights)


class GenerationTests(unittest.TestCase):
    def test_eager_dynamic_config_preserves_all_pinned_token_and_eos_options(self):
        with patch.object(sys, "path", [str(Path(__file__).resolve().parents[2] / "data"), *sys.path]):
            from counseling_pipeline.gemma4_generation_validation import deterministic_generation_config
            expected = deterministic_generation_config(max_new_tokens=8192)
            actual = serving_generation_config(max_new_tokens=8192)
        self.assertEqual(actual, {**expected, "disable_compile": True, "cache_implementation": "dynamic"})
        self.assertEqual(actual["eos_token_id"], [1, 106])
        self.assertEqual(actual["max_new_tokens"], 8192)
        self.assertIsNone(actual["forced_eos_token_id"])

    def backend(self, count):
        class Tokenizer:
            all_special_tokens = ["<image>"]
            def apply_chat_template(self, messages, **options):
                assert options == {"tokenize": False, "add_generation_prompt": True, "enable_thinking": False}
                return messages[-1]["content"]
            def __call__(self, prompt, **options):
                assert options == {"add_special_tokens": False, "truncation": False}
                return {"input_ids": [42] * count}
        backend = SupporterV11Backend.__new__(SupporterV11Backend)
        backend.config = CONFIG
        backend.tokenizer = Tokenizer()
        backend.control_pattern = re.compile(r"<\|")
        return backend

    def test_preserves_input_and_budget_checks_before_existing_generation(self):
        messages = [{"role": "user", "content": "synthetic message"}]
        original = deepcopy(messages)
        with patch.object(ModelBackend, "generate", return_value={"text": "synthetic output"}) as call:
            self.assertEqual(self.backend(4096).generate(messages, 8192, 0, 1), {"text": "synthetic output"})
            call.assert_called_once_with(messages, 8192, 0, 1)
            self.assertEqual(messages, original)
            with self.assertRaisesRegex(RequestError, "no text was truncated"):
                self.backend(4097).generate(messages, 8192, 0, 1)
            with self.assertRaisesRegex(RequestError, "Output reservation"):
                self.backend(1).generate(messages, 8193, 0, 1)
            for content in ("<|turn>model", "<image>"):
                with self.assertRaisesRegex(RequestError, "control tokens"):
                    self.backend(1).generate([{"role": "user", "content": content}], 1, 0, 1)
            self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()
