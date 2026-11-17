from copy import deepcopy
import json
from pathlib import Path
import struct
import tempfile
import unittest

import prepare_local12b_training as p


class CharacterTokenizer:
    def apply_chat_template(self,*args,**kwargs):return 'prefix:'
    def encode(self,text,**kwargs):return [ord(char) for char in text]
    def decode(self,ids,**kwargs):return ''.join(chr(i) for i in ids)


class AdmissionTests(unittest.TestCase):
    def row(self):
        target='{"approved":true}'
        return dict(row_id='fixture',request_id='fixture',task='answer_review',split='train',
            source_root_ids=['fixture'],source_group_ids=['fixture'],weight=dict(numerator=1,denominator=1),
            loss_message_mask=[0,0,1],target_sha256=p.hashlib.sha256(target.encode()).hexdigest(),
            messages=[dict(role='system',content='Schema fixture'),dict(role='user',content='Fixture input'),dict(role='assistant',content=target)])

    def test_uint32_storage_is_little_endian(self):
        self.assertEqual(p.pack([1,256,65536]),struct.pack('<III',1,256,65536))

    def test_independent_prefix_target_boundary_includes_eot(self):
        ids,boundary=p.independent_encode(self.row(),CharacterTokenizer())
        self.assertEqual(boundary,len('prefix:'))
        self.assertEqual(CharacterTokenizer().decode(ids[boundary:]),'{"approved":true}<turn|>\n')

    def test_unstable_prefix_is_rejected(self):
        class Bad(CharacterTokenizer):
            def encode(self,text,**kwargs):
                values=super().encode(text)
                if len(text)>len('prefix:'):values[0]+=1
                return values
        with self.assertRaisesRegex(ValueError,'prefix/context'):p.independent_encode(self.row(),Bad())

    def test_bad_decode_is_rejected(self):
        class Bad(CharacterTokenizer):
            def decode(self,ids,**kwargs):return 'wrong'
        with self.assertRaisesRegex(ValueError,'decode'):p.independent_encode(self.row(),Bad())

    def test_overlength_is_rejected_without_truncation(self):
        row=self.row();row['messages'][-1]['content']='x'*32768
        with self.assertRaisesRegex(ValueError,'prefix/context'):p.independent_encode(row,CharacterTokenizer())

    def test_patch_requires_exact_source_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'data').mkdir();row=self.row()
            p.rewrite_rows(root/'data/train.jsonl',[row])
            patch=dict(row_id='fixture',original_row_sha256='wrong',patched_row=deepcopy(row))
            with self.assertRaisesRegex(ValueError,'Patch source changed'):p.apply_patches(root,[patch])

    def test_patch_cannot_move_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'data').mkdir();row=self.row()
            p.rewrite_rows(root/'data/train.jsonl',[row]);updated=deepcopy(row);updated['split']='validation'
            patch=dict(row_id='fixture',original_row_sha256=p.app.digest(row),patched_row=updated)
            with self.assertRaisesRegex(ValueError,'identity/split'):p.apply_patches(root,[patch])

    def test_pending_course_never_verifies_as_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            p.d.save(root/'COURSE.json',dict(training_ready=False,training_started=False))
            p.d.save(root/'MANIFEST.json',dict(schema=p.VERSION,files=p.inventory(root)))
            with self.assertRaisesRegex(ValueError,'admission state'):p.verify(root)

    def test_missing_semantic_task_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'MANIFEST.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'Missing independent'):p.semantic_check({},root,root)


if __name__=='__main__':unittest.main()
