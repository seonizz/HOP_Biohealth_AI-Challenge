import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from counseling_pipeline.ingest import ingest
from counseling_pipeline import annotations as a


def write_source(source,split,name,text,subject,label=0):
    p=source/split/name;p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps({'id':subject,'class':'synthetic','new_top_label':label,
      'paragraph':[{'paragraph_text':text,'paragraph_speaker':'test','depressive_mood':label,
                    'second':None}]},ensure_ascii=False))

class AnnotationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'source';self.output=self.root/'output'
        write_source(self.source,'Training','a.json','가나다 테스트.','one')
        ingest(self.source,self.output)
        self.defs={'version':'synthetic-test-only-v1','scale_status':'resolved','labels':{
            k:{'definition_status':'resolved','allowed_values':[0,1],'code_meanings':{'0':'synthetic zero','1':'synthetic one'}}
            for k in ['depressive_mood','second']}}
        self.dp=self.root/'definitions.json';self.dp.write_text(json.dumps(self.defs))
        a.prepare(self.output,self.dp)
        db=sqlite3.connect(self.output/'corpus.sqlite');self.sid=db.execute('SELECT sentence_id FROM sentences').fetchone()[0];db.close()
        self.context=a.context(self.output,self.sid)
    def tearDown(self):self.temp.cleanup()
    def run_meta(self,name):
        return {'run_id':name,'environment':'SYNTHETIC TEST, NOT ACTUAL AI','model_id':None,
            'prompt_version':'test','dictionary_version':self.defs['version'],
            'dictionary_hash':a.digest(self.defs),'timestamp':'2000-01-01T00:00:00Z'}
    def candidate(self,value=0,key='depressive_mood'):
        return {'key':key,'value':value,'reason':'synthetic regression fixture',
          'evidence':[{'start':self.context['start_char'],'end':self.context['start_char']+3,'text':'가나다'}]}
    def generation(self,candidates=None):
        return {'sentence_id':self.sid,'context_hash':a.digest(self.context),'run':self.run_meta('g'),
          'candidates':candidates if candidates is not None else [self.candidate()]}
    def verification(self,gid,candidates=None,verdict='agree',run='v'):
        return {'sentence_id':self.sid,'context_hash':a.digest(self.context),'run':self.run_meta(run),
          'generation_id':gid,'independent_judgment_recorded_first':True,
          'independent_candidates':candidates if candidates is not None else [self.candidate()],
          'verdict':verdict,'reason':'synthetic independent review fixture'}
    def test_prepare_never_fakes_actual_runs(self):
        r=a.summary(self.output);self.assertEqual(r['actual_generation_records'],0)
        self.assertEqual(r['job_status'],{'pending':1});a.prepare(self.output,self.dp)
        self.assertEqual(a.summary(self.output)['sentences'],1)
    def test_separate_runs_evidence_and_idempotent_resume(self):
        generation=self.generation();bad=copy.deepcopy(generation);bad['candidates'][0]['evidence'][0]['text']='wrong'
        with self.assertRaisesRegex(ValueError,'mismatch'):a.import_record(self.output,self.dp,bad,'generation')
        gid=a.import_record(self.output,self.dp,generation,'generation')
        self.assertEqual(gid,a.import_record(self.output,self.dp,generation,'generation'))
        with self.assertRaisesRegex(ValueError,'separate run'):a.import_record(self.output,self.dp,self.verification(gid,run='g'),'verification')
        v=self.verification(gid);a.import_record(self.output,self.dp,v,'verification');a.import_record(self.output,self.dp,v,'verification')
        self.assertEqual(a.summary(self.output)['actual_verification_records'],1)
        self.assertEqual(a.export_reviews(self.output)['confirmed'],1)
    def test_unresolved_numeric_semantics_block_generation(self):
        self.defs['scale_status']='unresolved';self.defs['labels']['depressive_mood']['definition_status']='definition_unresolved'
        self.dp.write_text(json.dumps(self.defs));a.prepare(self.output,self.dp)
        self.assertEqual(a.export_batch(self.output,self.root/'batch.jsonl'),0)
        with self.assertRaisesRegex(ValueError,'unresolved'):a.import_record(self.output,self.dp,self.generation(),'generation')
        self.assertEqual(a.summary(self.output)['actual_generation_records'],0)
    def test_dictionary_drift_is_rejected(self):
        gid=a.import_record(self.output,self.dp,self.generation(),'generation')
        self.defs['labels']['depressive_mood']['code_meanings']['0']='changed meaning'
        self.dp.write_text(json.dumps(self.defs))
        with self.assertRaisesRegex(ValueError,'prepared'):a.import_record(self.output,self.dp,self.verification(gid),'verification')
    def test_source_drift_requires_new_version(self):
        write_source(self.source,'Training','a.json','새로운 원문.','one');ingest(self.source,self.output)
        with self.assertRaisesRegex(ValueError,'Source corpus changed'):a.prepare(self.output,self.dp)
    def test_human_is_terminal_and_effective_value_is_explicit(self):
        gid=a.import_record(self.output,self.dp,self.generation(),'generation')
        a.import_record(self.output,self.dp,self.verification(gid,[self.candidate(1)],'disagree'),'verification')
        human={'sentence_id':self.sid,'context_hash':a.digest(self.context),'dictionary_hash':a.digest(self.defs),
          'reviewer':'synthetic test reviewer','timestamp':'2000-01-01T00:00:00Z','decision':'correct','candidates':[self.candidate(1)]}
        a.import_human(self.output,self.dp,human)
        with self.assertRaisesRegex(ValueError,'terminal'):a.import_record(self.output,self.dp,self.verification(gid,run='v2'),'verification')
        a.export_reviews(self.output)
        confirmed=json.loads((self.output/'labels/confirmed.jsonl').read_text())
        self.assertEqual(confirmed['effective_candidates'][0]['value'],1)
        self.assertEqual(confirmed['effective_provenance'],'human_verified')
    def test_uncertain_label_does_not_hide_agreed_label(self):
        cs=[self.candidate(),self.candidate(None,'second')]
        gid=a.import_record(self.output,self.dp,self.generation(cs),'generation')
        a.import_record(self.output,self.dp,self.verification(gid,cs),'verification')
        counts=a.export_reviews(self.output)
        self.assertEqual(counts['confirmed'],1);self.assertEqual(counts['human_review'],1)
        confirmed=json.loads((self.output/'labels/confirmed.jsonl').read_text())
        self.assertEqual([x['key'] for x in confirmed['effective_candidates']],['depressive_mood'])
    def test_only_one_recheck_and_no_automatic_human_confirmation(self):
        gid=a.import_record(self.output,self.dp,self.generation(),'generation')
        for name in ['v1','v2']:
            a.import_record(self.output,self.dp,self.verification(gid,[self.candidate(None)],'uncertain',name),'verification')
        with self.assertRaisesRegex(ValueError,'maximum'):a.import_record(self.output,self.dp,self.verification(gid,run='v3'),'verification')
        self.assertEqual(a.summary(self.output)['actual_human_decisions'],0)
        with self.assertRaises(ValueError):a.import_human(self.output,self.dp,{'sentence_id':self.sid})
    def test_partial_human_decision_retains_other_ai_accepted_labels(self):
        cs=[self.candidate(),self.candidate(None,'second')]
        gid=a.import_record(self.output,self.dp,self.generation(cs),'generation')
        a.import_record(self.output,self.dp,self.verification(gid,cs),'verification')
        human={'sentence_id':self.sid,'context_hash':a.digest(self.context),'dictionary_hash':a.digest(self.defs),
          'reviewer':'synthetic test reviewer','timestamp':'2000-01-01T00:00:00Z','decision':'correct',
          'candidates':[self.candidate(1,'second')]}
        a.import_human(self.output,self.dp,human);a.export_reviews(self.output)
        record=json.loads((self.output/'labels/confirmed.jsonl').read_text())
        self.assertEqual({x['key'] for x in record['effective_candidates']},{'depressive_mood','second'})
        self.assertEqual(record['candidate_provenance'],{'depressive_mood':'ai_verified','second':'human_verified'})
        self.assertEqual(record['pending_candidates'],[])
    def test_rejecting_pending_key_retains_ai_accepted_key(self):
        cs=[self.candidate(),self.candidate(None,'second')]
        gid=a.import_record(self.output,self.dp,self.generation(cs),'generation')
        a.import_record(self.output,self.dp,self.verification(gid,cs),'verification')
        human={'sentence_id':self.sid,'context_hash':a.digest(self.context),'dictionary_hash':a.digest(self.defs),
          'reviewer':'synthetic reviewer','timestamp':'2000-01-01T00:00:00Z','decision':'reject','candidates':[]}
        a.import_human(self.output,self.dp,human);a.export_reviews(self.output)
        record=json.loads((self.output/'labels/confirmed.jsonl').read_text())
        self.assertEqual([x['key'] for x in record['effective_candidates']],['depressive_mood'])
        self.assertEqual(record['rejected_keys'],['second'])

