import json
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy
import shutil
import controlled_auto_panel as panel_module
import run_paired_role_evaluation as collector
import report_controlled_auto_evaluation as report


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def write_rows(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(''.join(report.canonical(v) + '\n' for v in values))


def fixture(root):
    panel = root / 'panel'; manifest = panel_module.build(panel)
    suite, assignments = collector.load_suite(panel)
    source_bytes = Path(panel_module.__file__).read_bytes(); source_hash = report.sha(source_bytes)
    validation = panel / 'validation'; validation.mkdir()
    (validation / 'generator-before-comparison-fix.py').write_bytes(source_bytes)
    (validation / 'scorer-final-source.py').write_bytes(source_bytes)
    write(validation / 'VERIFICATION.json', {'unit_tests_status': 'passed', 'unit_tests': 23,
        'frozen_visible_input_gold_roundtrips': 240, 'original_generation_source_sha256': source_hash, 'scoring_source_sha256': source_hash})
    write(validation / 'SCORING_REVISION.json', {'original_generator_sha256': source_hash, 'current_scorer_sha256': source_hash,
        'frozen_input_gold_suite_unchanged': True, 'original_file_hashes': manifest['files'], 'scorer_version': panel_module.SCORER_VERSION})
    (root / 'plan.md').write_text('Synthetic test plan only\n')
    options = {'temperature': 0, 'seed': 3407, 'cache_prompt': False, 'stream': False, 'max_tokens': 1024}
    protocol = {'fixed_total_requests': 480, 'full_flow_assigned_cases': 12, 'plan_sha256': report.sha((root / 'plan.md').read_bytes()),
                'fixed_generation_options': options, 'base_sha256': 'b' * 64, 'adapter_sha256': 'a' * 64}
    write(root / 'protocol.json', protocol)
    write(root / 'design-coverage-audit.json', {'cases': 30, 'root_lineages': 6, 'frozen_panel_changed': False,
        's2_correct_candidate_index_counts': {'1': 30}, 's8_observed_state_combinations': {'current|yes': 10, 'past|no': 10, 'unknown|unknown': 10}})
    run = root / 'fixed-run'; run.mkdir()
    gold = {k: v for ref in panel_module.read_rows(panel / 'REFERENCES.jsonl') for k, v in ref['gold_by_request'].items()}
    outputs, attempts, judgments, failed_once = [], [], [], False
    for index, assigned in enumerate(assignments, 1):
        g = gold[assigned['request_id']]; slot = g['slot']
        if slot == 'S1': value = {'skip': [{'question_id': q, 'reason': label} for q, label in g['labels'].items() if label != 'retain']}
        elif slot == 'S2': value = {'question_id': g['selected']}
        elif slot in ('S3', 'S4'): value = {'facts': g['facts']}
        elif slot == 'S5': value = {'slots': g['slots']}
        elif slot in ('S6', 'S7'): value = {'approved': not g['error_present'], 'issues': g['issues']}
        else: value = {'label': g['label']}
        failed = not failed_once and slot == 'S4' and assigned['arm'] == 'baseline'
        failed_once |= failed
        text = None if failed else panel_module.canonical(value)
        raw = b'{"error":"synthetic failure"}' if failed else json.dumps({'choices': [{'message': {'content': text}}]}).encode()
        payload = dict(options, messages=assigned['request']['messages'], model='mock', lora=[{'id': 0, 'scale': 0 if assigned['arm'] == 'baseline' else 1}])
        body = panel_module.canonical(payload).encode(); identifier = f'{index:06d}'; directory = run / 'http' / identifier; directory.mkdir(parents=True)
        (directory / 'request.json').write_bytes(body); (directory / 'response.bin').write_bytes(raw)
        write(directory / 'response-meta.json', {'status': 503 if failed else 200, 'sha256': report.sha(raw)})
        record = {k: v for k, v in assigned.items() if k != 'request'}
        record.update(attempt_id=identifier, request_body_sha256=report.sha(body), response_sha256=report.sha(raw),
                      execution_status='failed' if failed else 'output_received', text=text, completed_at='2026-11-11T15:01:00+00:00')
        outputs.append(record); attempts.extend([dict(record, event='started'), dict(record, event='completed')])
        judgments.append({k: assigned[k] for k in ('arm', 'request_id', 'case_id', 'source_group_id', 'task', 'output_stage')} | {
            'schema_valid': not failed, 'execution_status': record['execution_status']})
    write_rows(run / 'assignments.jsonl', assignments); write_rows(run / 'outputs.jsonl', outputs); write_rows(run / 'attempts.jsonl', attempts)
    write(run / 'metadata.json', {'suite_sha256': panel_module.digest(suite), 'suite_file_sha256': manifest['files'],
        'base_model_sha256': protocol['base_sha256'], 'adapter_sha256': protocol['adapter_sha256'], 'options': options, 'retry_policy': 'none'})
    write(run / 'summary.json', {'status': 'completed', 'arms': {arm: {'assigned_count': 240,
        'received_count': sum(r['arm'] == arm and r['execution_status'] == 'output_received' for r in outputs),
        'failed_count': sum(r['arm'] == arm and r['execution_status'] == 'failed' for r in outputs), 'not_run_count': 0} for arm in report.ARMS}})
    metrics = []
    for task in sorted({a['task'] for a in assignments}):
        for arm in report.ARMS:
            selected = [j for j in judgments if j['arm'] == arm and j['task'] == task]; numerator = sum(j['schema_valid'] for j in selected)
            metrics.append({'task': task, 'arm': arm, 'numerator': numerator, 'denominator': 30, 'value': numerator / 30})
    write(run / 'format-metrics.json', {'judgments': judgments, 'metrics': metrics})
    panel_module.score(panel, run)
    frozen, full = root / 'full-flow', root / 'full-flow-run'; frozen.mkdir(); full.mkdir()
    fake_app = root / 'frozen-source/app/src/model.js'; fake_app.parent.mkdir(parents=True); fake_app.write_bytes(b'mock app source')
    fake_collector = root / 'frozen-source/ai/scripts/run_controlled_full_flow.mjs'; fake_collector.parent.mkdir(parents=True); fake_collector.write_bytes(b'mock flow collector')
    files = [{'path': 'src/model.js', 'sha256': report.sha(fake_app.read_bytes())}]
    flow_assignments = []
    fixtures = [{'case_id': f'case-{i}'} for i in range(6)]
    for i in range(6):
        context = {'synthetic': True, 'case': i}
        for arm in report.ARMS:
            flow_assignments.append({'arm': arm, 'case_id': f'case-{i}', 'logical_case_id': f'{arm}:case-{i}',
                'root_lineage_id': f'root-{i}', 'context': context, 'context_sha256': report.js_digest(context)})
    wire = {'max_tokens': 8192}; profile = {'timeoutMs': 900000}
    flow_protocol = {'assignments_sha256': report.js_digest(flow_assignments), 'fixtures_sha256': report.js_digest(fixtures),
        'fixed_reviewer': {'lora_scale': 0}, 'source': {'files': files, 'sha256': report.js_digest(files)},
        'collector_sha256': report.sha(fake_collector.read_bytes()), 'wire': wire, 'profile': profile}
    write(frozen / 'fixtures.json', fixtures); write(frozen / 'assignments.json', flow_assignments); write(frozen / 'protocol.json', flow_protocol)
    write(full / 'assignments.json', flow_assignments)
    write(full / 'metadata.json', {'protocol_sha256': report.js_digest(flow_protocol), 'collector_sha256': flow_protocol['collector_sha256'],
        'base_sha256': protocol['base_sha256'], 'adapter_sha256': protocol['adapter_sha256'], 'wire': wire, 'profile': profile})
    full_results = []
    for i, assigned in enumerate(flow_assignments):
        directory = full / assigned['logical_case_id'].replace(':', '-'); directory.mkdir()
        auxiliary = {identifier: {'status': 'unobserved', 'value': None} for identifier in ('A14', 'A15', 'A16', 'A18')}
        auxiliary['A16']['any_observed_known_violation_count'] = 1 if i == 0 else 0
        auxiliary['partial_discoveries'] = {'snapshot_count': 1 if i == 0 else 0}
        record = {k: v for k, v in assigned.items() if k != 'context'} | {'status': 'failed', 'm02_complete': False,
            'completed_at': '2026-11-11T15:02:00+00:00', 'actual_posts': 0, 'stages': [], 'auxiliary': auxiliary}
        if i == 0:
            http = directory / 'http/000001'; http.mkdir(parents=True)
            payload = {'temperature': 0, 'seed': 3407, 'cache_prompt': False, 'max_tokens': 8192, 'lora': [{'id': 0, 'scale': 0}]}
            request_bytes = json.dumps(payload).encode(); raw = b'{"error":"synthetic flow rejection"}'
            (http / 'request.json').write_bytes(request_bytes); (http / 'response.bin').write_bytes(raw)
            event = {'attempt_id': '000001', 'event': 'completed', 'request_sha256': report.sha(request_bytes),
                'raw_response_sha256': report.sha(raw), 'role': 'reviewer', 'lora': payload['lora'], 'actual_post': True}
            write(http / 'response-meta.json', event); write_rows(directory / 'http-events.jsonl', [dict(event, event='queued'), event])
            record['actual_posts'] = 1
        write(directory / 'result.json', record); full_results.append(record)
    write_rows(full / 'results.jsonl', full_results)
    write(full / 'summary.json', {'status': 'completed', 'assigned_count': 12, 'completed_case_count': 12, 'not_run_count': 0,
        'actual_posts': 1, 'results': full_results, 'M02': {'by_arm': {arm: {'denominator': 6, 'numerator': 0, 'value': 0,
        'not_run_count': 0, 'failed_count': 6} for arm in report.ARMS}}})
    return root


class ReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._template = tempfile.TemporaryDirectory()
        cls.template = fixture(Path(cls._template.name))

    @classmethod
    def tearDownClass(cls):
        cls._template.cleanup()

    def setUp(self):
        import shutil
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / 'run'
        shutil.copytree(self.template, self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_complete_report_reproducible_with_failures_and_twenty_scoped_metrics(self):
        result = report.build_report(self.root)
        before = {name: (self.root / name).read_bytes() for name in result['generated_files']}
        report.build_report(self.root)
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in result['generated_files']})
        data = report.read(self.root / 'all-metrics.json')
        self.assertEqual(len(data['metrics']), 20); self.assertTrue(data['automatic_panel_complete'])
        m01 = next(m for m in data['metrics'] if m['metric_id'] == 'M01')
        s4 = next(v for v in m01['variants'] if v['metric_variant'] == 'S4')
        self.assertEqual(s4['per_arm']['baseline']['denominator'], 30); self.assertEqual(s4['per_arm']['baseline']['numerator'], 29)
        m02 = next(m for m in data['metrics'] if m['metric_id'] == 'M02')['variants'][0]
        self.assertEqual(m02['per_arm']['baseline']['denominator'], 6); self.assertEqual(m02['per_arm']['baseline']['failed_count'], 6)
        a16 = next(m for m in data['auxiliary_metrics'] if m['metric_id'] == 'A16')
        self.assertEqual(a16['per_arm']['baseline']['any_observed_known_violation_count'], 1)
        self.assertEqual(a16['per_arm']['baseline']['coverage']['value'], 0)
        self.assertIn('2026-11-12 00:02:00 KST', (self.root / 'REPORT.md').read_text())

    def enable_resume(self):
        old_root = Path(self.tmp.name) / 'original'
        shutil.copytree(self.root, old_root)
        original = (old_root / 'full-flow-run').resolve()
        old_results = report.rows(original / 'results.jsonl')[:9]
        for row in old_results:
            row['error'] = 'MODEL_TIMEOUT'; row['reason'] = 'deadline'
            write(original / row['logical_case_id'].replace(':', '-') / 'result.json', row)
        write_rows(original / 'results.jsonl', old_results)
        old_summary = report.read(original / 'summary.json')
        old_summary.update(status='paused_by_user', completed_case_count=9, not_run_count=3,
                           results=old_results, actual_posts=sum(row['actual_posts'] for row in old_results))
        write(original / 'summary.json', old_summary)
        assignments = report.read(original / 'assignments.json')
        # One of the three remaining cases had an unfinished earlier attempt.
        interrupted = assignments[9]['logical_case_id'].replace(':', '-')
        folder = original / interrupted
        for path in folder.iterdir():
            if path.is_dir(): shutil.rmtree(path)
            else: path.unlink()
        event = {'event': 'queued', 'attempt_id': 'unfinished-1', 'actual_post': False}
        write_rows(folder / 'http-events.jsonl', [event])
        (folder / 'request-only.json').write_bytes(b'original interrupted request evidence')
        for assignment in assignments[10:]:
            shutil.rmtree(original / assignment['logical_case_id'].replace(':', '-'))
        for row in old_results:
            relative = row['logical_case_id'].replace(':', '-')
            shutil.rmtree(self.root / 'full-flow-run' / relative)
            shutil.copytree(original / relative, self.root / 'full-flow-run' / relative)
        new_results = old_results + report.rows(self.root / 'full-flow-run/results.jsonl')[9:]
        write_rows(self.root / 'full-flow-run/results.jsonl', new_results)
        summary = report.read(self.root / 'full-flow-run/summary.json'); summary['results'] = new_results
        write(self.root / 'full-flow-run/summary.json', summary)
        old_protocol = report.read(old_root / 'full-flow/protocol.json')
        binding = {'run_directory': str(original), 'protocol_sha256': report.js_digest(old_protocol),
                   'collector_sha256': old_protocol['collector_sha256'],
                   'results_file_sha256': report.sha((original / 'results.jsonl').read_bytes()),
                   'terminal_count': 9, 'terminal_logical_ids': [row['logical_case_id'] for row in old_results],
                   'source_sha256': old_protocol['source']['sha256'],
                   'terminal_file_manifest': report.resume_tree_manifest(original, [row['logical_case_id'] for row in old_results])}
        collector = self.root / 'frozen-source/ai/scripts/run_controlled_full_flow.mjs'
        collector.write_bytes(b'new explicit resume collector')
        protocol = report.read(self.root / 'full-flow/protocol.json')
        protocol.update(resume_from=binding, collector_sha256=report.sha(collector.read_bytes()))
        write(self.root / 'full-flow/protocol.json', protocol)
        metadata = report.read(self.root / 'full-flow-run/metadata.json')
        metadata.update(resume_from=binding, protocol_sha256=report.js_digest(protocol), collector_sha256=protocol['collector_sha256'])
        write(self.root / 'full-flow-run/metadata.json', metadata)
        return original, binding

    def test_explicit_resume_preserves_nine_terminal_records_and_discloses_one_restart(self):
        original, binding = self.enable_resume()
        before = {str(path.relative_to(original)): path.read_bytes() for path in original.rglob('*') if path.is_file()}
        report.build_report(self.root)
        data = report.read(self.root / 'all-metrics.json')
        resume = data['full_flow_resume_provenance']
        self.assertEqual(resume['copied_terminal_count'], 9)
        self.assertEqual(resume['copied_terminal_error_counts'], {'MODEL_TIMEOUT': 9})
        self.assertEqual(resume['new_terminal_count'], 3)
        self.assertEqual(resume['restarted_interrupted_count'], 1)
        self.assertEqual(resume['prior_interrupted_records'][0]['unresolved_attempt_count'], 1)
        self.assertFalse(resume['prior_interrupted_posts_added_to_terminal_total'])
        self.assertEqual(resume['binding'], binding)
        self.assertEqual(before, {str(path.relative_to(original)): path.read_bytes() for path in original.rglob('*') if path.is_file()})
        m02 = next(row for row in data['metrics'] if row['metric_id'] == 'M02')['variants'][0]
        self.assertEqual([m02['per_arm'][arm]['denominator'] for arm in report.ARMS], [6, 6])
        text = (self.root / 'REPORT.md').read_text()
        self.assertIn('시간 초과(MODEL_TIMEOUT)는 9개', text)
        self.assertIn('나머지 3개', text)
        self.assertIn('중단된 1개', text)
        self.assertEqual(report.read(self.root / 'verification.json')['full_flow_resume_provenance'], resume)

    def test_resume_source_hash_mismatch_rejects_changed_prior_artifact(self):
        original, binding = self.enable_resume()
        relative = next(iter(binding['terminal_file_manifest']))
        (original / relative).write_bytes(b'prior evidence tampered')
        with self.assertRaisesRegex(ValueError, 'original terminal artifact manifest changed'):
            report.build_report(self.root)

    def test_resume_copied_raw_http_file_mismatch_is_rejected(self):
        original, binding = self.enable_resume()
        relative = next(iter(binding['terminal_file_manifest']))
        (self.root / 'full-flow-run' / relative).write_bytes(b'copied evidence tampered')
        with self.assertRaisesRegex(ValueError, 'copied terminal artifacts differ'):
            report.build_report(self.root)

    def test_resume_metadata_must_bind_the_same_provenance_object(self):
        self.enable_resume()
        path = self.root / 'full-flow-run/metadata.json'; metadata = report.read(path)
        metadata['resume_from']['results_file_sha256'] = '0' * 64; write(path, metadata)
        with self.assertRaisesRegex(ValueError, 'metadata/protocol provenance mismatch'):
            report.build_report(self.root)

    def test_resume_prior_model_or_generation_profile_cannot_change(self):
        original, binding = self.enable_resume()
        path = original / 'metadata.json'; metadata = report.read(path)
        metadata['base_sha256'] = 'c' * 64; write(path, metadata)
        with self.assertRaisesRegex(ValueError, 'original model hash mismatch'):
            report.build_report(self.root)

    def test_no_resume_report_has_no_resume_claims(self):
        report.build_report(self.root)
        self.assertNotIn('full_flow_resume_provenance', report.read(self.root / 'all-metrics.json'))
        self.assertNotIn('full_flow_resume_provenance', report.read(self.root / 'verification.json'))
        self.assertNotIn('전체 흐름 재개 이력', (self.root / 'REPORT.md').read_text())

    def test_policy_ci_suppressed_and_human_metrics_remain_null(self):
        report.build_report(self.root); data = report.read(self.root / 'all-metrics.json')
        for identifier in ('M12', 'M13'):
            comparison = next(m for m in data['metrics'] if m['metric_id'] == identifier)['variants'][0]['comparison']
            self.assertIsNone(comparison['ci95']); self.assertIn('source_scorer_ci95', comparison)
        for identifier in report.HUMAN_IDS + ('M19', 'M20'):
            self.assertIsNone(next(m for m in data['metrics'] if m['metric_id'] == identifier)['value'])

    def test_tampered_raw_response_blocks_report(self):
        (self.root / 'fixed-run/http/000001/response.bin').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'Raw response hash'): report.build_report(self.root)
        self.assertFalse((self.root / 'REPORT.md').exists())

    def test_deleted_assignment_cannot_shrink_denominator(self):
        path = self.root / 'fixed-run/assignments.jsonl'; values = report.rows(path); values.pop(); write_rows(path, values)
        with self.assertRaisesRegex(ValueError, 'assignment inventory'): report.build_report(self.root)

    def test_frozen_message_change_rejected_even_with_rebound_wire_hashes(self):
        path = self.root / 'fixed-run/http/000001/request.json'; body = report.read(path); body['messages'] = [{'role': 'user', 'content': 'different'}]
        request_bytes = json.dumps(body).encode(); path.write_bytes(request_bytes); changed = report.sha(request_bytes)
        for name in ('outputs.jsonl', 'attempts.jsonl'):
            p = self.root / 'fixed-run' / name; values = report.rows(p)
            for value in values:
                if value['attempt_id'] == '000001': value['request_body_sha256'] = changed
            write_rows(p, values)
        with self.assertRaisesRegex(ValueError, 'inference input change'): report.build_report(self.root)


if __name__ == '__main__':
    unittest.main()
