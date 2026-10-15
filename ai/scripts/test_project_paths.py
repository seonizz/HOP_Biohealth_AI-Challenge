"""Exercise the integrated project layout using temporary source snapshots."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import apply_relationship_backend as applying
from handoff import configure_local
import package_project_handoff as packaging


class ProjectLayoutTests(unittest.TestCase):
    def test_apply_patch_preserves_canonical_backend_docs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ai, app = root / 'ai', root / 'app'
            overlay = ai / 'local_api/backend_patch'
            for name in applying.FILES:
                source = overlay / name
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text('fixture source')
            config = ai / 'local_api/runtime/config.json'
            config.parent.mkdir(parents=True)
            config.write_text(json.dumps({'model': 'gemma4:12b', 'ollama_url': 'http://127.0.0.1:11434', 'api_key': 'fixture-key'}))
            (app / 'docs').mkdir(parents=True)
            (app / '.env').write_text('PORT=9000\n')
            for relative in ['README.md', 'docs/RELATIONSHIP_AGENT.md']:
                (app / relative).write_text('canonical documentation')
                self.assertNotIn(relative, applying.FILES)
            with patch.object(applying, 'ROOT', ai), patch.object(applying, 'BACKEND', app), \
                    patch.object(applying, 'PATCH', overlay), contextlib.redirect_stdout(io.StringIO()):
                applying.main()
            self.assertEqual((app / 'src/server.js').read_text(), 'fixture source')
            for relative in ['README.md', 'docs/RELATIONSHIP_AGENT.md']:
                self.assertEqual((app / relative).read_text(), 'canonical documentation')

    def test_package_root_discovers_integrated_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'app').mkdir()
            (root / 'ai/scripts/handoff').mkdir(parents=True)
            self.assertEqual(configure_local.package_root(str(root)), root)
            with patch.object(configure_local, '__file__', str(root / 'ai/scripts/handoff/configure_local.py')):
                self.assertEqual(configure_local.package_root(None), root)

    def test_configuration_uses_app_and_ai_and_preserves_existing_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'app/scripts').mkdir(parents=True)
            (root / 'app/scripts/setup.js').write_text('// fixture')
            env = root / 'app/.env'
            env.write_text('MODEL_NAME=custom-model\nMODEL_API_KEY=fixture-key\n')
            with patch.object(configure_local.shutil, 'which', return_value='/fixture/node'), \
                    patch.object(configure_local.subprocess, 'run') as run:
                run.return_value.returncode = 0
                configure_local.configure(root)
            self.assertEqual(run.call_args.kwargs['cwd'], root / 'app')
            config = json.loads((root / 'ai/local_api/runtime/config.json').read_text())
            self.assertEqual(config['model'], 'custom-model')
            self.assertEqual(config['api_key'], 'fixture-key')
            self.assertIn('MODEL_DOCKER_BASE_URL=', env.read_text())

    def test_handoff_archive_uses_integrated_layout_and_excludes_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ai, app = root / 'ai', root / 'app'
            fixtures = {
                'README.md': '# Project\n[App](app/README.md) · [Data](data/README.md) · [External](https://example.com/docs)\n',
                'docs/README.md': '# Shared docs\n[Status](current/현황과_할일.md)\n',
                'docs/current/현황과_할일.md': '# Canonical current status\nCurrent fixture status\n[Evidence](../../ai/outputs/evidence.json)\n',
                'docs/current/실행과_검증.md': '# Running\n[App](../../app/README.md)\n',
                'docs/current/데이터와_연구.md': '# Research\n[Source data][dataset]\n\n[dataset]: ../../data/README.md\n',
                'data/README.md': '# Omitted data',
                'app/README.md': '# App',
                'app/src/server.js': '// current server',
                'app/.env': 'MODEL_API_KEY=fixture-private-secret',
                'app/weights/model.gguf': 'private model',
                'ai/.gitignore': 'runtime/',
                'ai/README.md': '# AI',
                'ai/local_api/backend_patch/src/server.js': '// pending server',
                'ai/local_api/runtime/config.json': '{"api_key": "fixture-private-secret"}',
                'ai/scripts/handoff/configure_local.py': '# setup fixture',
                'ai/서비스_문서/README.md': '# Reference',
            }
            for relative, content in fixtures.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            with patch.object(packaging, 'ROOT', ai), patch.object(packaging, 'BACKEND', app), \
                    patch.object(packaging, 'git', return_value='fixture-commit'), \
                    contextlib.redirect_stdout(io.StringIO()):
                packaging.main()
            archive, = (ai / 'outputs/handoff').glob('*.zip')
            with ZipFile(archive) as zipped:
                prefix = archive.stem + '/'
                names = {name.removeprefix(prefix) for name in zipped.namelist()}
                self.assertIn('app/src/server.js', names)
                self.assertIn('ai/scripts/handoff/configure_local.py', names)
                self.assertIn('ai/서비스_문서/README.md', names)
                self.assertIn('docs/README.md', names)
                self.assertIn('docs/current/현황과_할일.md', names)
                self.assertNotIn('data/README.md', names)
                self.assertNotIn('app/.env', names)
                self.assertNotIn('app/weights/model.gguf', names)
                self.assertNotIn('ai/local_api/runtime/config.json', names)
                pending = json.loads(zipped.read(prefix + 'PENDING_CHANGES.json'))
                self.assertEqual(pending['source'], 'ai/local_api/backend_patch')
                self.assertEqual(pending['target'], 'app')
                self.assertEqual(pending['different_files'], ['src/server.js'])
                manifest = json.loads(zipped.read(prefix + 'MANIFEST.json'))
                self.assertEqual(set(manifest['source_commits']), {'app', 'ai'})
                self.assertEqual(manifest['scope'], ['app', 'ai'])
                shared = zipped.read(prefix + 'README.md').decode()
                self.assertIn('[App](app/README.md)', shared)
                self.assertIn('Data (원본 프로젝트 경로: `data/README.md`)', shared)
                self.assertIn('[External](https://example.com/docs)', shared)
                status = zipped.read(prefix + 'docs/current/현황과_할일.md').decode()
                self.assertIn('Current fixture status', status)
                self.assertIn('Evidence (원본 프로젝트 경로: `ai/outputs/evidence.json`)', status)
                research = zipped.read(prefix + 'docs/current/데이터와_연구.md').decode()
                self.assertIn('Source data (원본 프로젝트 경로: `data/README.md`)', research)
                self.assertNotIn('[dataset]:', research)
                instructions = zipped.read(prefix + 'START_HERE.md').decode()
                self.assertIn('cd app', instructions)
                self.assertIn('[현재 상태와 할 일](docs/current/현황과_할일.md)', instructions)
                for stale in ['229/229', '239/239', 'relationship-v3.5-rag', '사용자의 `ok`', '29개 답변']:
                    self.assertNotIn(stale, instructions)
                self.assertNotIn('HOP_backend', instructions)
                self.assertNotIn('HOP_agent', instructions)
            self.assertIn('[Data](data/README.md)', (root / 'README.md').read_text())

    def test_document_links_handle_encoded_paths_and_leave_code_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project, destination = root / 'source', root / 'package'
            (destination / 'docs').mkdir(parents=True)
            (destination / 'app').mkdir()
            (destination / 'app/README.md').write_text('# App')
            path = destination / 'docs/README.md'
            path.write_text(
                '[Missing](<../data/a%20b.md#section>)\n'
                f'[Absolute](<{project}/app/README.md>)\n'
                '[Anchor](#section)\n'
                '[`Code label`](../data/code.md)\n'
                '[First](../data/first.md)[Second](../data/second.md)\n'
                '```md\n[Code](missing.md)\n```\n'
                '`[Inline code](missing.md)`\n'
            )
            packaging.normalize_document_links(destination, project)
            result = path.read_text()
            self.assertIn('Missing (원본 프로젝트 경로: `data/a b.md`)', result)
            self.assertIn('[Absolute](<../app/README.md>)', result)
            self.assertIn('[Anchor](#section)', result)
            self.assertIn('`Code label` (원본 프로젝트 경로: `data/code.md`)', result)
            self.assertIn('First (원본 프로젝트 경로: `data/first.md`)Second (원본 프로젝트 경로: `data/second.md`)', result)
            self.assertIn('[Code](missing.md)', result)
            self.assertIn('`[Inline code](missing.md)`', result)


if __name__ == '__main__':
    unittest.main()
