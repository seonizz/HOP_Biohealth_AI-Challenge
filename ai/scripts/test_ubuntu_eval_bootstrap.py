import json
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import sys
import unittest
from unittest.mock import Mock, patch

import ubuntu_eval_bootstrap as bootstrap

GPU = 'GPU-12345678-1234-1234-1234-123456789abc'


class BootstrapScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'evaluations/job'; (self.root / 'code').mkdir(parents=True)

    def prepare_sources(self):
        sources = {}
        for relative in bootstrap.REQUIRED_FILES:
            path = self.root / relative
            path.write_text(json.dumps({'gpu_uuid': GPU}) if relative == 'protocol.json' else '# pinned test code\n')
            sources[relative] = bootstrap.file_sha(path)
        (self.root / 'SOURCE_SHA256.json').write_text(json.dumps(sources))
        return sources

    def test_sources_and_gpu_are_bound_without_importing_third_party_packages(self):
        sources = self.prepare_sources()
        actual, protocol = bootstrap.verify_sources(self.root, self.base)
        self.assertEqual(actual, sources); self.assertEqual(protocol['gpu_uuid'], GPU)
        (self.root / 'code/training_core.py').write_text('# changed')
        with self.assertRaisesRegex(RuntimeError, 'Bound source changed'):
            bootstrap.verify_sources(self.root, self.base)

    def test_missing_required_panel_module_or_protocol_binding_is_rejected(self):
        sources = self.prepare_sources(); sources.pop('code/ubuntu_role_panel.py')
        (self.root / 'SOURCE_SHA256.json').write_text(json.dumps(sources))
        with self.assertRaisesRegex(RuntimeError, 'Required source bindings'):
            bootstrap.verify_sources(self.root, self.base)

    def test_link_hardlink_and_path_escape_are_rejected(self):
        target = self.root / 'code/file.py'; target.write_text('test')
        linked = self.root / 'code/linked.py'; linked.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'canonical'):
            bootstrap.real_owned(linked, directory=False, base=self.base)
        linked.unlink(); os.link(target, linked)
        with self.assertRaisesRegex(RuntimeError, 'single-link'):
            bootstrap.real_owned(target, directory=False, base=self.base)
        with self.assertRaises(RuntimeError):
            bootstrap.real_owned(self.base.parent, base=self.base)

    def test_manifest_cannot_read_outside_the_hop_tree(self):
        sources = self.prepare_sources(); sources['../outside.py'] = 'a' * 64
        (self.root / 'SOURCE_SHA256.json').write_text(json.dumps(sources))
        with self.assertRaisesRegex(RuntimeError, 'Unsafe source binding'):
            bootstrap.verify_sources(self.root, self.base)

    def test_fresh_runtime_and_all_cache_paths_are_inside_selected_work(self):
        work = self.root / 'work'; work.mkdir()
        with patch.dict(os.environ, {}, clear=False):
            paths = bootstrap.configure_environment(work, GPU, base=self.base)
            self.assertTrue(all(Path(path).is_relative_to(work) for path in paths.values()))
            self.assertEqual(os.environ['CUDA_VISIBLE_DEVICES'], GPU)
            self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')
            self.assertEqual(os.environ['PYTORCH_ALLOC_CONF'], 'expandable_segments:True')
            with self.assertRaisesRegex(RuntimeError, 'empty runtime'):
                bootstrap.configure_environment(work, GPU, base=self.base)

    def test_atomic_report_never_truncates_a_preexisting_hardlinked_temporary(self):
        external = self.base / 'preserved'; external.write_text('preserve this inode')
        temporary = self.root / 'report.json.tmp'; os.link(external, temporary)
        with self.assertRaises(FileExistsError):
            bootstrap.atomic(self.root / 'report.json', {'status': 'new'})
        self.assertEqual(external.read_text(), 'preserve this inode')
        self.assertFalse((self.root / 'report.json').exists())

    def test_compatibility_requires_both_source_and_binary_hashes_and_fixed_sink(self):
        sources = self.prepare_sources()
        protocol = {'gpu_uuid': GPU, 'cuda_thread_name_compat': {'library': 'code/ubuntu_cuda_name_compat.so'}}
        with self.assertRaisesRegex(RuntimeError, 'both be SHA-bound'):
            bootstrap.thread_name_compat(protocol, sources, self.root)
        sources.update({'code/ubuntu_cuda_name_compat.c': 'c' * 64, 'code/ubuntu_cuda_name_compat.so': 'd' * 64})
        proof = bootstrap.thread_name_compat(protocol, sources, self.root)
        self.assertEqual(proof['sink'], str(self.root / 'work/cuda-threadnames.log'))
        protocol['cuda_thread_name_compat']['sink'] = '/proc/self/comm'
        with self.assertRaisesRegex(RuntimeError, 'task-only library and sink'):
            bootstrap.thread_name_compat(protocol, sources, self.root)

    def test_child_environment_replaces_unknown_preloads_and_removes_them_without_opt_in(self):
        sources = {'code/ubuntu_cuda_name_compat.c': 'c' * 64, 'code/ubuntu_cuda_name_compat.so': 'd' * 64}
        protocol = {'cuda_thread_name_compat': {'library': 'code/ubuntu_cuda_name_compat.so'}}
        inherited = {'LD_PRELOAD': '/unknown/untrusted.so', 'HOP_CUDA_THREAD_NAME_SINK': '/outside', 'KEEP': 'yes'}
        environment = bootstrap.worker_environment(protocol, sources, self.root, inherited)
        self.assertEqual(environment['LD_PRELOAD'], str(self.root / 'code/ubuntu_cuda_name_compat.so'))
        self.assertEqual(environment['HOP_CUDA_THREAD_NAME_SINK'], str(self.root / 'work/cuda-threadnames.log'))
        self.assertEqual(environment['KEEP'], 'yes')
        environment = bootstrap.worker_environment({}, sources, self.root, inherited)
        self.assertNotIn('LD_PRELOAD', environment); self.assertNotIn('HOP_CUDA_THREAD_NAME_SINK', environment)

    def test_optional_compatibility_artifacts_are_verified_as_source_files(self):
        sources = self.prepare_sources()
        for relative in ('code/ubuntu_cuda_name_compat.c', 'code/ubuntu_cuda_name_compat.so'):
            path = self.root / relative; path.write_bytes(b'bound compatibility artifact')
            sources[relative] = bootstrap.file_sha(path)
        protocol = {'gpu_uuid': GPU, 'cuda_thread_name_compat': {'library': 'code/ubuntu_cuda_name_compat.so'}}
        (self.root / 'protocol.json').write_text(json.dumps(protocol))
        sources['protocol.json'] = bootstrap.file_sha(self.root / 'protocol.json')
        (self.root / 'SOURCE_SHA256.json').write_text(json.dumps(sources))
        bootstrap.verify_sources(self.root, self.base)
        (self.root / 'code/ubuntu_cuda_name_compat.so').write_bytes(b'tampered library')
        with self.assertRaisesRegex(RuntimeError, 'Bound source changed'):
            bootstrap.verify_sources(self.root, self.base)

    @unittest.skipUnless(shutil.which('cc'), 'Existing C compiler unavailable')
    def test_c_redirect_matches_only_exact_own_thread_path_and_write_only_mode(self):
        source = Path(bootstrap.__file__).with_name('ubuntu_cuda_name_compat.c')
        harness = self.root / 'compat-unit.c'
        harness.write_text('#include <assert.h>\n#include ' + json.dumps(str(source)) + '\n' + r'''
int main(int argc, char **argv) {
 assert(argc == 2);
 assert(is_own_thread_name_write("/proc/self/task/123/comm", "w"));
 assert(is_own_thread_name_write("/proc/self/task/456/comm", "wb"));
 assert(!is_own_thread_name_write("/proc/self/task/123/comm", "r"));
 assert(!is_own_thread_name_write("/proc/self/task/123/comm", "w+"));
 assert(!is_own_thread_name_write("/proc/42/task/123/comm", "w"));
 assert(!is_own_thread_name_write("/proc/self/comm", "w"));
 assert(!is_own_thread_name_write("/proc/self/task/../comm", "w"));
 assert(!is_own_thread_name_write("/proc/self/task/123/comm/extra", "w"));
 assert(!is_own_thread_name_write("/proc/self/task/123/status", "w"));
 assert(!is_own_thread_name_write("/tmp/comm", "w"));
 setenv("HOP_CUDA_THREAD_NAME_SINK", "/outside/unverified", 1);
 errno = 0;
 assert(fopen("/proc/self/task/123/comm", "w") == NULL);
 assert(errno == EPERM);
 FILE *ordinary = fopen(argv[1], "w");
 assert(ordinary != NULL);
 assert(fputs("ordinary file path remains unchanged", ordinary) >= 0);
 assert(fclose(ordinary) == 0);
 ordinary = fopen(argv[1], "r");
 assert(ordinary != NULL);
 char content[64] = {0};
 assert(fgets(content, sizeof(content), ordinary) != NULL);
 assert(strcmp(content, "ordinary file path remains unchanged") == 0);
 assert(fclose(ordinary) == 0);
 return 0;
}
''')
        command = [shutil.which('cc'), '-O2', '-o', str(self.root / 'compat-unit'), str(harness), '-pthread']
        if sys.platform.startswith('linux'):
            command.append('-ldl')
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([str(self.root / 'compat-unit'), str(self.root / 'ordinary.txt')], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_task_lock_is_read_only_and_inherited_by_identity(self):
        fd = bootstrap.acquire_task_lock(self.root, self.base)
        try:
            with patch.dict(os.environ, {'UBUNTU_EVAL_TASK_LOCK_FD': str(fd)}):
                self.assertEqual(bootstrap.verify_inherited_lock(self.root, self.base), fd)
            with self.assertRaises(OSError):
                os.write(fd, b'forbidden')
            with self.assertRaises(BlockingIOError):
                bootstrap.acquire_task_lock(self.root, self.base)
        finally:
            os.close(fd)

    def test_reject_existing_unowned_worker_lock_descriptor(self):
        with patch.dict(os.environ, {'UBUNTU_EVAL_TASK_LOCK_FD': ''}):
            with self.assertRaisesRegex(RuntimeError, 'inherit'):
                bootstrap.verify_inherited_lock(self.root, self.base)

    def test_mount_check_rejects_mounts_below_hop(self):
        bootstrap.check_mounts(self.base, mountinfo='1 2 0:1 / / rw - ext4 /dev/test rw\n')
        with self.assertRaisesRegex(RuntimeError, 'Mount inside'):
            bootstrap.check_mounts(self.base, mountinfo=f'1 2 0:1 / {self.base}/mounted rw - ext4 /dev/test rw\n')

    def test_supervisor_command_is_existing_isolated_runtime_and_worker_mode(self):
        command = bootstrap.worker_command(self.root, self.base / 'training/.venv')
        self.assertEqual(command[1:5], ['-I', '-S', '-B', '-u'])
        self.assertEqual(command[-1], '--worker')
        self.assertNotIn('ssh', command); self.assertNotIn('train.py', command)
        self.assertEqual(bootstrap.MAX_SECONDS, 96 * 60 * 60)

    def test_boundary_writes_only_the_selected_runtime_tree_with_four_devices(self):
        work = self.root / 'work'; work.mkdir()
        sandbox = Mock(return_value={'landlock_abi': 8})
        bootstrap.apply_boundary({'sandbox': sandbox}, work, work / 'BOUNDARY_PROOF.json')
        sandbox.assert_called_once_with(work, bootstrap.DEVICES)
        self.assertEqual(bootstrap.DEVICES, ['/dev/null', '/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm'])
        result = json.loads((work / 'BOUNDARY_PROOF.json').read_text())
        self.assertEqual(result['writable_regular_tree'], str(work))

    def test_gpu_telemetry_selects_only_the_pinned_gpu_without_cuda_imports(self):
        outputs = ['0, ' + GPU + ', 250, 16000, 5\n1, GPU-other, 500, 15000, 0\n',
                   'GPU-other, 200\n']
        mock = Mock(side_effect=outputs)
        state = bootstrap.gpu_snapshot(GPU, runner=mock)
        self.assertEqual(state['memory_used_mib'], 250); self.assertEqual(state['compute_pids'], [])
        self.assertEqual(mock.call_count, 2)
        self.assertTrue(all(call.args[0][0] == 'nvidia-smi' for call in mock.call_args_list))

    def test_owned_process_only_gets_graceful_termination_then_bounded_kill(self):
        process = Mock(); process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('owned-worker', 1), 0]
        result = bootstrap.stop_owned(process, grace=1)
        process.terminate.assert_called_once(); process.kill.assert_called_once()
        self.assertEqual(result, {'terminated': True, 'killed': True})


if __name__ == '__main__':
    unittest.main()
