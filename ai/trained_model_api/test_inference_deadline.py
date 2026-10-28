import copy
import json
import unittest

from inference_deadline import (DEFAULT_REQUEST_TIMEOUT_SECONDS, FINAL_REQUEST_TIMEOUT_SECONDS,
                                FINAL_STAGES, REPLY_GRACE_SECONDS, request_timeout_seconds)


def envelope(stage, **extra):
    return [{'role': 'system', 'content': 'unchanged'}, {'role': 'user', 'content': json.dumps({
        'stage': stage, 'data': {}, 'output_schema': {}, **extra})}]


class InferenceDeadlineTests(unittest.TestCase):
    def test_exact_final_stage_catalog_and_repair_variants(self):
        # Independent enumeration of the control-flow labels, not a prefix match.
        expected = set(('relationship_analysis', 'analysis_review', 'analysis_repair',
                        'analysis_repair_after_guide_review', 'analysis_review_after_repair',
                        'analysis_review_after_guide_review_repair', 'speech_detail',
                        'speech_detail_repair', 'speech_detail_review', 'speech_detail_review_after_repair'))
        compose = ('communication_plan plan_review plan_review_after_repair communication_plan_repair '
                   'guide_write card_care card_doList card_avoid card_next guide_quality guide_refine '
                   'guide_quality_check speech_opening speech_listening speech_offer speech_write '
                   'guide_review speech_review support_review').split()
        for phase in ('', '_after_analysis_repair'):
            expected.update(stage + phase for stage in compose)
            for repair in ('', '_2'):
                expected.add('guide_repair' + repair + phase)
                expected.update('guide_repair' + repair + phase + '_' + field
                                for field in ('script', 'doList', 'avoid', 'next', 'care', 'top'))
                expected.update(stage + '_after_repair' + repair + phase
                                for stage in ('guide_review', 'speech_review', 'support_review'))
        self.assertEqual(FINAL_STAGES, expected)
        self.assertEqual(len(expected), 88)
        for stage in expected:
            with self.subTest(stage=stage):
                self.assertEqual(request_timeout_seconds(envelope(stage)), 3600)

    def test_combined_staged_and_unknown_labels_keep_default(self):
        stages = ('turn_draft', 'turn_review', 'turn_draft_after_review', 'turn_review_after_review',
                  'state', 'state_observations', 'state_observations_after_review',
                  'relationship_memory', 'relationship_memory_after_review', 'state_review',
                  'state_review_after_review', 'question_plan', 'question_review', 'safety_review',
                  'guide', 'final', 'final_draft', 'grounding_review', 'report', '', None, [], {}, 1)
        for stage in stages:
            with self.subTest(stage=stage):
                self.assertEqual(request_timeout_seconds(envelope(stage)), 600)

    def test_suffix_and_prefix_near_misses_are_not_final_stages(self):
        for stage in FINAL_STAGES:
            for altered in (stage + '_extra', 'prefix_' + stage, stage + ' ', stage.upper()):
                with self.subTest(stage=altered):
                    self.assertEqual(request_timeout_seconds(envelope(altered)), 600)
        for stage in ('guide_repair_3', 'guide_repair_relationship_analysis',
                      'guide_repair_after_analysis_repair_2', 'speech_detail_after_analysis_repair',
                      'speech_review_after_repair_3', 'speech_review_after_review'):
            self.assertEqual(request_timeout_seconds(envelope(stage)), 600)

    def test_exact_complete_envelope_required(self):
        for value in ('speech_review', '{', 'null', '[]', '"speech_review"',
                      '[' * 1500 + '0' + ']' * 1500,
                      '{"stage":"speech_review"}',
                      '{"data":{"stage":"speech_review"},"output_schema":{}}',
                      '{"stage":"speech_review","stage":"speech_review","data":{},"output_schema":{}}',
                      '{"stage":"speech_review","data":{"n":NaN},"output_schema":{}}'):
            self.assertEqual(request_timeout_seconds([{'role': 'user', 'content': value}]), 600)
        for extra in ({'data': []}, {'output_schema': None}, {'extra': True}, {'validation_feedback': []}):
            self.assertEqual(request_timeout_seconds(envelope('speech_review', **extra)), 600)
        self.assertEqual(request_timeout_seconds(envelope('speech_review', validation_feedback={})), 3600)

    def test_final_retry_string_feedback_matches_gateway_contract(self):
        # model.js joins modelFeedback with newlines and emits that string on retries.
        feedback = ('Synthetic field validation failed.',
                    '{"path":"output.synthetic","keyword":"enum"}\nSelect an allowed synthetic value.',
                    'Synthetic first feedback.\nSynthetic accumulated feedback.')
        for stage in FINAL_STAGES:
            for value in (*feedback, {'issue': 'synthetic legacy feedback'}):
                with self.subTest(stage=stage, feedback_type=type(value).__name__):
                    messages = envelope(stage, validation_feedback=value)
                    before = copy.deepcopy(messages)
                    self.assertEqual(request_timeout_seconds(messages), 3600)
                    self.assertEqual(messages, before)

    def test_feedback_never_promotes_qa_startup_or_unknown_stages(self):
        feedback = 'Synthetic feedback mentioning relationship_analysis is only data.'
        for stage in ('turn_draft', 'turn_review', 'relationship_memory', 'state', 'question_plan',
                      'safety_review', 'relationship_analysis_extra', 'final', '', None):
            with self.subTest(stage=stage):
                self.assertEqual(request_timeout_seconds(envelope(stage, validation_feedback=feedback)), 600)
        self.assertEqual(request_timeout_seconds([{'role': 'user', 'content': 'Synthetic startup probe'}]), 600)
        for role in ('system', 'assistant', 'tool'):
            messages = envelope('relationship_analysis', validation_feedback=feedback)
            messages[-1]['role'] = role
            self.assertEqual(request_timeout_seconds(messages), 600)
        self.assertEqual(request_timeout_seconds(envelope('relationship_analysis',
            validation_feedback=feedback, unknown_key=True)), 600)

    def test_feedback_types_and_json_guards_remain_strict(self):
        for feedback in (None, [], ['synthetic'], 1, True, float('nan'), float('inf'),
                         {'nested': float('-inf')}):
            with self.subTest(feedback=repr(feedback)):
                self.assertEqual(request_timeout_seconds(envelope('relationship_analysis',
                    validation_feedback=feedback)), 600)
        duplicate = ('{"stage":"relationship_analysis","data":{},"output_schema":{},'
                     '"validation_feedback":"synthetic one","validation_feedback":"synthetic two"}')
        self.assertEqual(request_timeout_seconds([{'role': 'user', 'content': duplicate}]), 600)
        nested = envelope('relationship_analysis', validation_feedback='synthetic')[-1]['content']
        self.assertEqual(request_timeout_seconds([{'role': 'user', 'content': json.dumps({'nested': nested})}]), 600)

    def test_final_user_message_only_and_inputs_unchanged(self):
        valid = envelope('speech_review')
        cases = (None, [], ['speech_review'], [{'role': 'assistant', 'content': valid[-1]['content']}],
                 [*valid, {'role': 'user', 'content': 'ordinary answer'}],
                 [{'role': 'user', 'content': valid[-1]['content'], 'extra': True}])
        for messages in cases:
            before = copy.deepcopy(messages)
            self.assertEqual(request_timeout_seconds(messages), 600)
            self.assertEqual(messages, before)
        before = copy.deepcopy(valid)
        self.assertEqual(request_timeout_seconds(valid), 3600)
        self.assertEqual(valid, before)

    def test_reply_grace_and_defaults_are_fixed(self):
        self.assertEqual((DEFAULT_REQUEST_TIMEOUT_SECONDS, FINAL_REQUEST_TIMEOUT_SECONDS, REPLY_GRACE_SECONDS),
                         (600, 3600, 20))
        self.assertEqual(request_timeout_seconds(envelope('turn_draft')) + REPLY_GRACE_SECONDS, 620)
        self.assertEqual(request_timeout_seconds(envelope('speech_review')) + REPLY_GRACE_SECONDS, 3620)


if __name__ == '__main__':
    unittest.main()
