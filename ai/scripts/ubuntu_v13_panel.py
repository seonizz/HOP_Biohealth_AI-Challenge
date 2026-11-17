"""Frozen v1.3 controlled panel for native HF B/C evaluation; CPU only.

No HTTP results are fabricated: paired views point to one immutable native
inference ledger. A shared baseline is reused explicitly in both comparisons.
"""
from pathlib import Path
import hashlib,json,math,sys,datetime,csv,io
from collections import Counter
from copy import deepcopy

MODELS=('baseline','B_original','C_user_provided')
PAIRS={'B_original':'B_reviewer','C_user_provided':'C_combined'}
JS_WHITESPACE='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680'+''.join(chr(i) for i in range(0x2000,0x200b))+'\u2028\u2029\u202f\u205f\u3000\ufeff'

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read(p):return json.loads(Path(p).read_text())
def rows(p):return [json.loads(s) for s in Path(p).read_text().splitlines() if s.strip()]
def canonical(v):return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def objhash(v):return hashlib.sha256(canonical(v).encode()).hexdigest()
def save(p,v):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);t=p.with_suffix(p.suffix+'.tmp')
 import os
 with t.open('w') as f:json.dump(v,f,ensure_ascii=False,indent=2,allow_nan=False);f.write('\n');f.flush();os.fsync(f.fileno())
 t.replace(p)
def write_rows(p,items):
 import os
 with Path(p).open('w') as f:
  for v in items:f.write(canonical(v)+'\n')
  f.flush();os.fsync(f.fileno())
def tools(panel_root):
 source=Path(panel_root).parent/'frozen-source/ai/scripts';sys.path.insert(0,str(source))
 import run_paired_role_evaluation as collector
 import controlled_auto_panel as scorer
 import report_controlled_auto_evaluation as reporter
 return collector,scorer,reporter

def equal_json(a,b):
 if type(a) in (int,float) and type(b) in (int,float):return a==b
 if type(a) is not type(b):return False
 if isinstance(a,dict):return a.keys()==b.keys() and all(equal_json(a[k],b[k]) for k in a)
 if isinstance(a,list):return len(a)==len(b) and all(equal_json(x,y) for x,y in zip(a,b))
 return a==b

def validate_schema(value,schema):
 """Port of frozen app validateSchema, not a generic JSON Schema substitute."""
 if schema.get('anyOf'):
  for variant in schema['anyOf']:
   try:validate_schema(value,variant);return
   except ValueError:pass
  raise ValueError('anyOf')
 if 'const' in schema and not equal_json(value,schema['const']):raise ValueError('const')
 kind=schema.get('type')
 if kind=='object':
  if type(value) is not dict or value.keys()!=schema['properties'].keys():raise ValueError('objectKeys')
  for k,s in schema['properties'].items():validate_schema(value[k],s)
 elif kind=='array':
  if type(value) is not list or len(value)>schema.get('maxItems',math.inf) or len(value)<schema.get('minItems',0):raise ValueError('array')
  for v in value:validate_schema(v,schema['items'])
 elif kind=='string':
  if type(value) is not str or not value.strip(JS_WHITESPACE):raise ValueError('string')
  if len(value.encode('utf-16-le','surrogatepass'))//2>schema.get('maxLength',math.inf):raise ValueError('maxLength')
 elif kind=='boolean' and type(value) is not bool:raise ValueError('boolean')
 elif kind=='null' and value is not None:raise ValueError('null')
 if 'enum' in schema and not any(equal_json(value,v) for v in schema['enum']):raise ValueError('enum')

def parse_json(text):
 def bad(_):raise ValueError('nonfinite JSON')
 return json.loads(text,parse_constant=bad)

def schema_result(request,text):
 try:
  if type(text) is not str or not text.strip(JS_WHITESPACE):raise ValueError('empty_response')
  if request.get('format')=='text':
   if len(text.encode('utf-16-le','surrogatepass'))//2>8000:raise ValueError('text_length_exceeded')
  else:validate_schema(parse_json(text),json.loads(request['messages'][-1]['content'])['output_schema'])
  return {'schema_valid':True,'reason':None}
 except (ValueError,TypeError,KeyError):return {'schema_valid':False,'reason':'MODEL_INVALID_RESPONSE'}