@unittest.skipUnless(importlib.util.find_spec('numpy'),'existing NumPy runtime required')
class NumericTests(unittest.TestCase):
    def test_train_fit_masks_all_source_keys_vector_links_and_resume(self):
        import numpy as np
        from counseling_pipeline.numeric import representations
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source';out=root/'out'
            write_source(source,'Training','a.json',"ＡＢＣ don't café 가나다 가나다.",'p1',0)
            write_source(source,'Training','b.json','가나다 다른 단어.','p2',None)
            write_source(source,'Validation','c.json','검증전용 토큰.','p3',1)
            malformed_shape=source/'Training/a.json'
            payload=json.loads(malformed_shape.read_text());payload['paragraph'].append(None)
            malformed_shape.write_text(json.dumps(payload,ensure_ascii=False))
            ingest(source,out)
            config={'word_vocabulary_limit':50,'word_hash_dimensions':16,'char_hash_dimensions':16,
                'cooccurrence_vocabulary_limit':20,'cooccurrence_window':2,'svd_dimensions':3,'random_seed':17}
            manifest=representations(out,config)
            vocab=json.loads((out/'numeric/vocabulary.json').read_text())
            self.assertNotIn('u:검증전용',vocab['terms']);self.assertEqual(vocab['train_rows'],2)
            self.assertEqual(manifest['fit_train_sentences'],2)
            dictionary=json.loads((out/'numeric/conversation_label_dictionary.json').read_text())
            self.assertIn('new_top_label',dictionary['keys'])
            self.assertIn(['new_top_label','int',0],dictionary['categories'])
            self.assertIn(['new_top_label','NoneType',None],dictionary['categories'])
            dictionary=json.loads((out/'numeric/utterance_label_dictionary.json').read_text())
            self.assertIn('second',dictionary['keys'])
            lookup=[json.loads(x) for x in (out/'numeric/word_vocabulary.jsonl').read_text().splitlines()]
            for token in ['abc',"don't",'café']:
                entry=next(r for r in lookup if r['word']==token);self.assertIsNotNone(entry['distributional_row'])
            lexical=next(x for x in manifest['artifacts'] if x['path']=='word_lexical_statistics.npy')
            self.assertNotIn('total_count_exploratory',lexical['columns'])
            self.assertTrue((out/'numeric/exploration/word_total_counts.jsonl').exists())
            for item in manifest['artifacts']:
                p=out/'numeric'/item['path']
                if p.suffix=='.npz':
                    with np.load(p) as data:
                        self.assertEqual(list(data['shape']),item['shape']);self.assertTrue(np.isfinite(data['data']).all())
            before=(out/'numeric/manifest.json').read_bytes()
            self.assertEqual(manifest,representations(out,config));self.assertEqual(before,(out/'numeric/manifest.json').read_bytes())
            # Corrupt an output: resume must regenerate instead of trusting the completion flag.
            (out/'numeric/idf.npy').write_bytes(b'corruption')
            representations(out,config)
            self.assertTrue(np.isfinite(np.load(out/'numeric/idf.npy')).all())
            from counseling_pipeline.verify import verify
            definitions=Path(__file__).resolve().parents[1]/'counseling_pipeline/label_definitions.json'
            a.prepare(out,definitions);a.export_reviews(out)
            report=verify(out,source)
            self.assertTrue(report['checks_passed'],report['failures'])
            self.assertFalse(report['full_spec_complete'])
            self.assertEqual(report['annotations']['actual_generation_records'],0)

if __name__=='__main__':unittest.main()
