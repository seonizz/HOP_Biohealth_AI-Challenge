from copy import deepcopy
import threading
import time
import unittest

from backend import BackendUnavailableError, RequestError
from inference_queue import InferenceQueue, QueueFull, RequestCancelled
from remote_worker import _disconnected
from replica_pool import ReplicaPool
from test_inference_queue import wait_until

GPU_IDS = ('GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c', 'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642')
IDENTITY = dict(model_id='test-model', checkpoint_sha256='a'*64, adapter_sha256='b'*64,
                checkpoint_path='/home/slim/choieram/test/checkpoint', checkpoint_step=4723,
                max_input_tokens=32767, max_output_tokens=8192, max_context_tokens=32768,
                gpu_only=True, terminal_reply_after_idle=True, quantization='nf4')


class Worker:
    def __init__(self, index=0, *, expected=None, command=None, process_factory=None):
        self.expected = deepcopy(expected or {**IDENTITY, 'gpu_uuid':GPU_IDS[index]})
        self.context = threading.local()
        self.status = 'unavailable'
        self.starts = self.closes = self.calls = self.cancels = self.active = self.maximum = 0
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.context_after = []
        self.fail_start = False
        self.uncertain = False

    def start(self):
        self.starts += 1
        if self.fail_start:
            raise BackendUnavailableError('test startup failure')
        self.status = 'ready'

    def inference_status(self):
        return {'status':self.status}

    def generate(self, messages, max_tokens, temperature, top_p):
        if self.status != 'ready':
            raise AssertionError('Worker was overbooked')
        self.calls += 1
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        self.status = 'busy'
        self.entered.set()
        deadline = time.monotonic() + 5
        try:
            while not self.release.wait(.005):
                event = getattr(self.context, 'cancel_event', None)
                if event is not None and event.is_set() or _disconnected(getattr(self.context, 'connection', None)):
                    self.cancels += 1
                    self.status = 'draining' if self.uncertain else 'ready'
                    raise RequestError('Cancelled request')
                if time.monotonic() > deadline:
                    raise RuntimeError('Test worker not released')
            self.status = 'ready'
            return {'text':'synthetic', 'finish_reason':'stop', 'prompt_tokens':5, 'completion_tokens':1}
        finally:
            self.active -= 1

    def close(self):
        self.closes += 1
        self.status = 'unavailable'
        self.release.set()


