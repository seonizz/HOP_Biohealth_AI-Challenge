#!/usr/bin/env python3
"""Loopback HTTP adapter for a root-supervised SSH JSONL evaluation worker.

The bridge never installs software or starts a GPU server during import/tests.
The explicit CLI command starts one owned SSH stdio process; EOF requests its
graceful checkpoint verification and GPU release. No process is force-killed.
"""
import argparse
import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading

MODEL = 'malssi-gemma4-31b-controlled'
REMOTE_ROOT = '/home/slim/choieram/model_Training/gpu31b_controlled_20261112_v13'
REMOTE_ROOT_R2 = REMOTE_ROOT + '_r2'
ALLOWED_REMOTE_ROOTS = (REMOTE_ROOT, REMOTE_ROOT_R2)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def wire_json(value):
    # With any_order=False, JSON Schema property order is decoder behavior.
    # Canonical sorting is for identity hashes, never the worker input stream.
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        handle.flush(); os.fsync(handle.fileno())
    temporary.replace(path)


def append_line(path, text):
    with Path(path).open('a') as handle:
        handle.write(text); handle.flush(); os.fsync(handle.fileno())


def remote_identity(ready):
    """Normalize endpoint names without converting remote manifests into GGUF hashes."""
    identity = ready.get('identity', ready)
    base = identity.get('base_model_path') or identity.get('base_path')
    adapter = identity.get('adapter_path')
    base_manifest = identity.get('base_manifest_sha256') or identity.get('base_model_manifest_sha256')
    adapter_file = identity.get('adapter_file_sha256') or identity.get('adapter_model_sha256')
    tensor = identity.get('adapter_tensor_digest') or identity.get('adapter_tensor_sha256')
    tokenizer = identity.get('tokenizer_manifest_sha256') or identity.get('tokenizer_sha256')
    return {'model': ready.get('model'), 'base_model_path': base, 'adapter_path': adapter,
            'base_model_digest': {'kind': 'remote_directory_manifest_sha256', 'value': base_manifest},
            'adapter_file_sha256': adapter_file, 'adapter_tensor_digest': tensor,
            'tokenizer_manifest_sha256': tokenizer, 'worker_ready_sha256': digest(ready),
            'identity_kind': 'verified_remote_worker_manifest'}


def validate_ready(ready, remote_root=None):
    if ready.get('event') != 'ready' or ready.get('model') != MODEL:
        raise ValueError('Unexpected worker ready/model identity')
    normalized = remote_identity(ready)
    for key in ('base_model_path', 'adapter_path'):
        value = normalized[key]
        if not isinstance(value, str) or not value.startswith('/home/slim/choieram/') or '..' in value.split('/'):
            raise ValueError('Worker model path outside authorized boundary')
    for value in (normalized['base_model_digest']['value'], normalized['adapter_file_sha256'],
                  normalized['adapter_tensor_digest'], normalized['tokenizer_manifest_sha256']):
        if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError('Missing verified worker model/tokenizer digest')
    root = ready.get('remote_root') or ready.get('work_root') or ready.get('identity', {}).get('remote_root')
    if root not in ALLOWED_REMOTE_ROOTS or remote_root is not None and root != remote_root:
        raise ValueError('Worker work root differs from authorized run root')
    capabilities = ready.get('capabilities', {})
    if capabilities.get('max_context_tokens') != 32768 or capabilities.get('max_output_tokens') != 8192:
        raise ValueError('Unexpected worker token limits')
    if capabilities.get('stream') is not False or capabilities.get('truncation') is not False:
        raise ValueError('Worker must reject streaming and preserve complete inputs')
    return normalized


