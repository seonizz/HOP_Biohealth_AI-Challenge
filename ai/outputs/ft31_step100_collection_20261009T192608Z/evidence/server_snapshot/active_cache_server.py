"""Authenticated HTTP entrypoint for the single-worker 64K cache policy."""
from __future__ import annotations

import argparse
import hmac
import json
import os
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from active_cache import ActiveCacheError, Controller, owner_for_credential, public_copy

WORKSPACE = Path('/home/slim/choieram')
DEFAULT_POLICY = WORKSPACE / 'model_Training/active_cache_128k_review_20261010/cache_policy_64k.json'
MAX_BODY_BYTES = 8 * 1024 * 1024


def _safe_path(path):
    path = Path(path).resolve()
    if path != WORKSPACE and WORKSPACE not in path.parents:
        raise ValueError('Runtime path must be inside the authorized workspace.')
    return path


def load_hmac_key(runtime):
    path = _safe_path(runtime / 'active_cache_hmac.key')
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.is_symlink():
            raise ValueError('Invalid HMAC key path.')
    else:
        with os.fdopen(fd, 'wb') as output:
            output.write(os.urandom(32))
            output.flush()
            os.fsync(output.fileno())
    os.chmod(path, 0o600)
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError('Invalid HMAC key length.')
    return key


def _status_file(runtime, data):
    path = _safe_path(runtime / 'status.json')
    temporary = _safe_path(runtime / 'active_cache_status.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(data, output, ensure_ascii=False, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key.')
        result[key] = value
    return result


