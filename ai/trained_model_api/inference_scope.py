"""Keep decode optimization confined to the combined question/answer stages."""
from contextlib import contextmanager
from contextvars import ContextVar
import json


FOLDED_DECODE = ContextVar('hop_folded_decode', default=False)
_QA_STAGES = frozenset(('turn_draft', 'turn_review',
                        'turn_draft_after_review', 'turn_review_after_review'))


@contextmanager
def qa_decode_attention(messages):
    enabled = False
    if isinstance(messages, list) and messages and isinstance(messages[-1], dict):
        last = messages[-1]
        if last.get('role') == 'user' and isinstance(last.get('content'), str):
            try:
                payload = json.loads(last['content'])
                enabled = (isinstance(payload, dict) and payload.get('stage') in _QA_STAGES
                           and isinstance(payload.get('data'), dict)
                           and isinstance(payload.get('output_schema'), dict))
            except (ValueError, TypeError, RecursionError):
                pass
    token = FOLDED_DECODE.set(enabled)
    try:
        yield enabled
    finally:
        FOLDED_DECODE.reset(token)
