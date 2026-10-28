"""Serving token limits, independent of the training sequence length.

Only token counts enter this check; source text is never accepted or truncated.
"""

import re

MAX_INPUT_TOKENS = 65536
MAX_OUTPUT_TOKENS = 8192
MAX_CONTEXT_TOKENS = 69632

_BUDGET_ERROR_PATTERNS = (
    re.compile(rf"Prompt \([1-9][0-9]*\) exceeds the {MAX_INPUT_TOKENS}-token input budget; no text was truncated"),
    re.compile(rf"Prompt \([1-9][0-9]*\) plus max_tokens \([1-9][0-9]*\) exceeds "
               rf"the {MAX_CONTEXT_TOKENS}-token context budget; no text was truncated"),
    re.compile(r"Prompt exceeds the (?:v11 )?input budget; no text was truncated"),
)


def safe_budget_error_message(value):
    """Forward only complete, source-free budget errors from known workers."""
    if isinstance(value, str) and any(pattern.fullmatch(value) for pattern in _BUDGET_ERROR_PATTERNS):
        return value
    return None


def validate_inference_budget(input_tokens, requested_output_tokens):
    """Reject invalid reservations; reserve only the requested output tokens."""
    if type(input_tokens) is not int or input_tokens <= 0:
        raise ValueError("input_tokens must be a positive integer")
    if type(requested_output_tokens) is not int or requested_output_tokens <= 0:
        raise ValueError("max_tokens must be a positive integer")
    if input_tokens > MAX_INPUT_TOKENS:
        raise ValueError(
            f"Prompt ({input_tokens}) exceeds the {MAX_INPUT_TOKENS}-token input budget; no text was truncated"
        )
    if requested_output_tokens > MAX_OUTPUT_TOKENS:
        raise ValueError(f"max_tokens must be between 1 and {MAX_OUTPUT_TOKENS}")
    if input_tokens + requested_output_tokens > MAX_CONTEXT_TOKENS:
        raise ValueError(
            f"Prompt ({input_tokens}) plus max_tokens ({requested_output_tokens}) exceeds "
            f"the {MAX_CONTEXT_TOKENS}-token context budget; no text was truncated"
        )
