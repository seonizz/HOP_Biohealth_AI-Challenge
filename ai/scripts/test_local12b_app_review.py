"""Offline regressions for refusal collapse and actual app memory validation."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import local12b_app_review as review
from project_answer_review_cases import SCHEMA


def obj(properties):
    return dict(type='object',properties=properties,required=list(properties),additionalProperties=False)


STRING=dict(type='string',minLength=1)
MEMORY_SCHEMA=obj(dict(state=obj(dict(approved=dict(type='boolean'),
    issues=dict(type='array',items=obj(dict(reason=STRING,repair=STRING))),
    audits=dict(type='array',items=obj(dict(id=STRING,reason=STRING,verdict=STRING))))),
    questions=dict(type='null'),safety=dict(type='null')))


def fixture():
    inputs,refs,outputs=[],[],[]
    for task in review.TASKS:
        for normal in (True,False):
            identity=task+str(normal)
            if task=='answer_review':
                candidate='목요일에 만나기로 했어요.' if normal else '화요일에 만나기로 했어요.'
                payload=dict(data=dict(conversation=[dict(role='user',content='화요일이 아니라 목요일로 정정해요.')],candidate_reply=candidate),output_schema=SCHEMA)
                value=dict(approved=normal,reason='현재 정정과 대조함',issues=[] if normal else [dict(code='stale_information',excerpt=candidate,reason='과거 요일 사용',evidence=[dict(turn=1,quote='목요일로 정정해요')],repair='현재 요일 반영')])
            else:
                claims=[dict(id='patient.0',kind='reported_excerpt',group='patient',certainty='reported',claim='이용자가 '+('목요일' if normal else '화요일')+'이라고 보고',evidence=[dict(subject='patient',question_id='q',quote='목요일')])]
                payload=dict(data=dict(shared_input={},review_target=dict(input=dict(reported_dialogue=[dict(turn=1,role='user',content='화요일이 아니라 목요일로 정정해요.')]),state={},claims=claims,reference_roles={}),questions=None,safety=None),output_schema=MEMORY_SCHEMA)
                value=dict(state=dict(approved=normal,issues=[] if normal else [dict(reason='“목요일” 정정과 모순',repair='현재 요일 반영')],audits=[dict(id='patient.0',reason='“목요일”이 현재 원문',verdict='supported' if normal else 'unsupported')]),questions=None,safety=None)
            inputs.append(dict(request_id=identity,task=task,messages=[dict(role='user',content=review.canonical(payload))],source_root_ids=['fixture']))
            refs.append(dict(request_id=identity,task=task,target=value,source_root_ids=['fixture']))
            outputs.append(dict(request_id=identity,status='ok',finish_reason='stop',text=review.canonical(value)))
    return inputs,refs,outputs


class ReviewTests(unittest.TestCase):
    def setUp(self):self.inputs,self.refs,self.outputs=fixture()
    def score(self):return review.score_rows(self.inputs,self.refs,self.outputs)
    def mutate(self,identity,fn):
        row=next(row for row in self.outputs if row['request_id']==identity)
        value=json.loads(row['text']);fn(value);row['text']=review.canonical(value)
    def test_perfect_reference_passes_both_contracts(self):
        self.assertTrue(self.score()['gate']['passed'])
    def test_always_reject_fails_normal_gate_with_good_bad_recall(self):
        for task in review.TASKS:
            bad=next(row['text'] for row in self.outputs if row['request_id']==task+'False')
            next(row for row in self.outputs if row['request_id']==task+'True')['text']=bad
        result=self.score()
        for task in review.TASKS:
            self.assertEqual(result['metrics'][task]['normal_approval']['value'],0)
            self.assertEqual(result['metrics'][task]['bad_rejection']['value'],1)
        self.assertFalse(result['gate']['passed'])
    def test_hallucinated_answer_evidence_rejected_even_correct_decision(self):
        self.mutate('answer_reviewFalse',lambda x:x['issues'][0]['evidence'][0].update(quote='미존재 인용'))
        result=self.score()['metrics']['answer_review']
        self.assertEqual(result['bad_rejection']['value'],1)
        self.assertEqual(result['bad_anchors_exact']['value'],0)
    def test_answer_excerpt_must_exist_in_current_candidate(self):
        self.mutate('answer_reviewFalse',lambda x:x['issues'][0].update(excerpt='금요일'))
        self.assertEqual(self.score()['metrics']['answer_review']['bad_anchors_exact']['value'],0)
    def test_future_and_assistant_evidence_not_accepted(self):
        self.mutate('answer_reviewFalse',lambda x:x['issues'][0]['evidence'][0].update(turn=2))
        self.assertEqual(self.score()['metrics']['answer_review']['bad_anchors_exact']['value'],0)
    def test_memory_fabricated_quote_fails_grounding(self):
        self.mutate('memory_reviewFalse',lambda x:x['state']['audits'][0].update(reason='“없는 날짜”가 근거다'))
        self.assertEqual(self.score()['metrics']['memory_review']['bad_anchors_exact']['value'],0)
    def test_normal_approval_with_fabricated_reason_quote_fails_grounding(self):
        self.mutate('answer_reviewTrue',lambda x:x.update(reason='“없는 날짜”가 근거다'))
        result=self.score()
        self.assertEqual(result['metrics']['answer_review']['normal_approval']['value'],1)
        self.assertEqual(result['metrics']['answer_review']['normal_audits_exact']['value'],0)
        self.assertFalse(result['gate']['passed'])
    def test_always_approve_cannot_pass_bad_rejection_gate(self):
        for task in review.TASKS:
            normal=next(row['text'] for row in self.outputs if row['request_id']==task+'True')
            next(row for row in self.outputs if row['request_id']==task+'False')['text']=normal
        result=self.score()
        for task in review.TASKS:self.assertEqual(result['metrics'][task]['bad_rejection']['value'],0)
        self.assertFalse(result['gate']['passed'])
    def test_current_app_rejects_unsupported_audit_with_approval(self):
        self.mutate('memory_reviewTrue',lambda x:x['state']['audits'][0].update(verdict='unsupported'))
        self.assertEqual(self.score()['metrics']['memory_review']['schema_completion']['value'],.5)
    def test_current_app_rejects_missing_or_duplicate_claim_audits(self):
        self.mutate('memory_reviewTrue',lambda x:x['state'].update(audits=[]))
        self.mutate('memory_reviewFalse',lambda x:x['state']['audits'].append(deepcopy(x['state']['audits'][0])))
        self.assertEqual(self.score()['metrics']['memory_review']['schema_completion']['value'],0)
    def test_missing_truncated_and_fenced_keep_fixed_denominator(self):
        self.outputs.pop(0)
        self.outputs[0]['finish_reason']='length'
        self.outputs[1]['text']='```json\n'+self.outputs[1]['text']+'\n```'
        result=self.score()
        self.assertEqual(result['metrics']['answer_review']['schema_completion']['denominator'],2)
        self.assertEqual(result['metrics']['answer_review']['schema_completion']['value'],0)
        self.assertEqual(result['metrics']['memory_review']['schema_completion']['value'],.5)
    def test_duplicate_json_keys_fail(self):
        self.outputs[0]['text']=self.outputs[0]['text'].replace('"approved":true','"approved":true,"approved":true')
        self.assertEqual(self.score()['metrics']['answer_review']['normal_approval']['value'],0)
    def test_unknown_and_duplicate_output_identity_fail(self):
        self.outputs.append(deepcopy(self.outputs[0]))
        with self.assertRaises(ValueError):self.score()
        self.outputs[-1]['request_id']='foreign'
        with self.assertRaises(ValueError):self.score()
    def test_reason_paraphrase_does_not_require_exact_prose(self):
        self.mutate('answer_reviewFalse',lambda x:x['issues'][0].update(reason='최신 정정을 무시했어요',repair='최신 정보로 수정하세요'))
        self.assertTrue(self.score()['gate']['passed'])
    def test_baseline_requires_same_cohort_version_and_split(self):
        baseline=self.score()
        for key,value in [('cohort_sha256','other'),('version','other'),('split','test')]:
            changed=deepcopy(baseline);changed[key]=value
            with self.assertRaisesRegex(ValueError,'Baseline cohort'):
                review.score_rows(self.inputs,self.refs,self.outputs,changed)
    def test_baseline_contract_drift_fails(self):
        baseline=self.score();baseline['provenance']['contract_sha256']={}
        with self.assertRaisesRegex(ValueError,'contract differs'):
            review.score_rows(self.inputs,self.refs,self.outputs,baseline)
    def test_baseline_regression_fails_even_with_thresholds_met(self):
        inputs=[];refs=[];outputs=[]
        for i in range(20):
            for source,dest in [(self.inputs,inputs),(self.refs,refs),(self.outputs,outputs)]:
                for row in source:
                    cloned=deepcopy(row);cloned['request_id']+=str(i);dest.append(cloned)
        baseline=review.score_rows(inputs,refs,outputs)
        bad=next(row['text'] for row in outputs if row['request_id']=='answer_reviewFalse0')
        next(row for row in outputs if row['request_id']=='answer_reviewTrue0')['text']=bad
        result=review.score_rows(inputs,refs,outputs,baseline)
        self.assertEqual(result['gate']['failed'],[])
        self.assertIn('answer_review/normal_approval',result['gate']['regressions'])
        self.assertIn('answer_review/normal_false_rejection',result['gate']['regressions'])
        self.assertFalse(result['gate']['passed'])
    def test_node_partial_result_never_silently_drops_denominators(self):
        with patch.object(review,'node_call',return_value=[]):
            with self.assertRaisesRegex(ValueError,'inventory mismatch'):self.score()
    def test_report_is_exclusive_outside_bundle_and_protects_outputs(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve();bundle=root/'bundle';bundle.mkdir()
            output=root/'outputs.jsonl';output.write_text('original')
            with self.assertRaises(ValueError):review.write_report(output,{},bundle,[output])
            with self.assertRaises(ValueError):review.write_report(bundle/'report.json',{},bundle)
            report=root/'report.json';review.write_report(report,{'first':True},bundle)
            with self.assertRaises(FileExistsError):review.write_report(report,{},bundle)
            self.assertEqual(output.read_text(),'original')
            self.assertEqual(json.loads(report.read_text()),{'first':True})
    def test_build_rejects_other_parent_and_symlink_parent(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve();real=root/'training_data';real.mkdir();alias=root/'alias';alias.symlink_to(real,target_is_directory=True)
            for parent in (real,alias):
                with self.assertRaises(ValueError):review.fresh_training_destination(parent/'new')
    def test_failed_score_cli_returns_two_and_preserves_written_report(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve();bundle=root/'bundle';bundle.mkdir()
            output=root/'outputs.jsonl';output.write_text('')
            report=root/'report.json'
            with patch.object(review,'evaluate',return_value={'gate':{'passed':False},'provenance':{}}):
                result=review.main(['score','--bundle',str(bundle),'--outputs',str(output),'--report',str(report)])
            self.assertEqual(result,2)
            self.assertFalse(json.loads(report.read_text())['gate']['passed'])


if __name__=='__main__':unittest.main()
