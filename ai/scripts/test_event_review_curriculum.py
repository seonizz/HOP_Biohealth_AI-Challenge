import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

import event_review_curriculum as c


class CurriculumTests(unittest.TestCase):
    def make_bundle(self, parent):
        root = Path(parent).resolve()/'training_data'
        root.mkdir(exist_ok=True)
        bundle = root/'bundle'
        c.build(bundle, dict(train=6, validation=6, test=6), seed=971)
        return bundle

    def rebind(self, bundle):
        manifest = json.loads((bundle/'MANIFEST.json').read_text())
        manifest['files'] = c.inventory(bundle)
        c.d.save(bundle/'MANIFEST.json', manifest)

    def test_forward_construction_matches_reverse_oracle(self):
        for n in range(60):
            events, expected = c.make_source(971,n)
            self.assertEqual(c.parse_events(dict(events=events,event_grammar=c.GRAMMAR)), expected)
            self.assertGreaterEqual(len(expected),6)
            self.assertTrue(any(x['certainty']=='unknown' for x in expected))
            self.assertTrue(any(x['negated']=='true' for x in expected))

    def test_shuffled_pairs_cover_all_six_error_fields_and_encodings(self):
        events,facts=c.make_source(971,0)
        for field in c.FIELDS:
            rows=c.project(events,facts,'synthetic-root','train',field,971)
            self.assertEqual(len(rows),6)
            for row,ref,train in rows:
                payload=json.loads(row['messages'][-1]['content'])
                if row['task']=='event_review':
                    self.assertEqual(c.review_target(payload['data']),ref['target'])
                    if not ref['target']['approved']:
                        issue=ref['target']['issues'][0]
                        self.assertEqual(issue['field'],field)
                        self.assertEqual(issue['actual'],payload['data']['draft'][issue['index']][field])
                        self.assertNotEqual(issue['actual'],issue['expected'])
                c.d.check_row(train)

    def test_same_value_reassertion_uses_latest_sequence(self):
        events,facts=c.make_source(971,3)
        last=dict(events[-1],time=str(int(events[-1]['time'])+11))
        data=dict(events=events+[last],event_grammar=c.GRAMMAR)
        expected=c.parse_events(data)
        match=next(f for f in expected if (f['person'],f['attribute'])==(last['person'],last['attribute']))
        self.assertEqual(match,last)
        self.assertNotEqual(match['time'],events[-1]['time'])

    def test_duplicate_or_reversed_time_is_rejected(self):
        events,_=c.make_source(971,1)
        for change in ('duplicate','reverse'):
            bad=deepcopy(events)
            if change=='duplicate':bad[1]['time']=bad[0]['time']
            else:bad[0],bad[1]=bad[1],bad[0]
            with self.assertRaises(ValueError):c.parse_events(dict(events=bad,event_grammar=c.GRAMMAR))

    def test_fingerprint_is_invariant_to_id_and_scalar_renaming(self):
        events,_=c.make_source(971,5)
        renamed=deepcopy(events)
        for index,f in enumerate(renamed):
            for key in ('person','attribute','value'):f[key]='renamed:'+f[key]
            f['time']=str(5000+index*10)
        self.assertEqual(c.structure_fingerprint(events),c.structure_fingerprint(renamed))

    def test_build_keeps_pairs_grouped_and_test_out_of_course(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.make_bundle(tmp)
            report=c.verify(root)
            self.assertEqual([v['rows'] for v in report['partitions'].values()],[36,36,36])
            course=json.loads((root/'COURSE_PROPOSAL.json').read_text())
            self.assertEqual(set(course['data']),{'train','validation'})
            self.assertFalse(course['training_ready'])
            self.assertFalse((root/'data/test.jsonl').exists())
            for split in c.SPLITS:
                counts=report['partitions'][split]['counts']
                self.assertEqual(counts['normal'],counts['error'])
                self.assertEqual([counts['error_'+f] for f in c.FIELDS],[2]*6)

    def test_changed_target_is_rejected_even_if_files_and_target_hash_rebound(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.make_bundle(tmp)
            file=root/'evaluation/train/references.jsonl'
            rows=c.read_rows(file)
            row=next(r for r in rows if r['target'].get('approved') is True)
            row['target']=dict(approved=False,issues=[])
            file.write_text(''.join(c.canonical(r)+'\n' for r in rows))
            self.rebind(root)
            with self.assertRaisesRegex(ValueError,'Incorrect semantic label'):c.verify(root)

    def test_past_value_cannot_be_reported_as_actual(self):
        events,facts=c.make_source(971,9)
        rows=c.project(events,facts,'synthetic-root','train','value',971)
        row,ref,_=next(x for x in rows if x[1]['changed_field']=='value')
        data=json.loads(row['messages'][-1]['content'])['data']
        oracle=c.review_target(data)
        forged=deepcopy(ref['target']);forged['issues'][0]['actual']=forged['issues'][0]['expected']
        self.assertNotEqual(oracle,forged)

    def test_no_overwrite_or_partial_field_support(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=self.make_bundle(tmp)
            before=(root/'MANIFEST.json').read_bytes()
            with self.assertRaises(ValueError):c.build(root)
            self.assertEqual(before,(root/'MANIFEST.json').read_bytes())
            with self.assertRaises(ValueError):c.build(root.parent/'bad',dict(train=7,validation=6,test=6))

    def test_repeat_build_is_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            a=self.make_bundle(tmp)
            b=a.parent/'second'
            c.build(b,dict(train=6,validation=6,test=6),seed=971)
            self.assertEqual(c.inventory(a),c.inventory(b))


if __name__=='__main__':
    unittest.main()
