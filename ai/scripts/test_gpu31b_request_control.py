import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import uuid

from gpu31b_request_control import RequestControl, cancel_request, recovery_receipt
from gpu31b_eval_worker import Deadline
import gpu31b_eval_worker as worker


class RequestControlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.identifier = str(uuid.uuid4())

    def test_cancel_is_scoped_idempotent_and_never_reaches_next_request(self):
        control = RequestControl(self.root, self.identifier)
        self.assertFalse(control.cancelled())
        first = cancel_request(self.root, self.identifier)
        self.assertEqual(cancel_request(self.root, self.identifier), first)
        self.assertTrue(control.cancelled())
        self.assertFalse(RequestControl(self.root, str(uuid.uuid4())).cancelled())

    def test_noncanonical_ids_and_linked_paths_fail_closed(self):
        for identifier in ['../elsewhere', '', 1, self.identifier.upper()]:
            with self.assertRaises((ValueError, AttributeError)):
                cancel_request(self.root, identifier)
        (self.root / 'elsewhere').mkdir()
        (self.root / 'request-cancellations').symlink_to(self.root / 'elsewhere')
        with self.assertRaises(ValueError):
            cancel_request(self.root, self.identifier)

    def test_wrong_marker_id_and_hardlink_fail_closed(self):
        cancel_request(self.root, self.identifier)
        path = self.root / 'request-cancellations' / (self.identifier + '.json')
        path.write_text(json.dumps({'request_id': str(uuid.uuid4()), 'cancelled': True}))
        with self.assertRaises(ValueError):
            RequestControl(self.root, self.identifier).cancelled()
        path.write_text(json.dumps({'request_id': self.identifier, 'cancelled': True}))
        (self.root / 'linked').hardlink_to(path)
        with self.assertRaises(ValueError):
            RequestControl(self.root, self.identifier).cancelled()

    def test_cancelled_deadline_is_distinct_from_elapsed_deadline(self):
        clock = Mock(return_value=0)
        control = RequestControl(self.root, self.identifier)
        deadline = Deadline(seconds=900, clock=clock, cancellation=control.cancelled)
        self.assertFalse(deadline(None, None))
        cancel_request(self.root, self.identifier)
        self.assertTrue(deadline(None, None))
        self.assertTrue(deadline.cancelled)
        self.assertFalse(deadline.expired)

    def test_reuse_requires_cleanup_and_matching_adapter_proof(self):
        evidence = {'cache_entries_cleared_after': [], 'adapter_digest_before': 'verified', 'adapter_digest_after': 'verified'}
        self.assertTrue(recovery_receipt(self.identifier, evidence)['worker_reusable'])
        for broken in [{}, {**evidence, 'adapter_digest_after': 'changed'}, {**evidence, 'cache_entries_cleared_after': None}]:
            self.assertFalse(recovery_receipt(self.identifier, broken)['worker_reusable'])

    def test_worker_serves_next_uuid_after_cancelled_request_cleanup(self):
        second = str(uuid.uuid4())
        cancel_request(self.root, self.identifier)
        calls, emitted = [], []
        evidence = {'cache_entries_cleared_after': [], 'adapter_digest_before': 'verified', 'adapter_digest_after': 'verified'}
        def generate(state, payload, request_control=None, **_):
            calls.append(request_control.identifier)
            if request_control.cancelled():
                raise worker.RequestError('request_cancelled', 'Stopped', dict(evidence))
            return {'ok': True}, dict(evidence)
        lines = ''.join(json.dumps({'id': identifier, 'payload': {}})+'\n' for identifier in [self.identifier, second])
        with patch.object(worker, 'generate', generate):
            worker.serve({'request_control_root': self.root}, io.StringIO(lines), emitted.append, {'requests': []}, self.root)
        self.assertEqual(calls, [self.identifier, second])
        self.assertEqual(emitted[0]['error']['code'], 'request_cancelled')
        self.assertTrue(emitted[0]['recovery']['worker_reusable'])
        self.assertEqual(emitted[0]['recovery']['request_id'], self.identifier)
        self.assertEqual(emitted[1]['response'], {'ok': True})


if __name__ == '__main__':
    unittest.main()
