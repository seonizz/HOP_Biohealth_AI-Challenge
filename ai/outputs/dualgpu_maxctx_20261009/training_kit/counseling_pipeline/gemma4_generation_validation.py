"""Explicit prefix and output-budget contract for source-SFT generation probes.

This prepares one text example; it is not a serving or clinical-quality gate.

Pinned Transformers 5.17.0 source was inspected on the validation server:
``transformers/generation/utils.py:1900-1965`` fills every None config field
from model defaults before applying explicit generate kwargs at lines 1939-1940.
Consequently ``GenerationConfig(forced_eos_token_id=None)`` does NOT disable an
inherited forced EOS. Pass the factory mapping as generate kwargs instead and
capture the resolved config with ``resolve_generation_call``. Configuration
defaults/processor controls were checked against configuration_utils.py:385-501,
600-645 and utils.py:1260-1450 in that same installed version.
"""
import hashlib
import json
import math

from . import gemma4_token_validation as tokens


def deterministic_generation_config(*, max_new_tokens):
    """Build a new text-only config; do not update an inherited model config.

    Pass this mapping as explicit ``generate(**mapping)`` kwargs. The two call-site
    provenance flags accepted by ``inspect_generation`` must describe the actual
    generate call, including the absence of keyword overrides to this config.
    """
    tokens._require(tokens._positive_integer(max_new_tokens), "Invalid generation reservation")
    return {
        "do_sample": False, "num_beams": 1, "num_return_sequences": 1,
        "max_new_tokens": max_new_tokens, "eos_token_id": [1, 106],
        "pad_token_id": 0, "bos_token_id": 2,
        "forced_bos_token_id": None, "forced_eos_token_id": None,
        "suppress_tokens": None, "begin_suppress_tokens": None, "bad_words_ids": None,
        "min_length": 0, "min_new_tokens": 0, "no_repeat_ngram_size": 0,
        "repetition_penalty": 1.0, "renormalize_logits": False,
        "token_healing": False, "use_cache": True,
        "stop_strings": None, "max_time": None,
        "sequence_bias": None, "guidance_scale": None,
        "exponential_decay_length_penalty": None, "watermarking_config": None,
        "early_stopping": False, "use_mtp": False,
        "encoder_repetition_penalty": 1.0, "length_penalty": 1.0,
        "encoder_no_repeat_ngram_size": 0, "remove_invalid_values": False,
        "is_assistant": False, "prompt_lookup_num_tokens": None,
        "assistant_early_exit": None, "assistant_ensemble_weight": None,
        "speculation_type": None, "penalty_alpha": None, "dola_layers": None,
        "diversity_penalty": 0.0, "num_beam_groups": 1,
        "constraints": None, "force_words_ids": None,
        "output_attentions": False, "output_hidden_states": False,
        "output_scores": False, "output_logits": False, "return_dict_in_generate": False,
    }


def resolve_generation_call(model, *, max_new_tokens):
    """Resolve the pinned runtime's precedence and return kwargs for the call.

    Do not pass the returned effective config as a GenerationConfig alone: that
    would fill its None fields from model defaults a second time. The caller must
    generate with the returned kwargs without additional generation overrides.
    This helper does not mutate model.generation_config or load/run a model.
    """
    explicit = deterministic_generation_config(max_new_tokens=max_new_tokens)
    prepare = getattr(model, "_prepare_generation_config", None)
    tokens._require(callable(prepare), "Runtime cannot resolve generation configuration")
    effective, unused = prepare(None, **explicit)
    tokens._require(isinstance(unused, dict) and not unused,
                    "Explicit generation options were not consumed by the runtime")
    tokens._require(callable(getattr(effective, "to_dict", None)), "Runtime returned no config inventory")
    config = effective.to_dict()
    _, _, verified = _generation_provenance(config, {"max_new_tokens": max_new_tokens},
                                           explicit["eos_token_id"], True, True)
    tokens._require(verified, "Runtime generation profile still contains forcing or unsupported controls")
    return {"kwargs": explicit, "effective_generation_config": config}


def _same_config_value(actual, expected):
    if expected is None or type(expected) in (bool, int):
        return type(actual) is type(expected) and actual == expected
    if type(expected) is float:
        return type(actual) in (int, float) and math.isfinite(actual) and actual == expected
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _same_config_value(a, b) for a, b in zip(actual, expected))
    return actual == expected


