import unittest
import math
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from service import validate_body,MODEL,client_disconnected,output_budget,constrained_scores,ContextBudgetError,reserve_output_budget,error_response
from json_guard import JsonGuardError
class OutputBudget(unittest.TestCase):
 def test_default_reserves_full_output_context(self):
  with self.assertRaises(ContextBudgetError):output_budget({},25119)
  self.assertEqual(output_budget({},22000),8192)
  self.assertEqual(output_budget({},24576),8192)
  with self.assertRaises(ContextBudgetError):output_budget({},24577)
 def test_explicit_caps_are_respected(self):
  self.assertEqual(output_budget({'max_tokens':1024},25119),1024)
  self.assertEqual(output_budget({'max_tokens':1024},31744),1024)
  with self.assertRaises(ContextBudgetError):output_budget({'max_tokens':1024},31745)
  with self.assertRaises(ContextBudgetError):output_budget({'max_tokens':8192},25119)
 def test_never_truncates_input(self):
  for tokens in [32768,40000]:
   with self.assertRaises(ContextBudgetError):output_budget({},tokens)
 def test_capacity_failure_has_machine_readable_code_and_saved_input_metrics(self):
  for body,tokens in [({},25119),({'max_tokens':1024},32000),({},40000)]:
   with self.subTest(body=body,tokens=tokens),tempfile.TemporaryDirectory() as directory:
    path=Path(directory)/'input_metrics.json'
    with self.assertRaises(ContextBudgetError) as caught:reserve_output_budget(body,tokens,path)
    metrics=json.loads(path.read_text());status,response=error_response(caught.exception)
    self.assertEqual(status,400)
    self.assertEqual(response['error']['code'],'context_length_exceeded')
    self.assertEqual(response['error']['type'],'invalid_request_error')
    self.assertIn('no text was truncated',response['error']['message'])
    self.assertEqual(metrics,dict(prompt_tokens=tokens,requested_max_tokens=body.get('max_tokens'),max_tokens=body.get('max_tokens',8192),context_limit=32768,prefill_chunk=512,budget_accepted=False))
 def test_success_records_full_reservation_without_changing_request(self):
  body={'max_tokens':1024};original=dict(body)
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'input_metrics.json'
   self.assertEqual(reserve_output_budget(body,31744,path),1024)
   metrics=json.loads(path.read_text());self.assertTrue(metrics['budget_accepted'])
   self.assertEqual(metrics['max_tokens'],1024);self.assertEqual(body,original)
 def test_incomplete_grammar_and_other_errors_are_not_capacity_errors(self):
  for error in [JsonGuardError('constrained_output_incomplete','Missing EOS'),ValueError('Invalid input'),TimeoutError('Cancelled'),RuntimeError('Decoder failed')]:
   status,response=error_response(error)
   self.assertEqual(response['error']['type'],type(error).__name__)
   self.assertNotIn('code',response['error'])
   self.assertEqual(status,504 if isinstance(error,TimeoutError) else 400 if isinstance(error,ValueError) else 500)
class Contract(unittest.TestCase):
 def body(self,**extra):
  body=dict(model=MODEL,messages=[dict(role='user',content='합성 시험')],temperature=0,
   response_format={'type':'json_schema','json_schema':{'name':'app_output','strict':True,'schema':{'type':'object','properties':{},'required':[],'additionalProperties':False}}})
  return {**body,**extra}
 def test_greedy(self):self.assertEqual(validate_body(self.body())[1],8192)
 def test_no_sampling_silently_ignored(self):
  b=self.body();b['temperature']=.2
  with self.assertRaisesRegex(ValueError,'temperature'):validate_body(b)
 def test_no_false_grammar(self):
  for response_format in [None,{'type':'json_object'},{'type':'json_schema'}]:
   with self.assertRaises(JsonGuardError):validate_body(self.body(response_format=response_format))
 def test_no_stream(self):
  with self.assertRaisesRegex(ValueError,'nonstreaming'):validate_body(self.body(stream=True))
 def test_output_bounds(self):
  for cap in [0,8193,True]:
   with self.assertRaises(ValueError):validate_body(self.body(max_tokens=cap))
 def test_model_identity(self):
  b=self.body();b['model']='gemma4:12b'
  with self.assertRaises(ValueError):validate_body(b)

