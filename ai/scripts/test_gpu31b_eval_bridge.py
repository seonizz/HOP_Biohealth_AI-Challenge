import io
import json
import os
from pathlib import Path
from email.message import Message
import queue
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import gpu31b_eval_bridge as bridge
import run_gpu31b_paired_evaluation as collector
from test_paired_role_evaluation import Response


def ready():
    return {'event': 'ready', 'model': bridge.MODEL, 'remote_root': bridge.REMOTE_ROOT,
            'base_model_path': '/home/slim/choieram/models/31b', 'adapter_path': bridge.REMOTE_ROOT + '/adapter',
            'base_manifest_sha256': 'b' * 64, 'adapter_file_sha256': 'a' * 64,
            'adapter_tensor_digest': 'c' * 64, 'tokenizer_manifest_sha256': 'd' * 64,
            'capabilities': {'max_context_tokens': 32768, 'max_output_tokens': 8192, 'stream': False, 'truncation': False}}


def payload(scale=0):
    return {'model': bridge.MODEL, 'stream': False, 'temperature': 0, 'seed': 3407, 'max_tokens': 32,
            'messages': [{'role': 'user', 'content': 'synthetic fixture'}], 'lora': [{'id': 0, 'scale': scale}]}


def dispatch(session, route, body=None):
    handler = object.__new__(bridge.handler_class(session)); handler.path = route
    handler.headers = Message(); handler.rfile = io.BytesIO()
    result = []
    handler.send_json = lambda status, value, *extra: result.append((status, value))
    if body is None:
        handler.do_GET()
    else:
        encoded = json.dumps(body).encode(); handler.headers['Content-Length'] = str(len(encoded)); handler.rfile = io.BytesIO(encoded)
        handler.do_POST()
    return result[0]


class FakeSession:
    def __init__(self):
        self.ready = ready(); self.failure = None; self.closed = None; self.requests = []; self.error = None

    def request(self, value):
        self.requests.append(value)
        return {'id': len(self.requests), 'error': self.error} if self.error else {'id': len(self.requests), 'response': {'choices': [{'message': {'content': '{}'}}]}}


