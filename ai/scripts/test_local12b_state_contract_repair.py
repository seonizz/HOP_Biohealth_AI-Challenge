import json
from collections import Counter
from copy import deepcopy
import unittest
import tempfile
from pathlib import Path
import local12b_state_contract_repair as repair

class StateContractTests(unittest.TestCase):
    def fixture(self,spec,number=1):
        history=repair.source(repair.SEED,number,spec)
        return dict(source_root_id='private-root-'+str(number),events=history,number=number,seed=repair.SEED,contrast=spec,split='validation')

    def test_all_fields_directions_and_repair_examples_preserve_independent_truth(self):
        for number,spec in enumerate(repair.previous.specs(4),1):
            with self.subTest(spec=spec):
                src=self.fixture(spec,number);saved=deepcopy(src);records=repair.project(src)
                self.assertEqual(saved,src);self.assertEqual(len(records),8)
                self.assertEqual(Counter(x[0]['task'] for x in records),{'event_state':4,'event_review':4})
                for req,ref,row in records:
                    payload=json.loads(req['messages'][-1]['content'])
                    self.assertEqual(repair.o.oracle(payload,req['task']),ref['target'])
                    self.assertEqual(row['messages'][:-1],req['messages'])
                    self.assertEqual(json.loads(row['messages'][-1]['content']),ref['target'])
                    if req['task']=='event_state':
                        facts=ref['target']['facts'];schema=payload['output_schema']['properties']['facts']
                        self.assertEqual(schema['minItems'],len(facts));self.assertEqual(schema['maxItems'],len(facts))
                        self.assertEqual(len(set((f['person'],f['attribute']) for f in facts)),len(facts))
                        self.assertEqual(schema['items']['properties']['negated']['enum'],['true','false'])
                        self.assertEqual(schema['items']['properties']['certainty']['enum'],['reported','unknown'])
                        if req.get('repair_kind'):
                            self.assertGreater(len(payload['data']['previous_output']['facts']),len(facts))
                            self.assertEqual(row['loss_message_mask'],[0,0,1])

    def test_same_value_history_flips_both_flags_and_remains_ordered(self):
        for n,spec in enumerate(repair.previous.specs(4),1):
            history=self.fixture(spec,n)['events'];times=[int(f['time']) for f in history]
            self.assertEqual(times,sorted(set(times)))
            for field,values in [('negated',{'true','false'}),('certainty',{'reported','unknown'})]:
                group=history[-6:-3] if field=='negated' else history[-3:]
                self.assertEqual({f[field] for f in group},values)
                self.assertEqual(len({f['value'] for f in group}),1)
                self.assertEqual(group[0][field],group[-1][field])
                if spec['field']==field:self.assertEqual(group[-1][field],spec['expected'])

    def test_ids_are_unique_and_review_pair_order_has_both_decisions(self):
        records=repair.project(self.fixture(repair.previous.specs(4)[0]));ids=[r[0]['request_id'] for r in records]
        self.assertEqual(len(ids),len(set(ids)))
        for encoding in ('pipe','object'):
            reviews=[r for r in records if r[0]['task']=='event_review' and r[0]['encoding']==encoding]
            self.assertEqual({r[1]['target']['approved'] for r in reviews},{True,False})
            self.assertEqual(len({r[0]['pair_id'] for r in reviews}),1)

    def test_app_copies_are_independently_compared_with_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);root=base/'combined';old=base/'old';app=base/'app'
            for split in repair.QUOTAS:
                for domain,origin in [('app_generation',app),('app',old)]:
                    if domain=='app' and split=='test':continue
                    names=['inputs.jsonl','references.jsonl']+(['COVERAGE.json'] if domain=='app_generation' else [])
                    rels=[Path(f'evaluation/{domain}/{split}/{n}') for n in names]
                    if split!='test':rels.append(Path(f'data/{domain}/{split}.jsonl'))
                    for rel in rels:
                        for target in (root/rel,origin/rel):target.parent.mkdir(parents=True,exist_ok=True);target.write_text('{}\n')
            binding={'old_bundle':str(old),'app_bundle':str(app)}
            self.assertEqual(repair.verify_app_copies(root,binding),17)
            for rel in ['evaluation/app_generation/test/references.jsonl','evaluation/app/validation/inputs.jsonl','data/app_generation/train.jsonl']:
                target=root/rel;target.write_text('{"tampered":true}\n')
                with self.assertRaisesRegex(ValueError,'Copied'):repair.verify_app_copies(root,binding)
                target.write_text('{}\n')


if __name__=='__main__':unittest.main()