def make_server(config, controller, api_key, health, validate_stateless):
    credential = 'Bearer ' + api_key
    owner = owner_for_credential(api_key)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'ActiveCache/1'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, format, *args):
            # Do not log authorization headers, request bodies, source text or IDs.
            pass

        def _send(self, status, payload):
            body = json.dumps(public_copy(payload), ensure_ascii=False,
                              separators=(',', ':'), allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            if status == 503:
                self.send_header('Retry-After', str(controller.policy['queue']['retry_after_seconds']))
            self.end_headers()
            self.close_connection = True
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def _auth(self):
            values = self.headers.get_all('Authorization') or []
            if len(values) != 1 or not hmac.compare_digest(values[0].encode('utf-8'), credential.encode('utf-8')):
                raise ActiveCacheError(401, 'unauthorized', 'Valid bearer authorization required.')

        def _body(self):
            if self.headers.get_all('Transfer-Encoding'):
                raise ActiveCacheError(400, 'unsupported_transfer_encoding', 'Transfer-Encoding is not supported.')
            values = self.headers.get_all('Content-Length') or []
            if len(values) != 1 or not values[0].isascii() or not values[0].isdigit():
                raise ActiveCacheError(400 if values else 411, 'invalid_content_length', 'One numeric Content-Length is required.')
            length = int(values[0])
            if length > MAX_BODY_BYTES:
                raise ActiveCacheError(413, 'body_too_large', 'Request body limit exceeded.')
            media = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
            if media != 'application/json':
                raise ActiveCacheError(415, 'invalid_content_type', 'application/json is required.')
            try:
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ActiveCacheError(400, 'incomplete_body', 'Incomplete request body.')
                payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_json_object,
                                     parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite number.')))
            except (socket.timeout, TimeoutError):
                raise ActiveCacheError(408, 'body_timeout', 'Request body deadline exceeded.') from None
            except (UnicodeError, ValueError):
                raise ActiveCacheError(400, 'invalid_json', 'Valid UTF-8 JSON required.') from None
            if not isinstance(payload, dict):
                raise ActiveCacheError(400, 'invalid_request', 'JSON object required.')
            return payload

        def _path(self):
            parts = urlsplit(self.path)
            if parts.query or parts.fragment or '%' in parts.path or '//' in parts.path:
                raise ActiveCacheError(400, 'invalid_path', 'Unsupported request path.')
            return [x for x in parts.path.split('/') if x]

        def _dispatch(self, method):
            try:
                self._auth()
                if len(self.headers.get_all('Content-Length') or []) > 1:
                    raise ActiveCacheError(400, 'invalid_content_length', 'One Content-Length is allowed.')
                if self.headers.get_all('Transfer-Encoding'):
                    raise ActiveCacheError(400, 'unsupported_transfer_encoding', 'Transfer-Encoding is not supported.')
                parts = self._path()
                if method == 'GET' and parts == ['healthz']:
                    return self._send(200, health())
                if method == 'GET' and parts == ['v1', 'models']:
                    return self._send(200, {'object': 'list', 'data': [{'id': config['model_id'], 'object': 'model', 'owned_by': 'local'}]})
                if method == 'POST' and parts == ['v1', 'chat', 'completions']:
                    payload = self._body()
                    try:
                        messages, maximum, temperature, top_p = validate_stateless(payload, config)
                    except ValueError:
                        raise ActiveCacheError(400, 'invalid_request', 'Invalid chat completion request.') from None
                    return self._send(200, controller.stateless(owner, messages, maximum, temperature, top_p))
                if method == 'POST' and parts == ['v1', 'sessions']:
                    return self._send(201, controller.create_session(owner, self._body()))
                if len(parts) >= 3 and parts[:2] == ['v1', 'sessions']:
                    sid = parts[2]
                    if method == 'GET' and len(parts) == 3:
                        return self._send(200, controller.get_session(owner, sid))
                    if method == 'DELETE' and len(parts) == 3:
                        return self._send(200, controller.delete_session(owner, sid))
                    if method == 'POST' and len(parts) == 4 and parts[3] == 'turns':
                        keys = self.headers.get_all('Idempotency-Key') or []
                        if len(keys) > 1:
                            raise ActiveCacheError(400, 'invalid_idempotency_key', 'One Idempotency-Key header is allowed.')
                        return self._send(200, controller.turn(owner, sid, self._body(), keys[0] if keys else None))
                    if method == 'GET' and len(parts) == 4 and parts[3] == 'cache':
                        return self._send(200, controller.cache_status(owner, sid))
                    if method == 'GET' and len(parts) == 4 and parts[3] == 'memory-jobs':
                        return self._send(200, controller.list_jobs(owner, sid))
                if method == 'GET' and parts == ['v1', 'memories']:
                    return self._send(200, controller.list_memories(owner))
                if len(parts) == 3 and parts[:2] == ['v1', 'memories']:
                    if method == 'GET':
                        return self._send(200, controller.get_memory(owner, parts[2]))
                    if method == 'DELETE':
                        return self._send(200, controller.delete_memory(owner, parts[2]))
                if method == 'GET' and parts == ['v1', 'memory-jobs']:
                    return self._send(200, controller.list_jobs(owner))
                if method == 'GET' and len(parts) == 3 and parts[:2] == ['v1', 'memory-jobs']:
                    return self._send(200, controller.get_job(owner, parts[2]))
                if method == 'DELETE' and len(parts) == 3 and parts[:2] == ['v1', 'sources']:
                    return self._send(200, controller.delete_source(owner, parts[2]))
                raise ActiveCacheError(404, 'not_found', 'Endpoint not found.')
            except Exception as exc:
                legacy_request_error = isinstance(exc, ValueError) and type(exc).__name__ == 'RequestError'
                status = getattr(exc, 'status', 422 if legacy_request_error else 500)
                code = getattr(exc, 'code', 'model_request_rejected' if legacy_request_error else 'internal_error')
                message = getattr(exc, 'message', 'Model request limits exceeded.' if legacy_request_error else 'Request failed.')
                if not isinstance(status, int) or not 400 <= status <= 599:
                    status, code, message = 500, 'internal_error', 'Request failed.'
                # Unexpected exceptions and tracebacks never become response bodies.
                if status >= 500 and status != 503:
                    message = 'Request failed.'
                self._send(status, {'error': {'code': code, 'message': message, 'type': 'request_error'}})

        def do_GET(self):
            self._dispatch('GET')

        def do_POST(self):
            self._dispatch('POST')

        def do_DELETE(self):
            self._dispatch('DELETE')

    class Server(ThreadingHTTPServer):
        daemon_threads = False
        block_on_close = True
        allow_reuse_address = True

    return Server((config['host'], config['port']), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parent / 'config.json')
    args = parser.parse_args()
    config_path = _safe_path(args.config)
    from server import load_api_key, validate_config, validate_request
    from backend import ModelBackend
    from active_cache_store import Store
    from active_cache_runtime import CacheRuntime
    config = validate_config(json.loads(config_path.read_text()))
    policy_path = _safe_path(config.get('active_cache_policy', DEFAULT_POLICY))
    policy = json.loads(policy_path.read_text())
    limits = policy['token_limits']
    # Preserve the legacy validator while applying the explicit 64K input+output policy.
    config['max_context_tokens'] = limits['request_total_hard_cap']
    config['max_output_tokens'] = limits['output_hard_cap']
    config['default_output_tokens'] = limits['output_default']
    runtime_dir = _safe_path(config_path.parent / 'runtime')
    runtime_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(runtime_dir, 0o700)
    api_key = load_api_key(runtime_dir)
    hmac_key = load_hmac_key(runtime_dir)
    backend = controller = httpd = store = None
    status = {'status': 'loading', 'state': 'loading', 'pid': os.getpid(),
              'model': config['model_id'], 'model_id': config['model_id'],
              'port': config['port'], 'checkpoint_sha256': config['checkpoint_sha256'],
              'checkpoint_step': config['checkpoint_step'],
              'max_context_tokens': limits['request_total_hard_cap'],
              'max_input_tokens': limits['rendered_input_hard_cap'],
              'max_output_tokens': limits['output_hard_cap'],
              'policy_id': policy['policy_id']}
    _status_file(runtime_dir, status)
    try:
        backend = ModelBackend(config, runtime_dir)
        runtime = CacheRuntime(backend, policy, runtime_dir)
        if hasattr(runtime, 'calibrate_planner'):
            runtime.calibrate_planner()
        store = Store(runtime_dir / 'active_cache.sqlite3', hmac_key,
                      policy['policy_id'], runtime.fingerprint)
        controller = Controller(store, runtime, policy, hmac_key, config['model_id'])
        controller.register_owner(owner_for_credential(api_key))
        status.update(status='ready', state='ready', model_fingerprint=runtime.fingerprint)
        _status_file(runtime_dir, status)
        httpd = make_server(config, controller, api_key, lambda: dict(status), validate_request)
        def stop(signum, frame):
            if status['state'] == 'stopping':
                return
            status['status'] = status['state'] = 'stopping'
            controller.stop_event.set()
            controller.wake_event.set()
            controller.queue.close()
            _status_file(runtime_dir, status)
            # shutdown cannot be called from serve_forever's own thread.
            threading.Thread(target=httpd.shutdown, name='http-shutdown', daemon=True).start()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, stop)
        httpd.serve_forever(poll_interval=0.2)
    finally:
        if httpd:
            httpd.server_close()
        if controller:
            controller.close()
        if store:
            store.close()
        if backend:
            backend.close()
        status['status'] = status['state'] = 'stopped'
        _status_file(runtime_dir, status)


if __name__ == '__main__':
    main()
