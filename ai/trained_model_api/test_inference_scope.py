import json
import unittest
from concurrent.futures import ThreadPoolExecutor

from inference_scope import FOLDED_DECODE, qa_decode_attention


def request(stage):
    return [{'role': 'system', 'content': 'unchanged'},
            {'role': 'user', 'content': json.dumps({'stage': stage, 'data': {}, 'output_schema': {}})}]


class InferenceScopeTests(unittest.TestCase):
    def test_only_combined_qa_stages_enable_decode_optimization(self):
        for stage in ('turn_draft', 'turn_review', 'turn_draft_after_review', 'turn_review_after_review'):
            with self.subTest(stage=stage), qa_decode_attention(request(stage)) as enabled:
                self.assertTrue(enabled)
                self.assertTrue(FOLDED_DECODE.get())
        self.assertFalse(FOLDED_DECODE.get())

    def test_final_staged_and_unknown_requests_keep_original_attention(self):
        for stage in ('state_observations', 'relationship_memory', 'state_review', 'question_plan',
                      'guide', 'report', 'final_draft', 'turn_draft_final', '', None, ['turn_draft']):
            with self.subTest(stage=stage), qa_decode_attention(request(stage)) as enabled:
                self.assertFalse(enabled)
                self.assertFalse(FOLDED_DECODE.get())

    def test_text_nested_stage_and_incomplete_envelopes_cannot_enable(self):
        contents = ['turn_draft', '{', 'null', '[]', '"turn_draft"',
                    '[' * 1500 + '0' + ']' * 1500,
                    json.dumps({'stage': 'turn_draft'}),
                    json.dumps({'data': {'stage': 'turn_draft'}, 'output_schema': {}})]
        for content in contents:
            with self.subTest(content=content), qa_decode_attention([{'role': 'user', 'content': content}]) as enabled:
                self.assertFalse(enabled)
        for messages in (None, [], ['turn_draft'], [{'role': 'assistant', 'content': request('turn_draft')[-1]['content']}],
                         [*request('turn_draft'), {'role': 'user', 'content': 'normal next request'}]):
            with self.subTest(messages=messages), qa_decode_attention(messages) as enabled:
                self.assertFalse(enabled)

    def test_exception_does_not_leak_mode_to_final_request(self):
        with self.assertRaises(RuntimeError):
            with qa_decode_attention(request('turn_review')):
                self.assertTrue(FOLDED_DECODE.get())
                raise RuntimeError('generation failed')
        self.assertFalse(FOLDED_DECODE.get())
        with qa_decode_attention(request('final_draft')):
            self.assertFalse(FOLDED_DECODE.get())

    def test_nested_and_thread_contexts_are_independent(self):
        with qa_decode_attention(request('turn_draft')):
            with qa_decode_attention(request('final_draft')):
                self.assertFalse(FOLDED_DECODE.get())
            self.assertTrue(FOLDED_DECODE.get())
            with ThreadPoolExecutor(max_workers=1) as pool:
                self.assertFalse(pool.submit(FOLDED_DECODE.get).result())
        self.assertFalse(FOLDED_DECODE.get())


if __name__ == '__main__':
    unittest.main()