class WorkerSession:
    def __init__(self, process, output, remote_root=None, request_timeout=1020):
        self.process, self.output, self.remote_root = process, Path(output), remote_root
        self.output.mkdir(parents=True, exist_ok=True)
        self.request_timeout = request_timeout
        self.ready_event, self.closed_event, self.fatal_event = threading.Event(), threading.Event(), threading.Event()
        self.ready = None; self.closed = None; self.failure = None
        self.fatal_cause = None; self.inflight_id = None; self.inflight_started_at = None
        self.responses = queue.Queue(); self.lock = threading.Lock(); self.state_lock = threading.Lock(); self.sequence = 0
        self.reader = threading.Thread(target=self._read_stdout, daemon=True); self.reader.start()

    def _fail(self, message, code):
        with self.state_lock:
            if self.fatal_cause is not None:
                return self.failure
            self.failure = message
            self.fatal_cause = {'schema': 'gpu31b-first-fatal-v1', 'code': code, 'message': message,
                'observed_at': stamp(), 'inflight_id': self.inflight_id, 'inflight_started_at': self.inflight_started_at}
            write_json(self.output / 'bridge-fatal.json', self.fatal_cause)
            self.fatal_event.set(); self.ready_event.set(); self.responses.put(None)
            return self.failure

    def _read_stdout(self):
        try:
            for line in self.process.stdout:
                append_line(self.output / 'worker-stdout.jsonl', line)
                value = json.loads(line)
                if value.get('event') == 'ready':
                    if self.ready is not None:
                        raise ValueError('Duplicate worker ready event')
                    validate_ready(value, self.remote_root)
                    self.ready = value; write_json(self.output / 'worker-ready.json', value); self.ready_event.set()
                elif 'id' in value:
                    if self.ready is None or ('response' in value) == ('error' in value):
                        raise ValueError('Invalid worker response envelope')
                    if self.failure:
                        append_line(self.output / 'late-worker-replies.jsonl', canonical({'time': stamp(), 'id': value['id'], 'first_fatal_code': self.fatal_cause['code']}) + '\n')
                        continue
                    if value['id'] != self.inflight_id:
                        self._fail('Worker response identifier differs from in-flight request', 'worker_response_id_mismatch')
                        continue
                    self.responses.put(value)
                elif value.get('event') == 'closed':
                    self.closed = value; write_json(self.output / 'worker-closed.json', value); self.closed_event.set()
                    if self.inflight_id is not None:
                        self._fail('Worker closed during an in-flight request lifecycle', 'worker_closed_with_inflight_request')
                    if value.get('status') != 'passed' or value.get('adapter_unchanged') is not True:
                        raise ValueError('Worker closed without unchanged-adapter verification')
                elif value.get('event') == 'failed':
                    raise ValueError('Worker reported failure')
                else:
                    raise ValueError('Unknown worker protocol line')
        except Exception as error:
            self._fail(str(error), 'invalid_worker_protocol')
        finally:
            if not self.closed_event.is_set() and self.failure is None:
                self._fail('Worker stdout EOF before verified closed event', 'worker_stdout_eof')
            self.ready_event.set()

    def wait_ready(self, timeout=900):
        if not self.ready_event.wait(timeout):
            raise TimeoutError('Worker ready timeout')
        if self.failure or self.ready is None:
            raise ValueError(self.failure or 'Worker never reported ready')
        return self.ready

    def request(self, payload, request_id=None):
        with self.lock:
            if self.failure or self.ready is None or self.closed is not None:
                raise RuntimeError(self.failure or 'Worker unavailable')
            self.sequence += 1; identifier = self.sequence
            if request_id is not None:
                from gpu31b_request_control import request_id as canonical_request_id
                identifier = canonical_request_id(request_id)
            envelope = {'id': identifier, 'payload': payload}
            with self.state_lock:
                self.inflight_id = identifier; self.inflight_started_at = stamp()
            try:
                line = wire_json(envelope) + '\n'
                append_line(self.output / 'worker-stdin.jsonl', line)
                try:
                    self.process.stdin.write(line); self.process.stdin.flush()
                except (BrokenPipeError, OSError) as error:
                    raise RuntimeError(self._fail('Worker stdin write failed: ' + type(error).__name__, 'worker_stdin_write_failure')) from error
                try:
                    response = self.responses.get(timeout=self.request_timeout)
                except queue.Empty as error:
                    raise TimeoutError(self._fail('Worker response timeout; dispatch halted', 'worker_response_timeout')) from error
                if response is None:
                    raise RuntimeError(self.failure or self._fail('Worker response unavailable', 'worker_response_missing'))
                if response.get('id') != identifier:
                    raise RuntimeError(self._fail('Worker response identifier differs from in-flight request', 'worker_response_id_mismatch'))
                return response
            finally:
                with self.state_lock:
                    self.inflight_id = None; self.inflight_started_at = None

    def close(self, timeout=180):
        # Wait for the currently serialized call; do not terminate the GPU worker.
        with self.lock:
            if not self.process.stdin.closed:
                try:
                    self.process.stdin.close()
                except OSError as error:
                    if self.closed is None:
                        self._fail('Worker stdin close failed: ' + type(error).__name__, 'worker_stdin_close_failure')
        closed = self.closed_event.wait(timeout)
        verified = closed and self.closed.get('status') == 'passed' and self.closed.get('adapter_unchanged') is True
        write_json(self.output / 'bridge-close.json', {'time': stamp(), 'worker_closed_received': closed, 'worker_close_verified': verified,
                   'worker_closed': self.closed, 'force_killed_processes': False, 'protocol_error': self.failure})
        return verified


