"""Output mutation must invalidate the semantic judgment of that exact output."""
from pathlib import Path
import tempfile
import unittest
import role_dataset as d
from role_evaluation_data import judged_output_hashes


class JudgedOutputsTests(unittest.TestCase):
    def test_response_changed_under_same_checkpoint_requires_new_judgment(self):
        with tempfile.TemporaryDirectory() as temp:
            files={variant:Path(temp)/(variant+'.json') for variant in ('candidate','baseline')}
            for path in files.values():d.save(path,{'checkpoint_sha256':'a'*64,'response':'Original evaluated response'})
            judgments={'outputs_sha256':{v:d.file_hash(p) for v,p in files.items()}}
            self.assertEqual(judged_output_hashes(judgments,files),judgments['outputs_sha256'])
            d.save(files['candidate'],{'checkpoint_sha256':'a'*64,'response':'Changed after the judge read it'})
            with self.assertRaisesRegex(ValueError,'independently judged'):judged_output_hashes(judgments,files)

    def test_unfilled_hashes_cannot_approve_output(self):
        with self.assertRaisesRegex(ValueError,'Missing judged'):
            judged_output_hashes({'outputs_sha256':{'candidate':None,'baseline':None}},
                                 {'candidate':Path('unused'),'baseline':Path('unused')})


if __name__=='__main__':unittest.main()
