import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import run_paired_role_evaluation as runner


class Response:
    def __init__(self, payload, status=200):
        self.raw = json.dumps(payload).encode()
        self.status = status
        self.headers = {'Content-Type': 'application/json'}
    def read(self):
        return self.raw
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


class PairedCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.suite_root = self.root / 'development'
        self.suite_root.mkdir()
        self.base = self.root / 'base.gguf'
        self.adapter = self.root / 'adapter.gguf'
        self.base.write_bytes(b'base')
        self.adapter.write_bytes(b'adapter')
        request = {'request_id': 'case-1-request', 'task': 'supporter_chat', 'format': 'text',
                   'messages': [{'role': 'user', 'content': 'inference input'}]}
        self.input = {'case_id': 'case-1', 'requests': [request]}
        reference = {'case_id': 'case-1', 'input_sha256': runner.digest(self.input),
                     'gold_secret': 'NEVER SEND GOLD'}
        self.suite = {'schema': 'malssi-role-evaluation-suite-v1', 'split': 'development',
                      'model_role': 'chat_12b', 'cases': [{'case_id': 'case-1',
                      'source_family_id': 'family-1', 'input_sha256': runner.digest(self.input),
                      'reference_sha256': runner.digest(reference)}]}
        for name, value in [('SUITE.json', self.suite), ('INPUTS.jsonl', self.input),
                            ('REFERENCES.jsonl', reference)]:
            (self.suite_root / name).write_text(json.dumps(value) + '\n')
        self.posts = []

    def fake_http(self, request, timeout=None):
        if isinstance(request, str):
            if request.endswith('/props'):
                return Response({'model_path': str(self.base), 'model_alias': 'paired'})
            return Response([{'id': 0, 'path': str(self.adapter), 'scale': 0}])
        payload = json.loads(request.data)
        self.posts.append(payload)
        return Response({'choices': [{'message': {'content': 'first unrepaired output'},
                                      'finish_reason': 'stop'}], 'usage': {'completion_tokens': 4}})

    def collect(self, name='run'):
        return runner.collect(self.suite_root, self.root / name, 'http://127.0.0.1:11438',
                              self.base, self.adapter)

    def test_collect_preserves_pair_and_raw_evidence(self):
        with patch.object(runner.urllib.request, 'urlopen', side_effect=self.fake_http):
            result = self.collect()
        self.assertEqual([p['lora'][0]['scale'] for p in self.posts], [0, 1])
        self.assertNotIn('NEVER SEND GOLD', json.dumps(self.posts))
        self.assertTrue(all(p['temperature'] == 0 and p['seed'] == 3407 and not p['cache_prompt'] for p in self.posts))
        self.assertEqual(result['status'], 'completed')
        for arm in result['arms'].values():
            self.assertEqual(arm, {'assigned_count': 1, 'received_count': 1,
                                  'failed_count': 0, 'not_run_count': 0})
        assignments = [json.loads(row) for row in (self.root / 'run/assignments.jsonl').read_text().splitlines()]
        self.assertEqual(len(assignments), 2)
        self.assertEqual(assignments[0]['source_group_id'], 'family-1')
        self.assertEqual(json.loads((self.root / 'run/http/000001/response.bin').read_bytes())['choices'][0]['message']['content'], 'first unrepaired output')
        outputs = [json.loads(row) for row in (self.root / 'run/outputs.jsonl').read_text().splitlines()]
        self.assertTrue(all(row['output_stage'] == 'first_draft' for row in outputs))
        with self.assertRaises(FileExistsError):
            self.collect()

    def test_http_failure_is_logged_without_retry(self):
        def fail_first(request, timeout=None):
            if not isinstance(request, str) and not self.posts:
                self.posts.append(json.loads(request.data))
                return Response({'error': 'broken'}, status=503)
            return self.fake_http(request, timeout)
        with patch.object(runner.urllib.request, 'urlopen', side_effect=fail_first):
            result = self.collect()
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(result['arms']['baseline']['failed_count'], 1)
        self.assertEqual(result['arms']['trained']['received_count'], 1)
        meta = json.loads((self.root / 'run/http/000001/response-meta.json').read_text())
        self.assertEqual(meta['status'], 503)
        self.assertEqual(meta['error'], 'http_status_503')

    def test_corrupted_suite_rejected_before_network(self):
        self.input['requests'][0]['messages'][0]['content'] = 'tampered'
        (self.suite_root / 'INPUTS.jsonl').write_text(json.dumps(self.input))
        with patch.object(runner.urllib.request, 'urlopen') as http:
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                self.collect()
        http.assert_not_called()
        self.assertFalse((self.root / 'run').exists())

    def test_identity_failure_freezes_not_run_assignments(self):
        with patch.object(runner.urllib.request, 'urlopen', return_value=Response({'model_path': '/wrong'})):
            with self.assertRaises(ValueError):
                self.collect()
        result = json.loads((self.root / 'run/summary.json').read_text())
        self.assertEqual(result['status'], 'blocked_identity_or_connectivity')
        self.assertEqual(result['arms']['baseline']['not_run_count'], 1)
        self.assertEqual(result['arms']['trained']['not_run_count'], 1)
        self.assertFalse(self.posts)

    def test_duplicate_request_ids_rejected(self):
        self.input['requests'].append(self.input['requests'][0])
        self.suite['cases'][0]['input_sha256'] = runner.digest(self.input)
        ref = json.loads((self.suite_root / 'REFERENCES.jsonl').read_text())
        ref['input_sha256'] = runner.digest(self.input)
        self.suite['cases'][0]['reference_sha256'] = runner.digest(ref)
        (self.suite_root / 'SUITE.json').write_text(json.dumps(self.suite))
        (self.suite_root / 'INPUTS.jsonl').write_text(json.dumps(self.input))
        (self.suite_root / 'REFERENCES.jsonl').write_text(json.dumps(ref))
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            runner.load_suite(self.suite_root)

    def test_empty_response_is_failed_without_retry(self):
        def empty(request, timeout=None):
            if isinstance(request, str):
                return self.fake_http(request, timeout)
            self.posts.append(json.loads(request.data))
            return Response({'choices': [{'message': {'content': ''}, 'finish_reason': 'stop'}]})
        with patch.object(runner.urllib.request, 'urlopen', side_effect=empty):
            result = self.collect()
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(result['arms']['baseline']['received_count'], 0)
        self.assertEqual(result['arms']['baseline']['failed_count'], 1)

    def test_pair_order_alternates_and_limits_preserve_pairs(self):
        second = dict(self.input['requests'][0], request_id='case-1-second')
        self.input['requests'].append(second)
        self.suite['cases'][0]['input_sha256'] = runner.digest(self.input)
        ref = json.loads((self.suite_root / 'REFERENCES.jsonl').read_text())
        ref['input_sha256'] = runner.digest(self.input)
        self.suite['cases'][0]['reference_sha256'] = runner.digest(ref)
        for name, value in [('SUITE.json', self.suite), ('INPUTS.jsonl', self.input), ('REFERENCES.jsonl', ref)]:
            (self.suite_root / name).write_text(json.dumps(value))
        _, assignments = runner.load_suite(self.suite_root)
        self.assertEqual([row['arm'] for row in assignments], ['baseline', 'trained', 'trained', 'baseline'])
        _, selected = runner.load_suite(self.suite_root, limit_requests=1)
        self.assertEqual(len(selected), 2)
        self.assertEqual(len({row['request_id'] for row in selected}), 1)

    def test_remote_endpoint_rejected(self):
        with self.assertRaisesRegex(ValueError, 'loopback'):
            runner.collect(self.suite_root, self.root / 'run', 'http://165.194.161.61:20522',
                           self.base, self.adapter)


if __name__ == '__main__':
    unittest.main()