def _generation_provenance(config, prepared, stop_ids, no_processors, no_criteria):
    tokens._require(type(no_processors) is bool and type(no_criteria) is bool,
                    "Generation provenance flags must be booleans")
    if config is None:
        return None, None, False
    tokens._require(isinstance(config, dict), "Effective generation config must be a mapping")
    try:
        serialized = json.dumps(config, ensure_ascii=False, sort_keys=True,
                                separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise tokens.TokenValidationError("Effective generation config must be finite JSON") from exc
    # These legacy/optional controls are not emitted by the minimal factory, but
    # must be absent or disabled in a full GenerationConfig.to_dict() inventory.
    expected = deterministic_generation_config(max_new_tokens=prepared["max_new_tokens"])
    verified = all(key in config and _same_config_value(config[key], value)
                   for key, value in expected.items())
    for key in ("constraints", "force_words_ids", "forced_decoder_ids", "penalty_alpha", "dola_layers"):
        verified = verified and config.get(key) is None
    for key, value in (("encoder_repetition_penalty", 1.0),
                       ("encoder_no_repeat_ngram_size", 0), ("num_beam_groups", 1),
                       ("remove_invalid_values", False)):
        verified = verified and _same_config_value(config.get(key, value), value)
    # Full to_dict() inventories contain these inert bookkeeping, cache and
    # sampling-only values. Unknown active fields fail closed on a future API.
    inert_keys = {"max_length", "temperature", "top_k", "top_p", "min_p", "top_h", "typical_p",
                  "epsilon_cutoff", "eta_cutoff", "cache_implementation", "cache_config", "max_cache_len",
                  "num_assistant_tokens", "num_assistant_tokens_schedule", "assistant_confidence_threshold",
                  "max_matching_ngram_size", "assistant_lookbehind", "target_lookbehind",
                  "compile_config", "disable_compile", "continuous_batching_config", "low_memory",
                  "prefill_chunk_size", "decoder_start_token_id", "transformers_version", "_from_model_config",
                  "_commit_hash", "_original_object_hash", "forced_decoder_ids"}
    verified = verified and all(key in expected or key in inert_keys or value is None
                                for key, value in config.items())
    verified = verified and list(stop_ids) == expected["eos_token_id"] and no_processors and no_criteria
    return json.loads(serialized), hashlib.sha256(serialized.encode("utf-8")).hexdigest(), bool(verified)


def prepare_generation(row, tokenizer, *, max_new_tokens, context_budget):
    tokens._require(tokens._positive_integer(max_new_tokens), "Invalid generation reservation")
    tokens._require(tokens._positive_integer(context_budget), "Invalid generation context budget")
    encoded = tokens.encode_example(row, tokenizer)
    prefix = encoded["input_ids"][:encoded["prefix_length"]]
    # Render this exact row independently; never derive a prompt from target text search.
    native = tokenizer.apply_chat_template(row["messages"][:-1], tokenize=False,
                                          enable_thinking=False, add_generation_prompt=True)
    tokens._require(tokens._token_ids(tokenizer, native) == prefix, "Generation prefix differs from native prompt")
    tokens._require(len(prefix) + max_new_tokens <= context_budget,
                    "Prefix plus generation reservation exceeds context budget; hold untruncated")
    return {"input_ids": prefix, "attention_mask": [1] * len(prefix),
            "prefix_length": len(prefix), "max_new_tokens": max_new_tokens,
            "context_budget": context_budget, "template_sha256": encoded["template_sha256"]}


def inspect_generation(sequence, prepared, tokenizer, *, stop_ids,
                       effective_generation_config=None,
                       no_extra_logits_processors=False, no_extra_stopping_criteria=False):
    """Inspect the suffix, preserving stop observations separately from meaning.

    ``natural_stop`` is unknown without explicit, unconstrained config/call
    provenance. Even a natural EOS is not proof of a semantically complete or
    clinically suitable answer. EOS at the token cap remains cap-censored for
    cross-budget comparisons.
    """
    tokens._require(isinstance(stop_ids, (list, tuple)) and bool(stop_ids)
                    and all(type(x) is int and x >= 0 for x in stop_ids), "Invalid generation stop IDs")
    tokens._require(isinstance(sequence, list) and all(type(x) is int and x >= 0 for x in sequence),
                    "Invalid generated sequence")
    config, config_sha, verified = _generation_provenance(
        effective_generation_config, prepared, stop_ids,
        no_extra_logits_processors, no_extra_stopping_criteria)
    prefix = prepared["input_ids"]
    tokens._require(sequence[:len(prefix)] == prefix, "Model generation changed or omitted prefix IDs")
    suffix = sequence[len(prefix):]
    tokens._require(0 < len(suffix) <= prepared["max_new_tokens"], "Generated token count outside reservation")
    positions = [i for i, value in enumerate(suffix) if value in stop_ids]
    tokens._require(not positions or positions == [len(suffix) - 1], "Tokens appeared after a stop token")
    stopped = bool(positions)
    tokens._require(stopped or len(suffix) == prepared["max_new_tokens"],
                    "Generation ended early without a declared stop token")
    terminal = suffix[-1] if stopped else None
    token_name = tokenizer.convert_ids_to_tokens(terminal) if stopped else None
    tokens._require(token_name != "<|tool_response>",
                    "Tool handoff is not a completed plain-text response")
    body_ids = suffix[:-1] if stopped else suffix
    body = tokenizer.decode(body_ids, skip_special_tokens=False)
    specials = getattr(tokenizer, "all_special_ids", [])
    tokens._require(not any(value in specials for value in body_ids)
                    and not tokens.CONTROL_PATTERN.search(body), "Unexpected role/thought/control token in response body")
    at_limit = len(suffix) == prepared["max_new_tokens"]
    forced_ids = config.get("forced_eos_token_id") if config is not None else None
    if type(forced_ids) is int:
        forced_ids = [forced_ids]
    forced_at_limit = stopped and at_limit and isinstance(forced_ids, list) and terminal in forced_ids
    natural_stop = (False if not stopped or forced_at_limit else True if verified else None)
    stop_origin = ("forced_eos_at_limit" if forced_at_limit else "model_eos" if stopped and verified
                   else "unverified_eos" if stopped else "length_limit")
    return {"body": body, "generated_tokens": len(suffix), "stopped_on_eos": stopped,
            "stop_token_id": terminal, "stop_token_name": token_name,
            "termination": "eos" if stopped else "length_limit",
            "prefix_preserved": True, "response_body_control_tokens": False,
            "raw_suffix_ids": list(suffix), "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "effective_generation_config": config, "generation_config_sha256": config_sha,
            "generation_profile_verified": verified,
            "no_extra_logits_processors": no_extra_logits_processors,
            "no_extra_stopping_criteria": no_extra_stopping_criteria,
            "natural_stop": natural_stop, "stop_origin": stop_origin,
            "cap_censored": at_limit, "semantic_completeness": "not_assessed"}
