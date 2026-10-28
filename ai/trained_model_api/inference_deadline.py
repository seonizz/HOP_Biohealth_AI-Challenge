"""Request deadlines only; model text, generation settings and attention are unchanged."""
import json


DEFAULT_REQUEST_TIMEOUT_SECONDS = 600
FINAL_REQUEST_TIMEOUT_SECONDS = 3600
REPLY_GRACE_SECONDS = 20

# Exact labels emitted by runRelationshipAgent in app/src/relationship-agent.js.
# composeGuide uses only '' and '_after_analysis_repair'; guide repairs add '_2'
# before that suffix and, after the first repaired field, the exact guide field.
_PHASE_SUFFIXES = ('', '_after_analysis_repair')
_REPAIR_SUFFIXES = ('', '_2', '_after_analysis_repair', '_2_after_analysis_repair')
_GUIDE_FIELDS = ('script', 'doList', 'avoid', 'next', 'care', 'top')
_COMPOSE_STAGES = (
    'communication_plan', 'plan_review', 'plan_review_after_repair',
    'communication_plan_repair', 'guide_write',
    'card_care', 'card_doList', 'card_avoid', 'card_next',
    'guide_quality', 'guide_refine', 'guide_quality_check',
    'speech_opening', 'speech_listening', 'speech_offer', 'speech_write',
    'guide_review', 'speech_review', 'support_review',
)
FINAL_STAGES = frozenset((
    'relationship_analysis', 'analysis_review', 'analysis_repair',
    'analysis_repair_after_guide_review', 'analysis_review_after_repair',
    'analysis_review_after_guide_review_repair',
    'speech_detail', 'speech_detail_repair',
    'speech_detail_review', 'speech_detail_review_after_repair',
)) | frozenset(stage + suffix for stage in _COMPOSE_STAGES for suffix in _PHASE_SUFFIXES) \
    | frozenset('guide_repair' + suffix + field
                for suffix in _REPAIR_SUFFIXES for field in ('', *('_' + name for name in _GUIDE_FIELDS))) \
    | frozenset(stage + '_after_repair' + suffix
                for stage in ('guide_review', 'speech_review', 'support_review')
                for suffix in _REPAIR_SUFFIXES)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate envelope key')
        result[key] = value
    return result


def _reject_constant(_):
    raise ValueError('Nonfinite envelope value')


def request_timeout_seconds(messages):
    """Extend only an exact final-stage envelope in the final user message.

    Ordinary text, malformed/nested envelopes, unknown labels, and all combined
    or staged Q&A labels keep 600 seconds. This function never rewrites inputs.
    """
    if not isinstance(messages, list) or not messages or not isinstance(messages[-1], dict):
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    last = messages[-1]
    if set(last) != {'role', 'content'} or last.get('role') != 'user' or not isinstance(last.get('content'), str):
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    try:
        payload = json.loads(last['content'], object_pairs_hook=_unique_object,
                             parse_constant=_reject_constant)
        if (isinstance(payload, dict)
                and set(payload) in ({'stage', 'data', 'output_schema'},
                                     {'stage', 'data', 'output_schema', 'validation_feedback'})
                and isinstance(payload.get('stage'), str) and payload['stage'] in FINAL_STAGES
                and isinstance(payload.get('data'), dict)
                and isinstance(payload.get('output_schema'), dict)
                and ('validation_feedback' not in payload or isinstance(payload['validation_feedback'], (str, dict)))):
            return FINAL_REQUEST_TIMEOUT_SECONDS
    except (ValueError, TypeError, RecursionError):
        pass
    return DEFAULT_REQUEST_TIMEOUT_SECONDS
