from copy import deepcopy
import http.client
import json
import socket
import threading
import unittest

from replica_pool import make_replica_bridge, ReplicaPool
from server import make_server, validate_config
from test_api import CONFIG, KEY
from test_inference_queue import wait_until
from test_replica_pool import Worker, IDENTITY, GPU_IDS


def config(waiting=1):
    return {**CONFIG, **{key:IDENTITY[key] for key in ('model_id','checkpoint_sha256','checkpoint_step','max_input_tokens','max_output_tokens','max_context_tokens')},
            'port':18080,'default_output_tokens':8192,'require_backend_status':True,
            'inference_parallel_slots':2,'inference_queue_max_requests':waiting}


class ParallelHTTPTests(unittest.TestCase):
    def setUp(self):
        self.workers=[]
        def worker_factory(**options):
            worker=Worker(expected=options['expected']);self.workers.append(worker);return worker
        def server_factory(api,backend,key,timing_log):
            return make_server({**api,'port':0},backend,key,timing_log)
        self.server,self.pool=make_replica_bridge({'api':config(), 'workers':[
            {'command':['explicit-worker',str(index)],'expected':{**IDENTITY,'gpu_uuid':gpu}}
            for index,gpu in enumerate(GPU_IDS)]},KEY,worker_factory=worker_factory,server_factory=server_factory)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.server.handle_error=lambda *args:None

    def tearDown(self):
        for worker in self.workers:worker.release.set()
        self.server.shutdown();self.server.server_close();self.thread.join(2);self.pool.close()

    def request(self,text='synthetic',method='POST',key=KEY):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        body=json.dumps({'messages':[{'role':'user','content':text}],'max_tokens':8192,'temperature':.2})
        connection.request(method,'/healthz' if method=='GET' else '/v1/chat/completions',body=body if method=='POST' else None,
            headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        response=connection.getresponse();result=(response.status,json.loads(response.read()));connection.close();return result

    def start_request(self,text,results):
        thread=threading.Thread(target=lambda:results.append((text,self.request(text)[0])))
        thread.start();return thread

    def test_health_does_not_start_or_generate_and_auth_is_required(self):
        for _ in range(3):self.assertEqual(self.request(method='GET')[0],503)
        self.assertEqual([worker.starts for worker in self.workers],[0,0])
        self.assertEqual(self.request(key='wrong')[0],401)
        self.pool.start();self.assertEqual(self.request(method='GET')[0],200)
        self.assertEqual([worker.calls for worker in self.workers],[0,0])

    def test_actual_http_overlap_two_workers_third_queues_and_fourth_rejected(self):
        self.pool.start()
        for worker in self.workers:worker.release.clear()
        results=[];first=self.start_request('writer',results)
        self.assertTrue(self.workers[0].entered.wait(1))
        # A free physical replica remains ready while the first is occupied.
        health=self.request(method='GET');self.assertEqual(health[1]['status'],'ready')
        self.assertEqual(health[1]['inference_queue']['active_count'],1)
        second=self.start_request('review',results)
        self.assertTrue(self.workers[1].entered.wait(1))
        self.assertTrue(first.is_alive() and second.is_alive())
        self.assertEqual(self.server.inference_queue.snapshot()['active_count'],2)
        third=self.start_request('repair',results)
        wait_until(lambda:self.server.inference_queue.snapshot()['queued_requests']==1)
        self.assertEqual(self.request('overflow')[0],429)
        self.assertEqual([worker.calls for worker in self.workers],[1,1])
        self.workers[0].release.set()
        for thread in [first,third]:thread.join(2);self.assertFalse(thread.is_alive())
        self.assertTrue(second.is_alive());self.workers[1].release.set();second.join(2)
        self.assertCountEqual(results,[('writer',200),('review',200),('repair',200)])
        self.assertEqual([worker.maximum for worker in self.workers],[1,1])
        self.assertEqual(self.server.inference_queue.snapshot()['active_count'],0)
        dispatches=self.pool.snapshot()['dispatches']
        self.assertEqual([event['replica'] for event in dispatches if event['event']=='dispatch'][:2],[0,1])

    def test_disconnect_on_one_replica_does_not_cancel_other_and_drain_blocks_reuse(self):
        self.pool.start()
        for worker in self.workers:worker.release.clear()
        self.workers[0].uncertain=True
        connection=socket.create_connection(('127.0.0.1',self.server.server_port),timeout=2)
        body=json.dumps({'messages':[{'role':'user','content':'disconnected'}]}).encode()
        connection.sendall(('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+KEY+
            '\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body))+'\r\n\r\n').encode()+body)
        self.assertTrue(self.workers[0].entered.wait(1))
        results=[];other=self.start_request('healthy review',results)
        self.assertTrue(self.workers[1].entered.wait(1));connection.close()
        wait_until(lambda:self.workers[0].cancels==1)
        self.assertTrue(other.is_alive());self.assertEqual(self.workers[1].cancels,0)
        wait_until(lambda:self.server.inference_queue.snapshot()['active_count']==1)
        self.assertEqual(self.request(method='GET')[0],503)
        self.assertEqual(self.request('no uncertain reuse')[0],503)
        self.workers[1].release.set();other.join(2)
        self.assertEqual(results,[('healthy review',200)])
        self.assertEqual([worker.calls for worker in self.workers],[1,1])


class ParallelConfigTests(unittest.TestCase):
    def test_parallel_slot_requires_explicit_backend_capacity_and_status(self):
        class Backend:
            def inference_status(self):return {'status':'ready'}
        for capacity in [None,True,0,1]:
            backend=Backend();backend.parallel_capacity=capacity
            with self.subTest(capacity=capacity),self.assertRaisesRegex(ValueError,'parallel_capacity'):
                make_server({**config(),'port':0},backend,KEY)
        backend=Backend();backend.parallel_capacity=2
        for value in [False,None,1,'true']:
            with self.subTest(status=value),self.assertRaises(ValueError):
                make_server({**config(),'port':0,'require_backend_status':value},backend,KEY)
        for value in [0,3,True,'2']:
            with self.subTest(slots=value),self.assertRaises(ValueError):validate_config({**config(),'inference_parallel_slots':value})

    def test_bridge_rejects_api_mismatch_and_invalid_auth_before_bind_or_start(self):
        definition={'api':config(),'workers':[{'command':['worker',str(index)],'expected':{**IDENTITY,'gpu_uuid':gpu}} for index,gpu in enumerate(GPU_IDS)]}
        def no_bind(*args,**kwargs):raise AssertionError('Must not bind')
        def worker_factory(**options):return Worker(expected=options['expected'])
        for key in ['','short','x '*32]:
            with self.assertRaises(ValueError):make_replica_bridge(definition,key,worker_factory=worker_factory,server_factory=no_bind)
        bad=deepcopy(definition);bad['api']['max_output_tokens']=8000;bad['api']['default_output_tokens']=8000
        with self.assertRaises(ValueError):make_replica_bridge(bad,KEY,worker_factory=worker_factory,server_factory=no_bind)


if __name__=='__main__':unittest.main()