def checked_payload(payload, ready):
    if not isinstance(payload, dict) or payload.get('model') != ready['model']:
        raise ValueError('Requested model differs from resident worker')
    if payload.get('stream') is not False:
        raise ValueError('Only explicit non-streaming requests are supported')
    if payload.get('response_format') is not None or 'grammar' in payload:
        raise ValueError('Worker does not enforce response_format or grammar; use registered prompt transport')
    adapters = payload.get('lora')
    if not isinstance(adapters, list) or len(adapters) != 1 or adapters[0].get('id') != 0 or type(adapters[0].get('scale')) not in (int, float) or adapters[0]['scale'] not in (0, 1):
        raise ValueError('Exactly one explicit adapter id0 scale0/1 is required')
    if not isinstance(payload.get('messages'), list) or not payload['messages']:
        raise ValueError('Missing messages')
    if type(payload.get('max_tokens')) is not int or not 0 < payload['max_tokens'] <= ready['capabilities']['max_output_tokens']:
        raise ValueError('Invalid output budget')
    if payload.get('temperature') != 0 or payload.get('seed') != 3407:
        raise ValueError('Evaluation requires greedy temperature0 seed3407')
    return payload


def handler_class(session):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_json(self, status, value, extra_headers=None):
            body = canonical(value).encode()
            try:
                self.send_response(status); self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body))); self.send_header('Connection', 'close')
                if session.ready is not None:
                    self.send_header('X-Evaluation-Worker-Ready-SHA256', digest(session.ready))
                for key, value in (extra_headers or {}).items():
                    self.send_header(key, value)
                self.end_headers(); self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                if hasattr(session, 'output'):
                    append_line(session.output / 'http-client-disconnects.jsonl', canonical({'time': stamp(), 'status': status}) + '\n')

        def do_GET(self):
            if self.path not in ('/health', '/props', '/lora-adapters'):
                return self.send_json(404, {'error': {'code': 'unknown_endpoint'}})
            if session.ready is None or session.failure or session.closed is not None:
                return self.send_json(503, {'error': {'code': 'worker_unavailable'}})
            normalized = remote_identity(session.ready)
            if self.path == '/health':
                value = {'status': 'ok', **normalized, 'capabilities': session.ready['capabilities']}
            elif self.path == '/props':
                value = {'model_path': normalized['base_model_path'], 'model_alias': session.ready['model'],
                         **normalized, 'worker_ready': session.ready, 'capabilities': session.ready['capabilities']}
            else:
                value = [{'id': 0, 'path': normalized['adapter_path'], 'scale': None,
                          'scale_scope': 'per_request_required_no_global_scale_claim',
                          'adapter_file_sha256': normalized['adapter_file_sha256'],
                          'adapter_tensor_digest': normalized['adapter_tensor_digest']}]
            self.send_json(200, value)

        def do_POST(self):
            if self.path != '/v1/chat/completions':
                return self.send_json(404, {'error': {'code': 'unknown_endpoint'}})
            if self.headers.get('Origin') or self.headers.get('Transfer-Encoding'):
                return self.send_json(400, {'error': {'code': 'unsupported_request_origin_or_encoding'}})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8 * 1024 * 1024:
                    raise ValueError('Invalid body length')
                payload = checked_payload(json.loads(self.rfile.read(length)), session.ready or {})
            except (ValueError, KeyError, TypeError) as error:
                return self.send_json(400, {'error': {'code': 'invalid_evaluation_request', 'message': str(error)}})
            try:
                response = session.request(payload)
                evidence_headers = {'X-Evaluation-Worker-Response-ID': str(response['id']),
                                    'X-Evaluation-Worker-Reply-SHA256': digest(response)}
                if 'error' in response:
                    error = response['error']; kind = error.get('type')
                    return self.send_json(504 if kind == 'timeout_error' else 500 if kind == 'server_error' else 400, {'error': error}, evidence_headers)
                self.send_json(200, response['response'], evidence_headers)
            except (RuntimeError, OSError, TimeoutError) as error:
                self.send_json(503, {'error': {'code': 'worker_transport_failure', 'message': str(error)}})

    return Handler


def make_server(session, port):
    server = ThreadingHTTPServer(('127.0.0.1', port), handler_class(session))
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-socket', required=True)
    parser.add_argument('--remote-root', default=REMOTE_ROOT)
    parser.add_argument('--worker-command', required=True)
    parser.add_argument('--port', type=int, default=11440)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.remote_root not in ALLOWED_REMOTE_ROOTS or args.remote_root not in args.worker_command or '\n' in args.worker_command:
        parser.error('Explicit worker command must name the authorized remote run root')
    args.output.mkdir(parents=True, exist_ok=False)
    command = ['ssh', '-S', args.ssh_socket, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes',
               '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=10', '-p', '20522',
               'slim@165.194.161.61', args.worker_command]
    write_json(args.output / 'bridge-command.json', {'command': command, 'remote_root': args.remote_root, 'port': args.port})
    with (args.output / 'ssh-stderr.log').open('w') as stderr:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)
        session = WorkerSession(process, args.output, args.remote_root)
        session.wait_ready(); server = make_server(session, args.port)
        def stop(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
        write_json(args.output / 'bridge-ready.json', {'ready_at': stamp(), 'port': args.port, 'worker_ready_sha256': digest(session.ready)})
        try:
            server.serve_forever()
        finally:
            server.server_close(); session.close()


if __name__ == '__main__':
    main()