def prepare_fixed(panel_root,output_root):
 panel_root,output_root=Path(panel_root),Path(output_root);output_root.mkdir(parents=True,exist_ok=True)
 collector,_,_=tools(panel_root);suite,paired=collector.load_suite(panel_root)
 baseline=[a for a in paired if a['arm']=='baseline'];assert len(baseline)==240
 requests=[]
 for index,a in enumerate(baseline):
  order=list(MODELS);order=order[index%3:]+order[:index%3]
  for model in order:
   request={k:v for k,v in a.items() if k not in ['arm','logical_request_id']}
   request.update(model=model,native_inference_id=objhash([model,a['request_id']]))
   requests.append(request)
 assert len(requests)==720
 write_rows(output_root/'native-assignments.jsonl',requests)
 save(output_root/'PROTOCOL.json',{'schema':'ubuntu-v13-fixed-protocol-v1','models':list(MODELS),'unique_actual_inferences':720,'paired_comparisons':{m:{'assigned':480,'shared_baseline_actual_inferences':240} for m in PAIRS},'transport':'in_process_HF_no_HTTP','actual_http_posts':0,'source_suite_sha256':collector.digest(suite),'suite_file_sha256':{n:sha(panel_root/n) for n in ['SUITE.json','INPUTS.jsonl','REFERENCES.jsonl']},'baseline_reuse':'same frozen source responses reused, not extra inference or independent samples','max_tokens':1024,'retry_count':0})
 return requests

def finalize_fixed(panel_root,output_root,records):
 panel_root,output_root=Path(panel_root),Path(output_root);collector,scorer,_=tools(panel_root)
 suite,assignments=collector.load_suite(panel_root);by_key={}
 for r in records:
  key=r['model'],r['request_id']
  if key in by_key:raise ValueError('duplicate native fixed output')
  if r['model'] not in MODELS:raise ValueError('unknown model')
  by_key[key]=r
 expected={(m,a['request_id']) for m in MODELS for a in assignments if a['arm']=='baseline'}
 if not set(by_key).issubset(expected):raise ValueError('unassigned native output')
 summaries={}
 for candidate in PAIRS:
  out=output_root/candidate;out.mkdir(exist_ok=True);outputs=[];attempts=[];judgments=[]
  for a in assignments:
   model='baseline' if a['arm']=='baseline' else candidate;record=by_key.get((model,a['request_id']))
   identity={k:v for k,v in a.items() if k!='request'}
   if record is None:
    judgments.append({**{k:identity[k] for k in ['arm','request_id','case_id','source_group_id','task','output_stage']},'execution_status':'not_run','schema_valid':None,'reason':'not_run'});continue
   execution=record['execution_status']
   if execution not in ['output_received','failed']:raise ValueError('invalid native terminal status')
   text=record.get('text','')
   if execution=='output_received' and not text.strip(JS_WHITESPACE):execution='failed'
   row={**identity,'execution_status':execution,'text':text,'started_at':record.get('started_at'),'completed_at':record.get('completed_at'),'native_model_id':model,'native_inference_id':record.get('native_inference_id') or objhash([model,a['request_id']]),'native_record_sha256':objhash(record),'response_sha256':objhash(record),'response_digest_kind':'canonical_native_inference_record_not_HTTP','transport':'in_process_HF_no_HTTP','shared_baseline_reused':model=='baseline'}
   outputs.append(row)
   attempts.extend([{**identity,'event':'started','transport':'in_process_HF_no_HTTP','native_inference_id':row['native_inference_id']},{**identity,'event':'completed','transport':'in_process_HF_no_HTTP','native_inference_id':row['native_inference_id']}])
   judgment={k:identity[k] for k in ['arm','request_id','case_id','source_group_id','task','output_stage']}
   judgments.append({**judgment,'execution_status':execution,**(schema_result(a['request'],text) if execution=='output_received' else {'schema_valid':False,'reason':'failed'})})
  write_rows(out/'assignments.jsonl',assignments);write_rows(out/'outputs.jsonl',outputs);write_rows(out/'attempts.jsonl',attempts)
  save(out/'metadata.json',{'schema':'malssi-paired-role-run-v1','suite_sha256':collector.digest(suite),'suite_file_sha256':{n:sha(panel_root/n) for n in ['SUITE.json','INPUTS.jsonl','REFERENCES.jsonl']},'candidate':candidate,'transport':'in_process_HF_no_HTTP','actual_http_posts':0,'source_native_ledger':'../fixed-responses.jsonl'})
  metrics=[]
  for task in sorted({a['task'] for a in assignments}):
   for arm in ['baseline','trained']:
    group=[j for j in judgments if j['task']==task and j['arm']==arm];counts=Counter(j['execution_status'] for j in group);n=sum(j['schema_valid'] is True for j in group)
    metrics.append({'metric_id':'M01','task':task,'arm':arm,'unit':'logical_request','output_stage':'first_draft','assigned_count':len(group),'received_count':counts['output_received'],'failed_count':counts['failed'],'not_run_count':counts['not_run'],'missing_execution_evidence_count':0,'source_group_count':len({j['source_group_id'] for j in group}),'numerator':n,'denominator':len(group),'value':None if counts['not_run'] else n/len(group),'status':'incomplete' if counts['not_run'] else 'measured','semantic_quality_evaluated':False})
  save(out/'format-metrics.json',{'schema':'malssi-paired-format-summary-v1','metrics':metrics,'judgments':judgments,'comparisons':[],'validator':'frozen_actual_app_validateSchema_port_with_Node_parity_proof'})
  summary={'status':'completed' if len(outputs)==480 else 'infrastructure_interrupted','arms':{arm:{'assigned_count':240,'received_count':sum(x['arm']==arm and x['execution_status']=='output_received' for x in outputs),'failed_count':sum(x['arm']==arm and x['execution_status']=='failed' for x in outputs),'not_run_count':240-sum(x['arm']==arm for x in outputs)} for arm in ['baseline','trained']}}
  save(out/'summary.json',summary);scorer.score(panel_root,out);summaries[candidate]=summary
 save(output_root/'COMPARISONS.json',summaries)
 return summaries

