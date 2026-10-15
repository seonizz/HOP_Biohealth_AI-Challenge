import gzip,hashlib,json,sys
from pathlib import Path
root=Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
assert root.resolve()==root
sys.path.insert(0,str(root/'validation_source'))
from counseling_pipeline.token_admission import build_token_admission,export_source_rows
inputs=root/'inputs'
args=[inputs/'source',inputs/'admission/admission_policy.json',inputs/'admission/admission_rows.jsonl.gz',inputs/'tokenizer_audit/audit.json',inputs/'tokenizer_audit/row_lengths.jsonl.gz']
policy=json.loads(args[1].read_text())
assert hashlib.sha256(args[1].read_bytes()).hexdigest()=='36691c58ee4a1a94850ab0dfff61cb2b5ec204dcbf6e021d965902913ca678a8'
assert hashlib.sha256(args[2].read_bytes()).hexdigest()=='0f1ef6439f8e1fbd2ea18f993680ffddbba70b4101a083cd23eb7f549565c08b'
selection=root/'work/selection_32768'
report=build_token_admission(*args,selection,cap=32768)
export=root/'work/full_long_source'
result=export_source_rows(*args,selection/'token_admission_policy.json',selection/'token_admission_rows.jsonl.gz',export,cap=32768)
with gzip.open(args[4],'rt') as f: lengths={r['id']:r for r in map(json.loads,f)}
rows={}
for split,expected in [('train',40415),('validation',4298)]:
 with gzip.open(export/(split+'.jsonl.gz'),'rt') as f: data=[json.loads(l) for l in f]
 assert len(data)==expected
 assert all(r['source_group_id'] not in policy['quarantined_source_groups'] and r['id'] not in policy['held_validation_example_ids'] for r in data)
 rows[split]={'rows':len(data),'max_sequence':max(lengths[r['id']]['sequence_length'] for r in data),'max_target':max(lengths[r['id']]['target_length'] for r in data),'input_tokens':sum(lengths[r['id']]['sequence_length'] for r in data),'supervised_tokens':sum(lengths[r['id']]['target_length'] for r in data)}
 # The 4096 subset must reproduce the existing original kit byte-for-byte before compression.
 with gzip.open(export/(split+'.jsonl.gz'),'rb') as f: subset=[l for l in f if lengths[json.loads(l)['id']]['sequence_length']<=4096]
 old=Path('/home/slim/choieram/model_Training/malssi_stage1_training_20261009/data')/(split+'.jsonl.gz')
 with gzip.open(old,'rb') as f: previous=list(f)
 assert subset==previous,'4096 subset changed from original verified data'
 rows[split]['legacy_4096_exact_raw_lines_match']=True
 rows[split]['legacy_4096_rows']=len(subset)
summary={'status':'verified','export_directory':str(export),'selected_cap':32768,'held_rows_preserved':1261,'splits':rows,'synthetic_probe_data_included':False,'truncation':False,'source_split_moved':False}
with (root/'work/collection/long_source_export.json').open('x') as f: json.dump(summary,f,indent=2)
print(json.dumps(summary))
