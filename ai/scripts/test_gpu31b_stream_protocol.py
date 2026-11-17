"""CPU-only contract tests; fake workers never load a model or contact SSH."""
import hashlib
import ast
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from contextlib import nullcontext
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'ai/experiments/gpu31b_schema_stream'
from gpu31b_stream_protocol import StableTokenChunks, ChunkSequence, follow_response

def load_experiment(name):
    spec = importlib.util.spec_from_file_location('stream_experiment_' + name, RUNTIME/'code'/f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

# The tracked stream experiment deliberately differs from the prompt-only
# comparison worker. Never reuse another test's cached module by basename.
with patch.dict(sys.modules, {'json_guard': load_experiment('json_guard')}):
    worker = load_experiment('gpu31b_eval_worker')
bridge = load_experiment('gpu31b_eval_bridge')
WorkerSession, validate_ready = bridge.WorkerSession, bridge.validate_ready

MODEL = 'malssi-gemma4-31b-step5128'
REMOTE = '/home/slim/choieram/evaluations/gpu31b_stream_20261116'

def response(identifier, content):
    return {'id': identifier, 'response': {'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}],
        'evidence': {'json_grammar': {'full_output_replayed': True, 'eos_terminated': True, 'strict_json_parsed': True}}}}

def ready():
    return {'event': 'ready', 'model': MODEL, 'remote_root': REMOTE,
        'base_model_path': '/home/slim/choieram/base', 'adapter_path': '/home/slim/choieram/adapter',
        'base_manifest_sha256': 'a'*64, 'adapter_file_sha256': 'b'*64,
        'adapter_tensor_digest': 'c'*64, 'tokenizer_manifest_sha256': 'd'*64,
        'capabilities': {'stream': True, 'truncation': False, 'max_context_tokens': 40960, 'max_output_tokens': 8192}}

def payload(**overrides):
    return {'model': MODEL, 'messages': [{'role': 'user', 'content': '합성 검증'}], 'max_tokens': 8192,
        'temperature': 0, 'seed': 3407, 'stream': True, 'stream_options': {'include_usage': True},
        'lora': [{'id': 0, 'scale': 1}], 'response_format': {'type': 'json_schema', 'json_schema': {
            'name': 'app_output', 'strict': True, 'schema': {'type': 'object', 'properties': {'ok': {'type': 'boolean'}},
                'required': ['ok'], 'additionalProperties': False}}}, **overrides}


class StreamTests(unittest.TestCase):
    def test_unicode_tail_emits_inside_generation_and_final_assert_never_emits(self):
        chunks = []; during = []
        decoder = StableTokenChunks(lambda tokens: ''.join(tokens), lambda item: (chunks.append(item), during.append('generate')), tail_chars=32)
        text = '{"문장":"' + '친구🙂에게 마음을 전해요. '*8 + '"}'
        tokens = []
        for char in text:
            tokens.append(char); decoder.push(tokens)
        self.assertTrue(chunks, 'Must produce chunks before end/final response')
        self.assertLess(len(decoder.text), len(text))
        decoder.end(tokens); before = list(chunks); decoder.assert_final(text)
        self.assertEqual(chunks, before); self.assertEqual(''.join(c['delta'] for c in chunks), text)
        self.assertEqual([c['seq'] for c in chunks], list(range(1, len(chunks)+1)))
        self.assertTrue(all(c['delta'].encode('utf-8').decode('utf-8') == c['delta'] for c in chunks))
        with self.assertRaises(ValueError): decoder.push(tokens)

    def test_incomplete_unicode_is_held_and_prefix_drift_aborts(self):
        chunks = []; decoder = StableTokenChunks(lambda value: value, chunks.append, tail_chars=2)
        decoder.push('가나다\ufffd'); self.assertEqual(decoder.text, '가나')
        decoder.push('가나다🙂'); decoder.end('가나다🙂'); self.assertEqual(''.join(x['delta'] for x in chunks), '가나다🙂')
        drift = StableTokenChunks(lambda value: value, lambda _: None, tail_chars=1)
        drift.push('abcdef')
        with self.assertRaises(ValueError): drift.push('xbcdefg')

    def test_chunk_sequence_rejects_wrong_identifier_sequence_and_unverified_final(self):
        for change in [{'id': 2}, {'id': True}, {'seq': 2}, {'delta': ''}, {'at': float('nan')}]:
            sequence = ChunkSequence(1)
            with self.assertRaises(ValueError): sequence.accept({'event': 'chunk', 'id': 1, 'seq': 1, 'delta': '{}', 'at': 1, **change})
        for change in ['content', 'grammar', 'length']:
            sequence = ChunkSequence(1); sequence.accept({'event': 'chunk', 'id': 1, 'seq': 1, 'delta': '{}', 'at': 1})
            final = response(1, '{}')
            if change == 'content': final['response']['choices'][0]['message']['content'] = '[]'
            if change == 'grammar': final['response']['evidence']['json_grammar']['strict_json_parsed'] = False
            if change == 'length': final['response']['choices'][0]['finish_reason'] = 'length'
            with self.assertRaises(ValueError): sequence.terminal(final)
        sequence = ChunkSequence(1); sequence.terminal({'id': 1, 'error': {'code': 'generation_failed'}})
        with self.assertRaises(ValueError): sequence.accept({'event': 'chunk', 'id': 1, 'seq': 1, 'delta': '{}', 'at': 1})

    def test_worker_accepts_only_boolean_stream_options_and_keeps_full_input(self):
        for stream in (True, False):
            request = payload(stream=stream)
            if not stream: request.pop('stream_options')
            worker.parse_payload(request)
        for options in [{'include_usage': 'true'}, {'unknown': True}, True, None]:
            with self.assertRaises(worker.RequestError): worker.parse_payload(payload(stream_options=options))
        with self.assertRaises(worker.RequestError): worker.parse_payload(payload(stream='true'))
        class Tokenizer:
            def apply_chat_template(self, *args, **kwargs): return [42]*45000
        with self.assertRaises(worker.RequestError) as caught: worker.tokenize_full(Tokenizer(), [], 8192)
        self.assertFalse(caught.exception.evidence['input_truncated'])

    def test_worker_serve_emits_chunks_before_generate_returns_then_terminal(self):
        events = []
        def generate(state, request, on_chunk=None):
            on_chunk({'seq': 1, 'delta': '{}', 'at': 1})
            self.assertEqual(events[0]['event'], 'chunk'); self.assertEqual(len(events), 1)
            return response(1, '{}')['response'], {}
        with tempfile.TemporaryDirectory() as temporary, patch.object(worker, 'generate', generate):
            reader = io.StringIO(json.dumps({'id': 7, 'payload': payload()})+'\n')
            worker.serve({}, reader, lambda value: events.append(value), {'requests': []}, Path(temporary))
        self.assertEqual(events[0]['id'], 7); self.assertIn('response', events[1])

    def test_actual_generate_capture_callbacks_run_inside_model_generate(self):
        content = '{"message":"' + '안녕🙂'*30 + '"}'
        active = []; chunks = []; verified = []
        class Tensor:
            def __init__(self, value):
                self.value = value; self.ndim = 2 if value and isinstance(value[0], list) else 1
                self.shape = (len(value), len(value[0])) if self.ndim == 2 else (len(value),)
            def numel(self): return self.shape[0]*self.shape[1] if self.ndim == 2 else self.shape[0]
            def reshape(self, *_): return self
            def tolist(self): return self.value
            def __getitem__(self, key): return Tensor(self.value[key[0]][key[1]])
        class Model:
            generation_config = SimpleNamespace(eos_token_id=[0])
            def get_input_embeddings(self): return SimpleNamespace(weight=SimpleNamespace(device='cpu'))
            def generate(self, **options):
                active.append(True); streamer = options['streamer']; streamer.put(options['input_ids'])
                tokens = [ord(char) for char in content]+[0]
                for token in tokens: streamer.put(Tensor([token]))
                self.assert_early = bool(chunks)
                streamer.end(); active.pop(); return Tensor([[1,2,3]+tokens])
        grammar = SimpleNamespace(evidence={}, processor=None)
        def verify(*_):
            self.assertFalse(active); verified.append(True)
            grammar.evidence.update(full_output_replayed=True, eos_terminated=True, strict_json_parsed=True)
        grammar.verify = verify
        torch = SimpleNamespace(long='long', tensor=lambda value, **_: Tensor(value), ones=lambda *_, **__: None,
            manual_seed=lambda _: None, inference_mode=nullcontext,
            cuda=SimpleNamespace(synchronize=lambda _: None, manual_seed_all=lambda _: None,
                max_memory_allocated=lambda _: 0, max_memory_reserved=lambda _: 0))
        timer_source = ast.parse((RUNTIME/'code/speed_reference.py').read_text())
        timer_class = next(node for node in timer_source.body if isinstance(node, ast.ClassDef) and node.name == 'FirstTokenTimer')
        namespace = {'time': time, 'require': lambda value, message: self.assertTrue(value, message)}
        exec(compile(ast.Module(body=[timer_class], type_ignores=[]), '<qualified FirstTokenTimer>', 'exec'), namespace)
        model = Model(); state = {'model': model, 'tokenizer': SimpleNamespace(decode=lambda ids, **_: ''.join(chr(i) for i in ids if i)),
            'torch': torch, 'speed': SimpleNamespace(FirstTokenTimer=namespace['FirstTokenTimer'],
                require=lambda value, message: self.assertTrue(value, message), ADAPTER_SHA='synthetic'),
            'json_guard': SimpleNamespace(stop_ids=[0], prepare=lambda _: grammar)}
        def emit(value):
            self.assertTrue(active, 'No chunk may be synthesized after model.generate returns')
            self.assertFalse(verified); chunks.append(value)
        with patch.object(worker, 'tokenize_full', return_value=[1,2,3]), patch.object(worker, 'verify_unchanged'), \
                patch.object(worker, 'clear_request_cache', return_value=[]), patch.object(worker, 'selected_adapter', return_value=nullcontext()), \
                patch.dict(sys.modules, {'transformers': SimpleNamespace(StoppingCriteriaList=list)}):
            result, evidence = worker.generate(state, payload(), on_chunk=emit)
        self.assertTrue(model.assert_early); self.assertEqual(''.join(row['delta'] for row in chunks), content)
        self.assertEqual(result['choices'][0]['message']['content'], content)
        self.assertEqual(verified, [True]); self.assertTrue(evidence['streaming']['final_content_exact'])

    def test_queue_tails_before_terminal_and_rejects_incomplete_final_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); stream = root/'stream'; final = root/'response'; seen = []
            value = {'event': 'chunk', 'id': 'queue', 'seq': 1, 'delta': '{}', 'at': 1}
            stream.write_text(json.dumps(value)+'\n')
            def emit(item):
                seen.append(item)
                if item['event'] == 'chunk':
                    self.assertFalse(final.exists()); final.write_text(json.dumps(response('queue', '{}')))
            follow_response(final, stream, 'queue', lambda: {'status': 'running'}, emit, lambda: None, lambda _: None)
            self.assertEqual([item['event'] for item in seen], ['chunk', 'result'])
            stream.write_text(json.dumps(value)); seen.clear()
            with self.assertRaises(ValueError): follow_response(final, stream, 'queue', lambda: {}, seen.append, lambda: None, lambda _: None)
            self.assertEqual(seen, [])

    def test_queue_final_publication_race_drains_the_last_chunk_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); stream = root/'stream'; final = root/'response'; seen = []
            stream.write_text(json.dumps({'event': 'chunk', 'id': 'queue', 'seq': 1, 'delta': '{', 'at': 1})+'\n')
            class PublishedResponse:
                def exists(self):
                    if not final.exists():
                        with stream.open('a') as handle:
                            handle.write(json.dumps({'event': 'chunk', 'id': 'queue', 'seq': 2, 'delta': '}', 'at': 2})+'\n')
                        final.write_text(json.dumps(response('queue', '{}')))
                    return True
                def read_text(self): return final.read_text()
            follow_response(PublishedResponse(), stream, 'queue', lambda: {'status': 'running'}, seen.append, lambda: None, lambda _: None)
            self.assertEqual([item['event'] for item in seen], ['chunk', 'chunk', 'result'])
            self.assertEqual(''.join(item['delta'] for item in seen if item['event'] == 'chunk'), '{}')

    def fake_session(self, folder, chunk_change=None, final_change=None):
        chunk = {'event': 'chunk', 'id': 1, 'seq': 1, 'delta': '{}', 'at': 1, **(chunk_change or {})}
        final = response(1, '{}')
        if final_change: final_change(final)
        script = '''import json,sys,time,pathlib
print(json.dumps(READY),flush=True)
for line in sys.stdin:
 request=json.loads(line);print(json.dumps(CHUNK),flush=True)
 deadline=time.monotonic()+3
 while not pathlib.Path(GATE).exists() and time.monotonic()<deadline:time.sleep(.005)
 print(json.dumps(FINAL),flush=True)
print(json.dumps({'event':'closed','status':'passed','adapter_unchanged':True}),flush=True)
'''
        script = 'READY='+repr(ready())+'\nCHUNK='+repr(chunk)+'\nFINAL='+repr(final)+'\nGATE='+repr(str(folder/'gate'))+'\n'+script
        process = subprocess.Popen([sys.executable, '-B', '-u', '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        session = WorkerSession(process, folder/'bridge', REMOTE, request_timeout=3); session.wait_ready(3)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        self.addCleanup(process.stderr.close); self.addCleanup(process.stdout.close)
        return session, process

    def test_fake_worker_delivers_chunk_while_request_waits_for_verified_terminal(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); session, process = self.fake_session(folder)
            arrived = threading.Event(); result = []
            thread = threading.Thread(target=lambda: result.append(session.request({'stream': True}, on_chunk=lambda _: arrived.set())))
            thread.start(); self.assertTrue(arrived.wait(2)); self.assertEqual(result, [])
            (folder/'gate').touch(); thread.join(3); self.assertFalse(thread.is_alive()); self.assertIn('response', result[0])
            self.assertTrue(session.close(3)); process.wait(timeout=3)

    def test_fake_worker_wrong_id_or_sequence_fails_closed(self):
        for change in [{'id': 2}, {'seq': 2}]:
            with tempfile.TemporaryDirectory() as temporary:
                folder = Path(temporary); session, process = self.fake_session(folder, chunk_change=change); (folder/'gate').touch()
                with self.assertRaises(RuntimeError): session.request({'stream': True})
                session.close(3); process.wait(timeout=3); self.assertIsNotNone(session.failure)

    def test_bound_manifest_and_trusted_boundary_stay_exact(self):
        hashes = json.loads((RUNTIME/'SOURCE_SHA256.json').read_text()); self.assertEqual(len(hashes), 10)
        for name, digest in hashes.items(): self.assertEqual(hashlib.sha256((RUNTIME/'code'/name).read_bytes()).hexdigest(), digest)
        self.assertEqual((RUNTIME/'code/gpu31b_stream_protocol.py').read_bytes(), (ROOT/'ai/scripts/gpu31b_stream_protocol.py').read_bytes())
        self.assertEqual(hashes['boundary.py'], '8cd7cd20bd41a9161b553975aae717c22c78da6a32d50116e5691d92d165c6fc')
        for stream in [False, None]:
            value = ready(); value['capabilities']['stream'] = stream
            with self.assertRaises(ValueError): validate_ready(value, REMOTE)


if __name__ == '__main__': unittest.main()