class PoolTests(unittest.TestCase):
    def test_serial_requests_use_both_resident_replicas(self):
        workers = [Worker(0), Worker(1)]
        pool = ReplicaPool(workers).start()
        for _ in range(4):
            pool.generate([], 32, 0, 1)
        self.assertEqual([worker.calls for worker in workers], [2, 2])
        self.assertEqual([row['replica'] for row in pool.snapshot()['dispatches'] if row['event'] == 'dispatch'], [0, 1, 0, 1])
        pool.close()

    def test_dormant_health_never_starts_and_metadata_mismatch_is_rejected(self):
        workers = [Worker(0), Worker(1)]
        pool = ReplicaPool(workers)
        for _ in range(5):
            self.assertEqual(pool.inference_status()['status'], 'unavailable')
        self.assertEqual([worker.starts for worker in workers], [0,0])
        for key,value in [('gpu_uuid',GPU_IDS[0]), ('adapter_sha256','c'*64), ('max_input_tokens',32000),
                          ('quantization','fp16'), ('model_id','wrong'), ('gpu_only',False)]:
            bad = [Worker(0), Worker(1)]
            bad[1].expected[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                ReplicaPool(bad)

    def test_start_failure_closes_both_owned_workers(self):
        workers = [Worker(0), Worker(1)]
        workers[1].fail_start = True
        pool = ReplicaPool(workers)
        with self.assertRaises(BackendUnavailableError):
            pool.start()
        self.assertEqual([worker.closes for worker in workers], [1,1])
        self.assertEqual(pool.inference_status()['status'], 'unavailable')

    def test_two_exclusive_reservations_no_third_and_context_is_cleared(self):
        workers = [Worker(0), Worker(1)]
        for worker in workers: worker.release.clear()
        pool = ReplicaPool(workers).start()
        outcomes=[]
        def generate():
            pool.context.cancel_event = threading.Event()
            pool.generate([{'role':'user','content':'private content'}], 8192, .2, 1)
            outcomes.append([hasattr(worker.context,'cancel_event') for worker in workers])
        threads=[]
        for worker in workers:
            thread=threading.Thread(target=generate);thread.start();threads.append(thread)
            self.assertTrue(worker.entered.wait(1))
        self.assertEqual(pool.inference_status()['status'], 'busy')
        with self.assertRaises(BackendUnavailableError):
            pool.generate([],8192,.2,1)
        for worker in workers: worker.release.set()
        for thread in threads: thread.join(2);self.assertFalse(thread.is_alive())
        self.assertEqual(outcomes, [[False,False],[False,False]])
        self.assertEqual([worker.maximum for worker in workers],[1,1])
        self.assertEqual(pool.inference_status()['status'], 'ready')
        self.assertNotIn('private content',str(pool.snapshot()))
        pool.close()

    def test_one_cancel_event_does_not_cancel_other_replica(self):
        workers=[Worker(0),Worker(1)]
        workers[0].uncertain=True
        for worker in workers:worker.release.clear()
        pool=ReplicaPool(workers).start();cancel=threading.Event();outcomes=[]
        def run(index):
            pool.context.cancel_event=cancel if index==0 else threading.Event()
            try:pool.generate([],8192,.2,1);outcomes.append((index,'ok'))
            except RequestError:outcomes.append((index,'cancelled'))
        first=threading.Thread(target=run,args=(0,));first.start();self.assertTrue(workers[0].entered.wait(1))
        second=threading.Thread(target=run,args=(1,));second.start();self.assertTrue(workers[1].entered.wait(1))
        cancel.set();first.join(2)
        self.assertEqual(pool.inference_status()['status'],'draining')
        self.assertEqual(workers[1].cancels,0);self.assertTrue(second.is_alive())
        with self.assertRaises(BackendUnavailableError):pool.generate([],8192,.2,1)
        workers[1].release.set();second.join(2)
        self.assertCountEqual(outcomes,[(0,'cancelled'),(1,'ok')]);pool.close()


class ParallelQueueTests(unittest.TestCase):
    def test_two_slots_and_no_third_with_zero_waiting_budget(self):
        queue=InferenceQueue(max_active=2)
        first=queue.acquire(100);second=queue.acquire(100)
        self.assertEqual(queue.snapshot()['active_count'],2)
        self.assertTrue(queue.snapshot()['active']);self.assertEqual(queue.snapshot()['capacity'],2)
        with self.assertRaises(QueueFull):queue.acquire(1)
        queue.release(first);queue.release(second)
        for invalid in [0,3,True,'2',None]:
            with self.assertRaises(ValueError):InferenceQueue(max_active=invalid)

    def test_ready_check_reserved_ticket_does_not_consume_second_idle_slot(self):
        queue=InferenceQueue(max_active=2);gate=threading.Event();entered=threading.Event();permits=[]
        def ready():entered.set();gate.wait(2);return True
        first=threading.Thread(target=lambda:permits.append(queue.acquire(100,ready=ready)))
        first.start();self.assertTrue(entered.wait(1))
        second=threading.Thread(target=lambda:permits.append(queue.acquire(100)))
        second.start();wait_until(lambda:queue.snapshot()['queued_requests']==2)
        with self.assertRaises(QueueFull):queue.acquire(1)
        gate.set();first.join(2);second.join(2)
        self.assertEqual(len(permits),2)
        for permit in permits:queue.release(permit)

    def test_parallel_fifo_waiter_cancellation_preserves_running_permits(self):
        queue=InferenceQueue(2,20,max_active=2)
        permits=[queue.acquire(1),queue.acquire(1)];cancel=threading.Event();outcomes=[]
        def wait():
            try:queue.acquire(10,cancelled=cancel.is_set)
            except RequestCancelled:outcomes.append('cancelled')
        thread=threading.Thread(target=wait);thread.start();wait_until(lambda:queue.snapshot()['queued_requests']==1)
        cancel.set();thread.join(2);self.assertEqual(outcomes,['cancelled'])
        self.assertEqual(queue.snapshot()['active_count'],2)
        for permit in permits:queue.release(permit)


if __name__=='__main__':unittest.main()
