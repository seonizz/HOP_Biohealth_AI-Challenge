import unittest
import collect_base12_local as c


class CollectionContracts(unittest.TestCase):
    def response(self, content='SUPPORT', reason='stop'):
        return {'done': True, 'done_reason': reason, 'prompt_eval_count': 10,
                'message': {'content': content}}

    def test_length_limit_is_failure_even_for_valid_label(self):
        self.assertEqual(c.classify_status(self.response(reason='length'), 'action', 10), 'length_limit')

    def test_exact_label_only(self):
        self.assertEqual(c.classify_status(self.response(' SUPPORT\n'), 'action', 10), 'valid')
        for invalid in ['SUPPORT because...', '```SUPPORT```', 'SUPPORT\nEND']:
            self.assertEqual(c.classify_status(self.response(invalid), 'action', 10), 'format_error')

    def test_truncation_detection(self):
        self.assertEqual(c.classify_status(self.response(), 'action', 11), 'input_token_mismatch')

    def test_unknown_termination_not_success(self):
        self.assertEqual(c.classify_status(self.response(reason=None), 'response', 10), 'unverified_termination')

    def test_renderer_native_smoke_count(self):
        messages = [{'role': 'user', 'content': '한국어로 짧게 인사 한 문장만 작성하세요.'}]
        self.assertEqual(len(c.tokenizer().encode(c.render(messages), add_special_tokens=False).ids), 25)

    def test_renderer_groups_assistant_and_removes_historical_thought(self):
        rendered = c.render([{'role': 'assistant', 'content': '<|channel>secret<channel|>first'},
                             {'role': 'assistant', 'content': 'second'},
                             {'role': 'user', 'content': 'next'}])
        self.assertIn('<|turn>model\nfirstsecond<turn|>\n', rendered)
        self.assertNotIn('secret', rendered)


if __name__ == '__main__':
    unittest.main()
