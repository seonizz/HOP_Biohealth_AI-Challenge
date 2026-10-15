"""Offline regression checks; no network, GPU, or persistent fake generations."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import collect_ft31_comparison as c


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        with patch.object(c, 'ROOT', self.root), contextlib.redirect_stdout(io.StringIO()):
            self.run = c.prepare()
        cases = c.lines(self.run / 'case_manifest.jsonl')
        preflight = {'cases': [dict(task=r['task'], case_id=r['case_id'], eligible=True,
            input_tokens_preflight=100, exclusion_reason=None) for r in cases]}
        c.write(self.run / 'preflight.json', preflight)
        manifest = c.read(self.run / 'run_manifest.json')
        manifest.update(generation_ready=True, expected_system_fingerprint=c.FINGERPRINT,
            preflight_sha256=c.sha((self.run / 'preflight.json').read_bytes()))
        c.write(self.run / 'evidence/health_collection_start.json', {'system_fingerprint': c.FINGERPRINT})
        c.write(self.run / 'run_manifest.json', manifest)

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, transport):
        with patch.object(c, 'http', side_effect=transport), patch.object(c, 'health'), \
            patch.object(c, 'identity_health', return_value=({'pid': 1}, 'mocksha')), contextlib.redirect_stdout(io.StringIO()):
            return c.collect(self.run, 'http://offline.test')

    def test_original_hash_semantics_and_bytes(self):
        for case in c.lines(self.run / 'case_manifest.jsonl'):
            data = (self.run / case['input_file']).read_bytes()
            self.assertEqual(c.canonical_sha(json.loads(data)), case['input_sha256'])
            self.assertEqual(data, (c.BASE / case['input_file']).read_bytes())

    def test_429_recorded_once_and_stops(self):
        seen = []
        def transport(*args, **kwargs):
            seen.append(args)
            return 429, c.encoded({'error': {'message': 'busy'}})
        self.assertEqual(self.execute(transport), 2)
        self.assertEqual(len(seen), 1)
        rows = c.lines(self.run / 'generations.jsonl')
        self.assertEqual(rows[0]['status'], 'http_error')
        self.assertIsNone(rows[0]['input_tokens'])
        self.assertIsNone(rows[0]['generated_tokens'])
        self.assertEqual(c.read(self.run / 'COLLECTION_COMPLETE.json')['unexecuted'], 93)

    def test_timeout_has_unknown_completion_without_retry(self):
        self.assertEqual(self.execute(TimeoutError('offline test timeout')), 2)
        row = c.lines(self.run / 'generations.jsonl')[0]
        self.assertEqual(row['status'], 'unknown_completion')
        self.assertIsNone(row['http_status'])
        self.assertIsNone(row['generated_tokens'])

    def test_attempt_before_ledger_refuses_resubmission(self):
        case = c.lines(self.run / 'case_manifest.jsonl')[0]
        c.write(self.run / f"private/attempts/{case['task']}_{case['case_id']}.json", {'attempt_index': 1})
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            self.execute(lambda *args, **kwargs: self.fail('must not submit'))

    def test_identity_and_length_and_format(self):
        raw = {'model': c.MODEL, 'system_fingerprint': c.FINGERPRINT,
            'usage': {'prompt_tokens': 100, 'completion_tokens': 3},
            'choices': [{'message': {'content': ' SUPPORT '}, 'finish_reason': 'stop'}]}
        self.assertEqual(c.derive(raw, 'action', 100), ('valid', 'SUPPORT'))
        raw['choices'][0]['message']['content'] = 'SUPPORT\nEND'
        self.assertEqual(c.derive(raw, 'action', 100), ('format_error', None))
        raw['choices'][0]['finish_reason'] = 'length'
        self.assertEqual(c.derive(raw, 'action', 100), ('length_limit', None))
        self.assertEqual(c.derive(raw, 'action', 101), ('input_token_mismatch', None))
        raw['system_fingerprint'] = 'different'
        self.assertEqual(c.derive(raw, 'action', 100), ('identity_mismatch', None))


if __name__ == '__main__':
    unittest.main()