class DisconnectContract(unittest.TestCase):
 def test_live_and_closed_peer(self):
  import socket
  left,right=socket.socketpair()
  try:
   self.assertFalse(client_disconnected(left));right.close();self.assertTrue(client_disconnected(left))
  finally:left.close();right.close()
 def test_pending_bytes_are_not_a_disconnect(self):
  import socket
  left,right=socket.socketpair()
  try:
   right.sendall(b'x');self.assertFalse(client_disconnected(left));self.assertEqual(left.recv(1),b'x')
  finally:left.close();right.close()

class Scores:
 def __init__(self,values):self.values=list(values);self.shape=(1,len(values));self.device='cpu'
 def clone(self):return Scores(self.values)
 def __setitem__(self,key,value):
  for index in key[1]:self.values[index]=value
class Finite:
 def __init__(self,scores):self.values=[math.isfinite(x) for x in scores.values]
 def all(self):return all(self.values)
 def any(self):return any(self.values)
FAKE_TORCH=SimpleNamespace(long='long',isfinite=Finite,tensor=lambda rows,**kwargs:SimpleNamespace(rows=rows,**kwargs))

class MaskingContract(unittest.TestCase):
 def grammar(self,processor):return SimpleNamespace(guard=SimpleNamespace(vocab_size=3),processor=processor)
 def test_cpu_logits_masking_sees_prompt_then_exact_generated_prefix(self):
  calls=[]
  def processor(ids,scores):
   calls.append((ids.rows,ids.device,list(scores.values)))
   scores.values[0]=-float('inf');return scores
  grammar=self.grammar(processor);raw=Scores([10,3,8])
  self.assertEqual(constrained_scores(raw,[5,6],[],FAKE_TORCH,[2],grammar).values,[-float('inf'),3,-float('inf')])
  constrained_scores(raw,[5,6],[1],FAKE_TORCH,[2],grammar)
  self.assertEqual([x[0] for x in calls],[[[5,6]],[[5,6,1]]])
  self.assertTrue(all(x[1]=='cpu' for x in calls));self.assertEqual(raw.values,[10,3,8])
 def test_raw_nonfinite_fails_before_grammar(self):
  called=[];grammar=self.grammar(lambda ids,scores:called.append(True))
  for bad in [float('nan'),float('inf'),-float('inf')]:
   with self.assertRaisesRegex(RuntimeError,'Nonfinite raw'):constrained_scores(Scores([bad,2,3]),[5],[],FAKE_TORCH,[],grammar)
  self.assertEqual(called,[])
 def test_no_finite_legal_candidate_fails_without_unconstrained_fallback(self):
  def processor(ids,scores):return Scores([-float('inf')]*3)
  with self.assertRaises(JsonGuardError) as caught:constrained_scores(Scores([1,2,3]),[5],[],FAKE_TORCH,[],self.grammar(processor))
  self.assertEqual(caught.exception.code,'constrained_output_invalid')
 def test_vocabulary_mismatch_and_processor_error_propagate(self):
  with self.assertRaises(JsonGuardError):constrained_scores(Scores([1,2]),[5],[],FAKE_TORCH,[],self.grammar(lambda *_:None))
  def processor(*_):raise RuntimeError('schema processor failed')
  with self.assertRaisesRegex(RuntimeError,'schema processor failed'):constrained_scores(Scores([1,2,3]),[5],[],FAKE_TORCH,[],self.grammar(processor))
 def test_unconstrained_parity_keeps_suppression_and_checks_remaining_candidate(self):
  self.assertEqual(constrained_scores(Scores([1,2,3]),[5],[],FAKE_TORCH,[2]).values,[1,2,-float('inf')])
  with self.assertRaises(JsonGuardError):constrained_scores(Scores([1,2,3]),[5],[],FAKE_TORCH,[0,1,2])

if __name__=='__main__':unittest.main()