def build_report(root,work,summary):
 root,work=Path(root),Path(work);panel=root/'panel';fixedroot=work/'controlled/fixed-run';_,_,reporter=tools(panel)
 coverage=read(root/'design-coverage-audit.json');by_regime={}
 flow_summary=summary.get('full_flow_summary',summary)
 for result in flow_summary.get('results',[]):by_regime.setdefault(result.get('regime'),[]).append(result)
 reports={};complete=True
 if not all((fixedroot/c/'format-metrics.json').exists() for c in PAIRS):
  result={'automatic_panel_complete':False,'status':'infrastructure_interrupted','raw_fixed_evidence_preserved':True,'summary':summary,'metrics':[{'metric_id':f'M{i:02d}','status':'incomplete','value':None} for i in range(1,21)]}
  save(work/'all-metrics.json',result);(work/'REPORT.md').write_text('# B·C 모델 평가 — 미완료\n\n인프라 중단으로 전체 비교를 확정하지 않았습니다. 실행 원문과 미실행 목록을 보존했습니다.\n');return result
 for candidate,regime in PAIRS.items():
  pair=fixedroot/candidate;assignments=rows(pair/'assignments.jsonl');outcomes=rows(pair/'outputs.jsonl');formatted=read(pair/'format-metrics.json')
  fixed={'assignments':assignments,'outputs':{reporter.arm_key(r):r for r in outcomes},'judgments':{reporter.arm_key(r):r for r in formatted['judgments']},'format':formatted,'controlled':read(pair/'controlled-metrics.json'),'summary':read(pair/'summary.json')}
  converted=[];arms={}
  for arm,name in [('baseline','baseline'),('trained',regime)]:
   group=by_regime.get(name,[])
   for r in group:converted.append({**deepcopy(r),'arm':arm})
   n=sum(r.get('m02_complete') is True for r in group);arms[arm]={'numerator':n,'denominator':6,'failed_count':sum(r.get('status')=='failed' for r in group),'not_run_count':6-len(group),'value':n/6 if len(group)==6 else None}
  pair_complete=(fixed['summary']['status']=='completed' and len(converted)==12 and all(len(by_regime.get(k,[]))==6 for k in ['baseline',regime]))
  if pair_complete:
   flow={'results':converted,'summary':{'M02':{'by_arm':arms}}};data=reporter.registry(fixed,flow,coverage)
   for metric in data['metrics']:
    if metric['metric_id'] in ['M19','M20']:metric['reason']='teacher_forced_label_probability_method_not_implemented_and_qualified_in_this_run'
  else:
   complete=False;data={'automatic_panel_complete':False,'metrics':[{'metric_id':f'M{i:02d}','name':reporter.NAMES[f'M{i:02d}'],'status':'incomplete','value':None} for i in range(1,21)],'fixed_summary':fixed['summary'],'full_flow_counts':arms}
  data.update(candidate=candidate,baseline='baseline',transport_profile='HF_prompt_only_no_grammar_with_SSH_filesystem_queue_for_app',actual_http_posts=0,serving_base_revision=read(root/'protocol.json')['base_revision'],full_flow_comparison_scope='reviewer_effect_writer_fixed_baseline' if candidate=='B_original' else 'combined_generator_and_reviewer_effect_not_isolated_generator_effect',role_scope='B primary reviewer; generator slots are role-transfer benchmark diagnostics' if candidate=='B_original' else 'C combined generator and reviewer',shared_baseline_reused=True,native_validation_ce_is_supplemental_not_substitute_for_v13_metrics=True)
  save(work/'controlled'/candidate/'all-metrics.json',data);reports[candidate]=data
 all_data={'schema':'ubuntu-v13-B-C-comparisons-v1','protocol_version':'1.3','automatic_panel_complete':complete,'unique_fixed_model_calls':720,'unique_app_cases':18,'comparisons':reports,'all_twenty_metrics_measured':False,'human_scores_created':False,'actual_http_posts':0,'full_flow_transport':'SSH filesystem queue native GPU worker','weighted_overall_score':None}
 save(work/'all-metrics.json',all_data)
 lines=['# B·C 모델 평가 — 기획서 v1.3','','기반 미학습 모델과 B·C를 같은 30개 통제 사례·8개 슬롯에서 비교합니다. 실제 GPU 추론은 720건이고, 동일한 기반 응답을 두 480건 비교에서 재사용합니다. 새로운 독립 test가 아닙니다.','','앱 전체 흐름은 6개 맥락 × 3개 조합으로 18건입니다. B는 생성자를 기반 모델로 고정하고 검토자만 바꿉니다. C는 생성·검토를 함께 바꾼 조합 효과이며 생성자 단독 효과로 해석하지 않습니다. 앱은 실제 ModelGateway를 실행하며 HF prompt 방식, SSH 파일 큐를 사용합니다. 실제 HTTP 요청 수는 0입니다.','','| 비교 | 지표 | 미학습 | 학습 |','|---|---|---:|---:|']
 def val(v):return '미측정' if v is None else f'{v:.4f}'
 for candidate,data in reports.items():
  for item in data['metrics']:
   for variant in item.get('variants',[]):
    per=variant.get('per_arm',{});lines.append(f"| {candidate} | {item['metric_id']} {variant.get('metric_variant','')} | {val(per.get('baseline',{}).get('value'))} | {val(per.get('trained',{}).get('value'))} |")
 lines+=['','M08·M10·M14·M15·M16·M17·M18의 공식 사람 점수와 M19·M20은 미측정입니다. A08·A10·A14·A15·A16·A18 자동 부분 검사는 별도 수치이며 사람 판단을 대신하지 않습니다. 속도 순위·임상 적합성·가중 종합 점수·모델 통과 판정은 만들지 않습니다.','','M01 S8·M12·M13은 공유 정책 커널의 독립성이 입증되지 않아 신뢰구간을 확증 근거로 사용하지 않습니다. 나머지 6계보 구간도 통제 파일럿의 기술 통계입니다.']
 (work/'REPORT.md').write_text('\n'.join(lines)+'\n')
 with (work/'metrics.csv').open('w',newline='',encoding='utf-8-sig') as handle:
  writer=csv.DictWriter(handle,fieldnames=['candidate','metric_id','metric_variant','arm','status','value','numerator','denominator']);writer.writeheader()
  for candidate,data in reports.items():
   for item in data['metrics']:
    for variant in item.get('variants',[{}]):
     for arm in ['baseline','trained']:
      unit=variant.get('per_arm',{}).get(arm,{})
      writer.writerow({'candidate':candidate,'metric_id':item['metric_id'],'metric_variant':variant.get('metric_variant',''),'arm':arm,'status':variant.get('status',item.get('status','not_measured')),'value':unit.get('value'),'numerator':unit.get('numerator'),'denominator':unit.get('denominator')})
 save(work/'verification.json',{'automatic_panel_complete':complete,'fixed_actual_call_inventory':720,'app_actual_case_inventory':18,'shared_baseline_reuse_disclosed':True,'formal_human_scores_created':False,'scorer_sha256':sha(root/'frozen-source/ai/scripts/controlled_auto_panel.py'),'app_pipeline_summary_sha256':sha(work/'controlled/full-flow/summary.json'),'report_source_sha256':sha(Path(__file__))})
 return all_data
