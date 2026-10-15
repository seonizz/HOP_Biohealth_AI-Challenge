"""Validate last-response tokens for one pinned Gemma 4 non-thinking template.

This is a text-only serialization/collation adapter, not a training runner. The
native completed-assistant rendering omits the empty thought preamble that the
same template adds to a generation prompt. We retain the native completion and
join it to the actual generation prefix, then check the token boundary exactly.
"""

import hashlib
import re


PINNED_TEMPLATE_SHA256 = "845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b"
MODEL_HEADER = "<|turn>model\n"
EMPTY_THOUGHT = "<|channel>thought\n<channel|>"
TURN_END = "<turn|>\n"
CONTROL_PATTERN = re.compile(r"<\||\|>|<bos>|<eos>|<pad>|<unk>|<mask>")


class TokenValidationError(ValueError):
    """An example or tokenizer does not satisfy the pinned serialization contract."""


def _require(condition, message):
    if not condition:
        raise TokenValidationError(message)


def _positive_integer(value):
    return type(value) is int and value > 0


def _check_template(tokenizer):
    template = getattr(tokenizer, "chat_template", None)
    _require(isinstance(template, str) and bool(template), "Missing string chat template")
    digest = hashlib.sha256(template.encode("utf-8")).hexdigest()
    _require(digest == PINNED_TEMPLATE_SHA256, "Unrecognized chat template hash")
    return digest


def _check_messages(row, tokenizer):
    _require(isinstance(row, dict), "Example must be an object")
    messages = row.get("messages")
    _require(isinstance(messages, list) and len(messages) >= 2, "Missing conversation messages")
    special_tokens = getattr(tokenizer, "all_special_tokens", [])
    _require(isinstance(special_tokens, (list, tuple)), "Invalid special-token inventory")
    for index, message in enumerate(messages):
        _require(isinstance(message, dict), "Message must be an object")
        _require(set(message) <= {"role", "content", "message_id"},
                 "Unsupported message fields (reasoning/tools are not text-only sources)")
        role, content = message.get("role"), message.get("content")
        _require(role in {"system", "user", "assistant"}, "Unsupported source role")
        _require(role != "system" or index == 0, "System message must be first")
        _require(isinstance(content, str) and bool(content.strip()), "Empty/nontext source message")
        _require(not CONTROL_PATTERN.search(content), "Source contains control-token syntax")
        _require(not any(str(token) and str(token) in content for token in special_tokens),
                 "Source contains a tokenizer special token")
    _require(messages[-1]["role"] == "assistant", "Final message must be the assistant target")
    _require(messages[-2]["role"] == "user", "Target must follow a user message")
    if "loss_message_mask" in row:
        mask = row["loss_message_mask"]
        _require(isinstance(mask, list) and all(type(x) is int for x in mask)
                 and mask == [0] * (len(messages) - 1) + [1], "Not a last-target-only message mask")
    return messages


def serialize_example(row, tokenizer):
    """Return native/canonical strings with an explicit, auditable difference.

    No target substring search is used. The boundary comes from rendering the
    message prefix, followed by the pinned model-role header. Source dictionaries
    are unchanged; boundary whitespace trimming is the native template's own
    behavior and is recorded, not silently attributed to source rewriting.
    """
    template_hash = _check_template(tokenizer)
    messages = _check_messages(row, tokenizer)
    options = {"tokenize": False, "enable_thinking": False}
    native_full = tokenizer.apply_chat_template(messages, add_generation_prompt=False, **options)
    native_base = tokenizer.apply_chat_template(messages[:-1], add_generation_prompt=False, **options)
    native_prefix = tokenizer.apply_chat_template(messages[:-1], add_generation_prompt=True, **options)
    _require(all(isinstance(x, str) for x in (native_full, native_base, native_prefix)),
             "Template must return strings")
    native_target_prefix = native_base + MODEL_HEADER
    _require(native_full.startswith(native_target_prefix), "Native final role boundary changed")
    completion = native_full[len(native_target_prefix):]
    target = messages[-1]["content"]
    _require(completion == target.strip() + TURN_END, "Native target content/termination changed")
    _require(native_prefix == native_target_prefix + EMPTY_THOUGHT,
             "Non-thinking generation preamble changed")
    full_text = native_prefix + completion
    return {
        "full_text": full_text,
        "prefix_text": native_prefix,
        "completion_text": completion,
        "native_full_text": native_full,
        "native_base_text": native_base,
        "raw_template_prefix_match": native_full.startswith(native_prefix),
        "canonicalization_applied": full_text != native_full,
        "template_sha256": template_hash,
        "target_boundary_whitespace_trimmed": target != target.strip(),
        "enable_thinking": False,
    }


