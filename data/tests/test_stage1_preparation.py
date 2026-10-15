"""Fail-closed operational boundaries, without torch/model dependencies."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import stage1_preparation as prep


class PreparationBoundaries(unittest.TestCase):
    def test_path_resolution_blocks_symlink_escape(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            root = Path(a); (root/'escape').symlink_to(b, target_is_directory=True)
            with self.assertRaises(ValueError): prep.beneath(root/'escape/out.json', root)
            with self.assertRaises(ValueError): prep.beneath(root, root)
            self.assertEqual(prep.beneath(root/'inside', root), (root/'inside').resolve())

    def test_file_manifest_detects_changed_and_extra_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('scripts','counseling_pipeline'): (root/name).mkdir()
            source = root/'scripts/start.py'; source.write_text('pass\n')
            manifest = {'schema_version':'malssi.training-kit-files.v1','files':{'scripts/start.py':{'bytes':source.stat().st_size,'sha256':prep.sha_file(source)}}}
            (root/'MANIFEST.json').write_text(json.dumps(manifest))
            prep.verify_bundle(root)
            extra = root/'scripts/extra.py'; extra.write_text('pass\n')
            with self.assertRaises(ValueError): prep.verify_bundle(root)
            extra.unlink(); source.write_text('boom\n')
            with self.assertRaises(ValueError): prep.verify_bundle(root)

    def test_gpu_in_use_and_busy_graphics_fail_without_switching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(prep,'AUTHORIZED_ROOT',root):
                with patch.object(prep.subprocess,'check_output',return_value=prep.GPU_UUID+', 99\n'):
                    with self.assertRaises(ValueError): prep.gpu_lock(root)
                responses = ['', prep.GPU_UUID+', 1024, 0\n']
                with patch.object(prep.subprocess,'check_output',side_effect=responses):
                    with self.assertRaises(ValueError): prep.gpu_lock(root)
                with patch.object(prep.subprocess,'check_output',side_effect=['',prep.GPU_UUID+', 11, 0\n']):
                    handle = prep.gpu_lock(root); handle.close()

    def test_json_digest_and_report_refuse_nan(self):
        with self.assertRaises(ValueError): prep.digest({'loss':float('nan')})


if __name__ == '__main__': unittest.main()