class BridgeTests(unittest.TestCase):
    def test_r2_root_is_explicitly_allowed_and_other_root_is_not(self):
        value = ready(); value['remote_root'] = bridge.REMOTE_ROOT_R2
        bridge.validate_ready(value, bridge.REMOTE_ROOT_R2)
        with self.assertRaisesRegex(ValueError, 'run root'): bridge.validate_ready(value, bridge.REMOTE_ROOT)
        value['remote_root'] = '/home/slim/choieram/model_Training/unrequested'
        with self.assertRaisesRegex(ValueError, 'run root'): bridge.validate_ready(value)

    def test_ready_remote_identity_has_manifest_kind_without_local_files(self):
        normalized = bridge.validate_ready(ready())
        self.assertEqual(normalized['base_model_digest']['kind'], 'remote_directory_manifest_sha256')
        self.assertNotIn('base_model_sha256', normalized)
        bad = ready(); bad['base_model_path'] = '/home/another/model'
        with self.assertRaisesRegex(ValueError, 'boundary'): bridge.validate_ready(bad)
        bad = ready(); bad['base_manifest_sha256'] = None
        with self.assertRaisesRegex(ValueError, 'digest'): bridge.validate_ready(bad)

    def test_health_props_and_adapter_are_actual_ready_metadata(self):
        session = FakeSession()
        status, props = dispatch(session, '/props')
        self.assertEqual(status, 200); self.assertEqual(props['worker_ready'], ready())
        self.assertEqual(props['worker_ready_sha256'], bridge.digest(ready()))
        status, adapters = dispatch(session, '/lora-adapters')
        self.assertIsNone(adapters[0]['scale'])
        self.assertEqual(dispatch(session, '/unexpected')[0], 404)
        session.failure = 'synthetic failure'; self.assertEqual(dispatch(session, '/health')[0], 503)

    def test_strict_post_scale_and_grammar_and_error_body(self):
        session = FakeSession()
        for scale in (0, 1): self.assertEqual(dispatch(session, '/v1/chat/completions', payload(scale))[0], 200)
        self.assertEqual([v['lora'][0]['scale'] for v in session.requests], [0, 1])
        forbidden = payload(); forbidden['response_format'] = {'type': 'json_schema'}
        self.assertEqual(dispatch(session, '/v1/chat/completions', forbidden)[0], 400)
        self.assertEqual(dispatch(session, '/v1/other', payload())[0], 404)
        self.assertEqual(len(session.requests), 2)
        session.error = {'type': 'server_error', 'code': 'synthetic', 'message': 'fixture error'}
        status, value = dispatch(session, '/v1/chat/completions', payload())
        self.assertEqual(status, 500); self.assertEqual(value, {'error': session.error})

    def test_jsonl_ready_response_closed_and_invalid_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            class Process:
                stdin = io.StringIO()
                stdout = io.StringIO('\n'.join(json.dumps(v) for v in [ready(), {'event': 'closed', 'status': 'passed', 'adapter_unchanged': True}]) + '\n')
            session = bridge.WorkerSession(Process(), Path(tmp) / 'good')
            session.reader.join(1); self.assertEqual(session.wait_ready(1), ready()); self.assertIsNone(session.failure)
            self.assertTrue(session.close(.1))
            class Bad:
                stdin = io.StringIO(); stdout = io.StringIO('not JSON\n')
            bad = bridge.WorkerSession(Bad(), Path(tmp) / 'bad'); bad.reader.join(1)
            with self.assertRaises(ValueError): bad.wait_ready(.1)

    def test_worker_request_ids_are_serial_and_mismatch_blocks_more_dispatch(self):
        session = object.__new__(bridge.WorkerSession)
        with tempfile.TemporaryDirectory() as tmp:
            session.output = Path(tmp); session.ready = ready(); session.closed = None; session.failure = None
            session.lock = threading.Lock(); session.sequence = 0; session.request_timeout = 1; session.responses = queue.Queue()
            session.state_lock = threading.Lock(); session.inflight_id = None; session.inflight_started_at = None
            class Input:
                def write(self, value): session.responses.put({'id': json.loads(value)['id'], 'response': {}})
                def flush(self): pass
            class Process: stdin = Input()
            session.process = Process()
            results = []
            threads = [threading.Thread(target=lambda: results.append(session.request(payload()))) for _ in range(3)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertEqual(sorted(v['id'] for v in results), [1, 2, 3])

    def test_worker_wire_preserves_nested_schema_property_order_and_hash_contract(self):
        session = object.__new__(bridge.WorkerSession)
        def schema(properties):
            return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}
        skip = schema({'question_id': {'const': 'q3_03'}, 'reason': {'const': 'already_covered'},
                       'evidence': {'type': 'array', 'items': schema({'subject': {'const': 'patient'},
                          'question_id': {'const': 'q3_04'}, 'quote': {'const': '합성 원문'}})},
                       'explanation': {'type': 'string'}})
        original = schema({'state': schema({'name_index': {'type': 'null'}}),
                           'questions': schema({'skip': {'type': 'array', 'items': {'anyOf': [skip]}}})})
        body = payload(); body['response_format'] = {'type': 'json_schema', 'json_schema': {'schema': original}}
        def orders(value, path=''):
            result = []
            if isinstance(value, dict):
                if 'properties' in value:
                    result.append((path, list(value['properties']), value['required']))
                for key, child in value.items(): result.extend(orders(child, path + '.' + key))
            elif isinstance(value, list):
                for index, child in enumerate(value): result.extend(orders(child, path + '[' + str(index) + ']'))
            return result
        with tempfile.TemporaryDirectory() as tmp:
            session.output = Path(tmp); session.ready = ready(); session.closed = None; session.failure = None
            session.lock = threading.Lock(); session.sequence = 0; session.request_timeout = 1; session.responses = queue.Queue()
            session.state_lock = threading.Lock(); session.inflight_id = None; session.inflight_started_at = None
            captured = []
            class Input:
                def write(self, line):
                    captured.append(line); session.responses.put({'id': json.loads(line)['id'], 'response': {}})
                def flush(self): pass
            class Process: stdin = Input()
            session.process = Process(); session.request(body)
            received = json.loads(captured[0])['payload']['response_format']['json_schema']['schema']
            self.assertEqual(orders(received), orders(original))
            self.assertEqual(received, original)
            self.assertEqual((Path(tmp) / 'worker-stdin.jsonl').read_text(), captured[0])
            canonical = json.loads(bridge.canonical(original))
            self.assertNotEqual(orders(canonical), orders(original))
            self.assertEqual(bridge.digest(canonical), bridge.digest(original))
        with self.assertRaises(ValueError): bridge.wire_json({'number': float('nan')})

    def test_first_eof_root_cause_keeps_inflight_id_and_survives_generic_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            read_fd, write_fd = os.pipe(); output = os.fdopen(write_fd, 'w', buffering=1)
            output.write(json.dumps(ready()) + '\n'); output.flush()
            class Input:
                def write(self, _): output.close()
                def flush(self): pass
            class Process: stdin = Input(); stdout = os.fdopen(read_fd, 'r')
            session = bridge.WorkerSession(Process(), tmp, request_timeout=1); session.wait_ready(1)
            with self.assertRaisesRegex(RuntimeError, 'stdout EOF'): session.request(payload())
            before = (Path(tmp) / 'bridge-fatal.json').read_bytes()
            session._fail('generic response mismatch', 'worker_response_id_mismatch')
            self.assertEqual(before, (Path(tmp) / 'bridge-fatal.json').read_bytes())
            self.assertEqual(session.fatal_cause['inflight_id'], 1); self.assertTrue(session.fatal_event.is_set())
            session.reader.join(1); Process.stdout.close()

    def test_late_reply_cannot_replace_first_timeout_cause(self):
        with tempfile.TemporaryDirectory() as tmp:
            read_fd, write_fd = os.pipe(); output = os.fdopen(write_fd, 'w', buffering=1)
            output.write(json.dumps(ready()) + '\n'); output.flush()
            class Input:
                def write(self, _): pass
                def flush(self): pass
            class Process: stdin = Input(); stdout = os.fdopen(read_fd, 'r')
            session = bridge.WorkerSession(Process(), tmp, request_timeout=.01); session.wait_ready(1)
            with self.assertRaises(TimeoutError): session.request(payload())
            output.write(json.dumps({'id': 1, 'response': {}}) + '\n'); output.flush()
            deadline = time.monotonic() + 1
            while not (Path(tmp) / 'late-worker-replies.jsonl').exists() and time.monotonic() < deadline: time.sleep(.005)
            self.assertTrue((Path(tmp) / 'late-worker-replies.jsonl').exists())
            self.assertEqual(session.fatal_cause['code'], 'worker_response_timeout')
            output.close(); session.reader.join(1); Process.stdout.close()

    def test_http_client_broken_pipe_does_not_poison_healthy_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = FakeSession(); session.output = Path(tmp)
            handler = object.__new__(bridge.handler_class(session))
            handler.send_response = lambda *_: None; handler.send_header = lambda *_: None; handler.end_headers = lambda: None
            class Broken:
                def write(self, _): raise BrokenPipeError('synthetic client disconnect')
            handler.wfile = Broken(); handler.send_json(200, {'ok': True})
            self.assertIsNone(session.failure); self.assertIsNone(session.closed)
            self.assertTrue((Path(tmp) / 'http-client-disconnects.jsonl').exists())

    def test_remote_collector_identity_pinned_without_fake_gguf(self):
        session = FakeSession(); props = dispatch(session, '/props')[1]; adapters = dispatch(session, '/lora-adapters')[1]
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'worker-ready.json'; file.write_text(json.dumps(ready()))
            with patch.object(collector, 'fetch_json', side_effect=[props, adapters]):
                value = collector.identity('http://127.0.0.1:11440', file, 1)
            self.assertEqual(value['verified_remote_identity']['base_model_digest']['value'], 'b' * 64)
            props['worker_ready_sha256'] = '0' * 64
            with patch.object(collector, 'fetch_json', side_effect=[props, adapters]):
                with self.assertRaisesRegex(ValueError, 'pinned'): collector.identity('http://127.0.0.1:11440', file, 1)

    def test_remote_collector_fixed_denominator_first_failure_and_gold_separation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); suite_root = root / 'panel'; suite_root.mkdir()
            request = {'request_id': 'opaque-request', 'task': 'controlled_s1', 'format': 'json',
                       'messages': [{'role': 'user', 'content': 'synthetic inference input'}]}
            case = {'case_id': 'case', 'requests': [request]}
            reference = {'case_id': 'case', 'input_sha256': collector.digest(case), 'secret_gold': 'DO NOT SEND THIS GOLD'}
            suite = {'schema': 'malssi-role-evaluation-suite-v1', 'split': 'development', 'model_role': 'chat_12b',
                     'cases': [{'case_id': 'case', 'source_family_id': 'root', 'input_sha256': collector.digest(case),
                                'reference_sha256': collector.digest(reference)}]}
            for name, value in [('SUITE.json', suite), ('INPUTS.jsonl', case), ('REFERENCES.jsonl', reference)]:
                (suite_root / name).write_text(json.dumps(value) + '\n')
            pinned = root / 'ready.json'; pinned.write_text(json.dumps(ready()))
            session = FakeSession(); posts = []
            def http(req, timeout=None):
                if isinstance(req, str): return Response(dispatch(session, '/health' if req.endswith('/health') else '/props' if req.endswith('/props') else '/lora-adapters')[1])
                posts.append(json.loads(req.data))
                response = Response({'error': 'synthetic model timeout'}, 504) if len(posts) == 1 else Response({'choices': [{'message': {'content': '{}'}, 'finish_reason': 'stop'}]})
                response.headers.update({'X-Evaluation-Worker-Response-ID': str(len(posts)), 'X-Evaluation-Worker-Reply-SHA256': 'e' * 64})
                return response
            with patch.object(collector.urllib.request, 'urlopen', side_effect=http):
                result = collector.collect(suite_root, root / 'run', 'http://127.0.0.1:11440', pinned)
            self.assertEqual(len(posts), 2); self.assertEqual([p['lora'][0]['scale'] for p in posts], [0, 1])
            self.assertNotIn(reference['secret_gold'], json.dumps(posts))
            self.assertEqual(result['arms']['baseline'], {'assigned_count': 1, 'received_count': 0, 'failed_count': 1, 'not_run_count': 0})
            self.assertEqual(result['arms']['trained']['received_count'], 1)
            metadata = json.loads((root / 'run/metadata.json').read_text())
            self.assertNotIn('base_model_sha256', metadata)
            self.assertEqual(metadata['base_model_digest']['kind'], 'remote_directory_manifest_sha256')
            self.assertTrue((root / 'run/http/000001/response.bin').is_file())

    def test_unlinked_first_503_aborts_480_ledger_after_one_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); panel = root / 'panel'; panel.mkdir()
            case = {'case_id': 'case', 'requests': [{'request_id': f'opaque-{i}', 'task': 'controlled', 'format': 'json',
                'messages': [{'role': 'user', 'content': 'synthetic'}]} for i in range(240)]}
            reference = {'case_id': 'case', 'input_sha256': collector.digest(case)}
            suite = {'schema': 'malssi-role-evaluation-suite-v1', 'split': 'development', 'model_role': 'chat_12b',
                'cases': [{'case_id': 'case', 'source_family_id': 'group', 'input_sha256': collector.digest(case), 'reference_sha256': collector.digest(reference)}]}
            for name, value in [('SUITE.json', suite), ('INPUTS.jsonl', case), ('REFERENCES.jsonl', reference)]: (panel / name).write_text(json.dumps(value) + '\n')
            pinned = root / 'ready.json'; pinned.write_text(json.dumps(ready())); session = FakeSession(); posts = []
            def http(req, timeout=None):
                if isinstance(req, str): return Response(dispatch(session, '/health' if req.endswith('/health') else '/props' if req.endswith('/props') else '/lora-adapters')[1])
                posts.append(req); return Response({'error': {'code': 'worker_transport_failure'}}, 503)
            with patch.object(collector.urllib.request, 'urlopen', side_effect=http):
                with self.assertRaises(collector.InfrastructureInterrupted): collector.collect(panel, root / 'run', 'http://127.0.0.1:11440', pinned)
            result = json.loads((root / 'run/summary.json').read_text())
            self.assertEqual(result['status'], 'infrastructure_interrupted'); self.assertEqual(len(posts), 1)
            self.assertEqual(sum(v['not_run_count'] for v in result['arms'].values()), 479)
            self.assertEqual(sum(v['failed_count'] for v in result['arms'].values()), 1)

    def test_remote_full_flow_prompt_profile_and_twelve_failure_denominators(self):
        session = FakeSession()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); ready_file = root / 'ready.json'; ready_file.write_text(json.dumps(ready()))
            config = {'root': str(root / 'panel'), 'output': str(root / 'run'), 'ready': str(ready_file),
                      'props': dispatch(session, '/props')[1], 'adapters': dispatch(session, '/lora-adapters')[1]}
            source = '''
import fs from 'node:fs';
import {prepare,run,PROFILE,serverIdentity} from './ai/scripts/run_gpu31b_full_flow.mjs';
const config=JSON.parse(process.argv[1]);
if(PROFILE.agentFormat!=='prompt')throw new Error('Wrong transport');
prepare(config.root,{remoteRoot:config.props.worker_ready.remote_root});
const fetchImpl=async url=>new Response(JSON.stringify(url.endsWith('/props')?config.props:config.adapters));
class Gateway{
 constructor(options){this.options=options;}
 async agentComplete(){throw new Error('synthetic pre-model failure');}
 async respond(){return this.agentComplete('state_observations','prompt',{synthetic:true},{type:'object'});}
}
const result=await run({root:config.root,output:config.output,workerReady:config.ready,fetchImpl,Gateway});
if(result.assigned_count!==12||result.failed_count!==12||result.not_run_count!==0||result.M02.by_arm.baseline.denominator!==6)throw new Error('Bad fixed denominators');
const metadata=JSON.parse(fs.readFileSync(config.output+'/metadata.json'));
if(metadata.base_sha256!==undefined||metadata.remote_model_identity.base_model_digest.kind!=='remote_directory_manifest_sha256')throw new Error('Fabricated model identity');
config.props.worker_ready.model='tampered';
let rejected=false;try{await serverIdentity('http://127.0.0.1:11440/v1',config.ready,fetchImpl);}catch{rejected=true;}
if(!rejected)throw new Error('Ready mismatch accepted');
let unavailable=false;
try{await serverIdentity('http://127.0.0.1:11440/v1',config.ready,async()=>new Response(JSON.stringify({error:{code:'worker_unavailable'}}),{status:503}));}
catch(error){unavailable=error.code==='REMOTE_WORKER_UNAVAILABLE'&&error.http_status===503&&error.message==='remote_worker_unavailable';}
if(!unavailable)throw new Error('HTTP503 was mislabeled identity mismatch');
'''
            repository = Path(__file__).resolve().parents[2]
            result = subprocess.run(['node', '--input-type=module', '-e', source, json.dumps(config)], cwd=repository,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_node_transport_stops_after_one_unlinked_503(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = '''
import {createTransport} from './ai/scripts/run_gpu31b_full_flow.mjs';
let posts=0,health=0,fatal=0;
const transport=createTransport({output:process.argv[1],endpoint:'http://127.0.0.1:11442/v1',arm:'baseline',workerReadySha256:'expected',onFatal:()=>fatal++,
 fetchImpl:async url=>{
  if(url.endsWith('/health')){health++;return new Response(JSON.stringify({status:'ok',worker_ready_sha256:'expected'}));}
  posts++;return new Response(JSON.stringify({error:{code:'worker_transport_failure'}}),{status:503});
 }});
const body=JSON.stringify({model:'fixture',messages:[{role:'user',content:JSON.stringify({stage:'state',data:{}})}]});
for(let i=0;i<2;i++){try{await transport.generatorFetch('http://127.0.0.1:11442/v1/chat/completions',{method:'POST',body});}catch(error){if(error.code!=='EVALUATION_INFRASTRUCTURE_INTERRUPTED')throw error;}}
if(posts!==1||health!==1||fatal!==1||!transport.fatalCause)throw new Error('Cascading infrastructure attempts continued');
'''
            repository = Path(__file__).resolve().parents[2]
            result = subprocess.run(['node', '--input-type=module', '-e', source, tmp], cwd=repository,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__': unittest.main()