def _token_ids(tokenizer, text):
    encoded = tokenizer(text, add_special_tokens=False, truncation=False,
                        padding=False, return_attention_mask=False)
    _require(hasattr(encoded, "get"), "Tokenizer must return an input_ids mapping")
    ids = encoded.get("input_ids")
    _require(isinstance(ids, list) and bool(ids)
             and all(type(token) is int and token >= 0 for token in ids),
             "Tokenizer must return one nonempty integer token sequence")
    return ids


def encode_example(row, tokenizer, max_length=None, *, packing=False):
    """Tokenize without truncation; supervise only the final completion.

    Labels have the same positions as input_ids. Do not pre-shift them: causal
    language-model forward/loss implementations perform the next-token shift.
    An over-limit row raises instead of clipping either context or target.
    """
    _require(packing is False, "Packing is not supported by this validation adapter")
    _require(max_length is None or _positive_integer(max_length), "Invalid maximum length")
    serialized = serialize_example(row, tokenizer)
    ids = _token_ids(tokenizer, serialized["full_text"])
    prefix_ids = _token_ids(tokenizer, serialized["prefix_text"])
    boundary = len(prefix_ids)
    _require(ids[:boundary] == prefix_ids, "Token prefix mismatch; boundary must not be guessed")
    _require(0 < boundary < len(ids), "Empty prefix or zero supervised target tokens")
    _require(max_length is None or len(ids) <= max_length, "Sequence exceeds maximum length; hold untruncated")
    return {
        "input_ids": ids,
        "labels": [-100] * boundary + ids[boundary:],
        "attention_mask": [1] * len(ids),
        "prefix_length": boundary,
        "target_length": len(ids) - boundary,
        "sequence_length": len(ids),
        "raw_template_prefix_match": serialized["raw_template_prefix_match"],
        "canonicalization_applied": serialized["canonicalization_applied"],
        "target_boundary_whitespace_trimmed": serialized["target_boundary_whitespace_trimmed"],
        "template_sha256": serialized["template_sha256"],
    }


def collate_examples(rows, pad_id, max_length, *, packing=False):
    """Right-pad already validated examples; return only model input lists."""
    _require(packing is False, "Packing is not supported by this validation adapter")
    _require(type(pad_id) is int and pad_id >= 0, "Invalid pad token ID")
    _require(_positive_integer(max_length), "Invalid maximum length")
    _require(isinstance(rows, (list, tuple)) and bool(rows), "Empty batch")
    for row in rows:
        _require(isinstance(row, dict), "Encoded row must be an object")
        ids, labels, prefix = row.get("input_ids"), row.get("labels"), row.get("prefix_length")
        _require(isinstance(ids, list) and bool(ids)
                 and all(type(x) is int and x >= 0 for x in ids), "Invalid input IDs")
        _require(_positive_integer(prefix) and prefix < len(ids), "Invalid prefix/target boundary")
        _require(type(row.get("sequence_length")) is int and row["sequence_length"] == len(ids)
                 and type(row.get("target_length")) is int
                 and row["target_length"] == len(ids) - prefix,
                 "Encoded sequence/target length changed before collation")
        _require(isinstance(labels, list) and all(type(x) is int for x in labels)
                 and labels == [-100] * prefix + ids[prefix:], "Labels changed or shifted before collation")
        attention = row.get("attention_mask")
        _require(isinstance(attention, list) and all(type(x) is int for x in attention)
                 and attention == [1] * len(ids), "Expected unpadded context attention")
        _require(len(ids) <= max_length, "Sequence exceeds maximum length; hold untruncated")
    width = max(len(row["input_ids"]) for row in rows)
    batch = {"input_ids": [], "labels": [], "attention_mask": []}
    for row in rows:
        missing = width - len(row["input_ids"])
        batch["input_ids"].append(row["input_ids"] + [pad_id] * missing)
        batch["labels"].append(row["labels"] + [-100] * missing)
        batch["attention_mask"].append(row["attention_mask"] + [0] * missing)
    return batch
