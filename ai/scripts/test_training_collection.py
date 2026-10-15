"""Focused structural-check tests. Synthetic fixtures remain in temporary folders."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

KIT=Path(__file__).resolve().parents[1]/'outputs/training_collection_20261009'
spec=importlib.util.spec_from_file_location('collection_tools',KIT/'collection_tools.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CollectionTests(unittest.TestCase):
    def test_empty_init_is_not_evidence_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            out=Path(td)/'fixture'
            cmd=[sys.executable,str(KIT/'collection_tools.py'),'init','--run-id','fixture','--output',str(out)]
            self.assertEqual(subprocess.run(cmd,capture_output=True).returncode,0)
            first=(out/'run_manifest.json').read_bytes()
            self.assertEqual(subprocess.run(cmd,capture_output=True).returncode,2)
            self.assertEqual((out/'run_manifest.json').read_bytes(),first)
            result=module.check(out,'after_eval')
            self.assertFalse(result['structural_check_passed'])
            self.assertEqual(sum(result['record_counts'].values()),0)
            (out/'preflight.json').write_text('[]')
            self.assertFalse(module.check(out,'before')['structural_check_passed'])

    def test_real_zero_is_not_missing(self):
        self.assertFalse(module.absent(0))
        self.assertFalse(module.absent(False))
        self.assertTrue(module.absent(None))

    def test_valid_step_and_invalid_numeric(self):
        row={'run_id':'fixture','segment_id':'s1','attempt_id':'a1','timestamp':'2026-10-09T00:00:00+00:00',
             'optimizer_attempt':1,'successful_update_count':1,'status':'updated','input_tokens':100,
             'supervised_tokens':10,'learning_rate':0.0,'loss_reported':0.0,'step_wall_seconds':1.2,
             'loss_reduction':'documented_fixture','metric_scope':'global'}
        errors=[];module.check_record('train_steps.jsonl',row,'fixture','fixture',errors)
        self.assertEqual(errors,[])
        row['input_tokens']=True;row['loss_reported']=float('nan')
        errors=[];module.check_record('train_steps.jsonl',row,'fixture','fixture',errors)
        self.assertTrue(any('non-finite' in e for e in errors))
        self.assertTrue(any('nonnegative integer' in e for e in errors))

    def test_hash_and_timestamp_validation(self):
        errors=[]
        module.inspect_values({'response_sha256':'bad'},'fixture',errors)
        self.assertTrue(errors)
        row={key:'x' for key in module.REQUIRED['events.jsonl']}
        row.update(run_id='fixture',timestamp='2026-10-09T00:00:00')
        errors=[];module.check_record('events.jsonl',row,'fixture','fixture',errors)
        self.assertTrue(any('timezone-aware' in e for e in errors))

    def test_missing_review_cannot_be_pass(self):
        row={key:'x' for key in module.REQUIRED['reviews.jsonl']}
        row.update(run_id='fixture',response_sha256='a'*64,rubric_sha256='b'*64,
                   reviewed_at='2026-10-09T00:00:00+00:00',reviewer_kind='human',
                   blinded=True,independent=True,review_status='completed',criteria={})
        errors=[];module.check_record('reviews.jsonl',row,'fixture','fixture',errors)
        self.assertEqual(sum('criteria.' in e for e in errors),7)

    def test_impossible_counts_are_rejected(self):
        cases=[
          ('validation.jsonl',{'assigned_rows':1,'evaluated_rows':10,'error_rows':10,'status':'partial'},'exceeds assigned'),
          ('generations.jsonl',{'generated_tokens':8,'max_new_tokens':4,'status':'error'},'exceeds max_new'),
          ('train_steps.jsonl',{'status':'updated','successful_update_count':0,'supervised_tokens':0,'input_tokens':0,'step_wall_seconds':0},'positive')]
        for name,row,expected in cases:
            errors=[];module.check_record(name,row,'fixture','fixture',errors)
            self.assertTrue(any(expected in e for e in errors),errors)

if __name__=='__main__':unittest.main()
