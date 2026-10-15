#!/usr/bin/env python3
"""Reclassify saved first response using anchored health; never resend it."""
import argparse
from pathlib import Path
import collect_ft31_comparison as c


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path)
    run=parser.parse_args().run.resolve()
    rows=c.lines(run/'generations.jsonl')
    assert len(rows)==1 and rows[0]['task']=='response' and rows[0]['case_id']=='DEV001'
    row=rows[0]
    assert row['status']=='identity_mismatch'
    raw=c.read(run/row['raw_response_file'])
    assert raw['model']==c.MODEL and raw.get('system_fingerprint') is None
    manifest=c.read(run/'run_manifest.json')
    before_name='evidence/identity_response_DEV001_before.json'
    before_bytes=(run/'evidence/health_collection_start.json').read_bytes()
    (run/before_name).write_bytes(before_bytes)
    before=c.read(run/before_name)
    after_name='evidence/identity_response_DEV001_after.json'
    after,after_sha=c.identity_health(run,'http://127.0.0.1:18080',after_name,manifest['expected_system_fingerprint'])
    assert before['pid']==after['pid'] and before['model_fingerprint']==manifest['expected_system_fingerprint']
    original_ledger=(run/'generations.jsonl').read_bytes()
    (run/'evidence/generations_before_identity_reconciliation.jsonl').write_bytes(original_ledger)
    code=(run/'evidence/collect_ft31_comparison.py').read_bytes()
    (run/'evidence/collector_first_attempt.original.py').write_bytes(code)
    status,label=c.derive(raw,'response',row['input_tokens_preflight'],manifest['expected_system_fingerprint'],True)
    assert status=='valid'
    row.update(status=status,predicted_label=label,identity_before_file=before_name,identity_before_sha256=c.sha(before_bytes),
        identity_after_file=after_name,identity_after_sha256=after_sha,verified_model_fingerprint=manifest['expected_system_fingerprint'],
        model_identity_source='authenticated_health_before_after')
    import json
    (run/'generations.jsonl').write_text(json.dumps(row,ensure_ascii=False,sort_keys=True)+'\n')
    c.write(run/'evidence/identity_reconciliation.json',{'generation_id':row['generation_id'],
        'previous_status':'identity_mismatch','reconciled_status':status,'previous_ledger_sha256':c.sha(original_ledger),
        'new_ledger_sha256':c.sha((run/'generations.jsonl').read_bytes()),'resubmitted':False,
        'raw_response_unchanged_sha256':row['raw_response_sha256'],
        'reason':'Actual API omits system_fingerprint; anchored authenticated health before/after proves same PID/model/checkpoint/runtime.'})
    manifest.setdefault('deviations_from_document',[]).append('Actual completion HTTP body omits system_fingerprint; retain null and verify exact model/PID/checkpoint/runtime through per-generation authenticated health snapshots.')
    manifest['collector_versions']=[{'sha256':manifest['collector_sha256'],'file':'evidence/collector_first_attempt.original.py','generation_ids':[row['generation_id']]},
        {'sha256':c.sha(Path(c.__file__).read_bytes()),'file':'evidence/collect_ft31_comparison.py','generation_ids':'subsequent first attempts'}]
    manifest['collector_sha256']=c.sha(Path(c.__file__).read_bytes())
    c.write(run/'run_manifest.json',manifest)
    (run/'evidence/collect_ft31_comparison.py').write_bytes(Path(c.__file__).read_bytes())
    c.completion(run,'collecting')
    print('Saved DEV001 reconciled to valid without another generation; raw fingerprint remains null.')


if __name__=='__main__':main()
