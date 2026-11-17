import json
import unittest
from collections import Counter
from copy import deepcopy

import local12b_contrast_repair as repair


class ContrastRepairTests(unittest.TestCase):
    def source_for(self, spec):
        for number in range(1, 100):
            events, facts = repair.enhanced.source(repair.SEED, number)
            if spec['expected'] is None or any(f[spec['field']] == spec['expected'] for f in facts):
                return dict(source_root_id='private-source-'+str(number), split='validation', events=events,
                            contrast=spec, structure_sha256=repair.event.structure_fingerprint(events))
        self.fail('No fixture with required direction')

    def test_field_direction_and_time_quotas(self):
        specs=repair.specs(96)
        self.assertEqual(Counter(s['field'] for s in specs),dict.fromkeys(repair.event.FIELDS,96))
        self.assertEqual(Counter(s['challenge'] for s in specs if s['field']=='time'),dict.fromkeys(repair.enhanced.TIME_MODES,24))
        for field, values in [('negated',('true','false')),('certainty',('reported','unknown'))]:
            self.assertEqual(Counter(s['expected'] for s in specs if s['field']==field),dict.fromkeys(values,48))
        with self.assertRaises(ValueError):repair.specs(3)

    def test_every_contrast_is_one_field_with_both_formats_and_both_polarities(self):
        for spec in repair.specs(4):
            with self.subTest(spec=spec):
                source=self.source_for(spec);saved=deepcopy(source);values=repair.project(source)
                self.assertEqual(source,saved);self.assertEqual(len(values),6)
                for encoding in ('pipe','object'):
                    block=[x for x in values if x[0]['encoding']==encoding]
                    state,normal,bad=block
                    a=json.loads(normal[0]['messages'][-1]['content']);b=json.loads(bad[0]['messages'][-1]['content'])
                    self.assertEqual(a['data']['events'],b['data']['events'])
                    diffs=[(i,k) for i,(x,y) in enumerate(zip(a['data']['draft'],b['data']['draft'])) for k in repair.event.FIELDS if x[k]!=y[k]]
                    self.assertEqual(len(diffs),1);self.assertEqual(diffs[0][1],spec['field'])
                    # Existing independent reverse-scan evaluator validates the new targets.
                    self.assertEqual(repair.event.review_target(a['data']),normal[1]['target'])
                    self.assertEqual(repair.event.review_target(b['data']),bad[1]['target'])
                    self.assertEqual(repair.event.parse_events(json.loads(state[0]['messages'][-1]['content'])['data']),state[1]['target']['facts'])
                    self.assertEqual(a['rules'],b['rules']);self.assertEqual(a['rules'],repair.REVIEW_RULE)
                    for req,ref,row in block:
                        self.assertNotIn(source['source_root_id'],str(req['messages']))
                        if req.get('pair_id'):self.assertNotIn(req['pair_id'],str(req['messages']))
                        self.assertEqual(row['messages'][:-1],req['messages'])
                        self.assertEqual(json.loads(row['messages'][-1]['content']),ref['target'])
                        self.assertEqual(row['loss_message_mask'],[0,0,1])

    def test_false_negative_flag_is_not_accepted_and_normal_order_is_irrelevant(self):
        for field in ('negated','certainty'):
            for spec in [s for s in repair.specs(4) if s['field']==field][:2]:
                values=repair.project(self.source_for(spec));normal=values[1];bad=values[2]
                data=json.loads(normal[0]['messages'][-1]['content'])['data'];data['draft'].reverse()
                self.assertEqual(repair.objective.oracle({'data':data},'event_review'),{'approved':True,'issues':[]})
                wrong=json.loads(bad[0]['messages'][-1]['content'])
                self.assertFalse(repair.objective.oracle(wrong,'event_review')['approved'])
                self.assertNotEqual(bad[1]['target']['issues'][0]['actual'],bad[1]['target']['issues'][0]['expected'])


if __name__=='__main__':unittest.main()
