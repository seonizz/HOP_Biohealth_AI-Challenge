#!/usr/bin/env python3
"""Independent answer-review evidence audit and narrowly scoped admission repairs.

No model call, generator import, or frozen artifact modification. Mechanical
preconditions are not a claim of full free-form semantic review. The separate
review receipt identifies rows actually read by the reviewing agent.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

VERSION='local12b-answer-semantic-audit-v1'
REPAIRS=Path(__file__).resolve().parents[2]/'runtime/local12b-admission-20261112/answer_repair_rules.json'


def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(condition,message):
    if not condition:raise ValueError(message)


def load(bundle):
    root=Path(bundle)
    rows=[r for split in ('train','validation')
          for r in map(json.loads,(root/f'data/{split}.jsonl').read_text().splitlines())
          if r['task']=='answer_review']
    cases={c['case_id']:c for c in map(json.loads,(root/'provenance/source_cases.jsonl').read_text().splitlines())}
    require(len(rows)==800 and len(cases)==200,'Expected complete answer source inventory')
    return rows,cases


def repair(row,patches=None):
    """Repair two reviewed morphology defects, preserving identity and split.

    The changed candidate and its exact excerpt must stay byte-identical. These
    are deliberately incorrect answers, not corrected factual answers.
    """
    # Raw reviewed replacements stay in ignored runtime artifacts, never source.
    if patches is None:patches=json.loads(REPAIRS.read_text())['patches']
    lookup={p['row_id']:p for p in patches}
    require(len(lookup)==len(patches),'Duplicate repair identity')
    patch=lookup.get(row['row_id'])
    if patch is None:return deepcopy(row)
    require(digest(patch['patched_row'])==patch['patched_row_sha256'],'Repair content changed')
    if digest(row)==patch['patched_row_sha256']:return deepcopy(row)
    require(digest(row)==patch['original_row_sha256'],'Reviewed repair source no longer matches')
    fixed=deepcopy(patch['patched_row'])
    require(all(fixed[k]==row[k] for k in row if k not in ('messages','target_sha256')),
            'Repair changed non-message metadata')
    require(fixed['messages'][0]==row['messages'][0],'Repair changed system prompt')
    old_payload=json.loads(row['messages'][1]['content']);payload=json.loads(fixed['messages'][1]['content'])
    old_target=json.loads(row['messages'][-1]['content']);target=json.loads(fixed['messages'][-1]['content'])
    require(row['review_metadata']['error_type']=='ignored_negation' and target['approved'] is False
            and len(target['issues'])==1 and target['issues'][0]['excerpt']==payload['data']['candidate_reply'],
            'Repair no longer has the reviewed negative contract')
    payload['data']['candidate_reply']=old_payload['data']['candidate_reply']
    target['issues'][0]['excerpt']=old_target['issues'][0]['excerpt']
    require(payload==old_payload and target==old_target,'Repair changed more than candidate and excerpt')
    require(fixed['target_sha256']==hashlib.sha256(fixed['messages'][-1]['content'].encode()).hexdigest(),
            'Repair target hash changed')
    return fixed


def inspect(row,case):
    """Exhaustive source/target invariants, independent of original generators."""
    payload=json.loads(row['messages'][1]['content'])
    target=json.loads(row['messages'][-1]['content'])
    meta=row['review_metadata'];stage=meta['stage'];data=payload['data']
    require(row['task']=='answer_review' and row['split']==case['split'],'Task/split mismatch')
    require(type(stage)is int and stage in (1,2),'Bad stage')
    conversation=[dict(role='user',content=case['turn1'])]
    if stage==2:conversation += [dict(role='assistant',content=case['reply1']),dict(role='user',content=case['turn2'])]
    require(data['conversation']==conversation,'Future/source conversation mismatch')
    require(type(target['approved'])is bool and target['approved']==meta['approved']
            and target['approved']==(not target['issues']),'Approval consistency failure')
    require(row['loss_message_mask']==[0,0,1],'Wrong loss mask')
    require(row['target_sha256']==hashlib.sha256(row['messages'][-1]['content'].encode()).hexdigest(),'Stale target digest')
    candidate=data['candidate_reply']
    facts=case['facts']+case['superseded']
    for fact in facts:
        require(fact['quote'] in case['turn'+str(fact['turn'])],'Source fact not verbatim')
    if target['approved']:
        require(meta['error_type']=='none' and candidate==case['reply'+str(stage)],'Positive source reply mismatch')
        return {'label':'normal','rule':'inherited_reply_binding_only_semantics_sampled'}
    require(len(target['issues'])==1,'Expected one explicit synthetic fault')
    issue=target['issues'][0];code=issue['code']
    require(code==meta['error_type'] and issue['excerpt'] in candidate and bool(issue['excerpt']),'Wrong issue/code/excerpt')
    require(bool(issue['evidence']),'Missing evidence')
    for evidence in issue['evidence']:
        require(type(evidence['turn'])is int and 1<=evidence['turn']<=stage
                and bool(evidence['quote']) and evidence['quote'] in case['turn'+str(evidence['turn'])],
                'Nonuser/future/fabricated evidence')
    quotes=re.findall(r'“([^”]+)”',candidate)
    visible='\n'.join(case['turn'+str(t)] for t in range(1,stage+1))
    if code=='stale_information':
        require(stage==2 and case['superseded'] and any(f['quote'] in candidate for f in case['superseded']),
                'Stale candidate is not superseded')
        require(any(e['turn']==2 for e in issue['evidence']),'Stale issue lacks current source')
    elif code=='ignored_negation':
        require(stage==2 and case['challenge']=='negation' and quotes and quotes[0] not in visible,
                'Negation contrast absent')
        require(any(any(marker in e['quote'] for marker in ('아니','않','싫어서가')) for e in issue['evidence']),
                'Negation source marker missing')
        require('것이고고' not in candidate and '싫어서이고' not in candidate,'Synthetic morphology artifact')
    elif code=='attribution':
        goals=[f['quote'] for f in facts if f['subject']=='user_goal' and f['turn']<=stage]
        require(any(q in candidate for q in goals) and '상대가' in candidate and ('직접 부탁' in candidate or '직접 요청' in candidate),
                'Attribution contrast absent')
    elif code=='unsupported_fact':
        require(stage==1 and ((quotes and any(q not in case['turn1'] for q in quotes))
                or ('만나기로 확정' in candidate and candidate not in case['turn1'])),
                'Unsupported novelty precondition absent')
    elif code=='unconfirmed_consent':
        require(stage==1 and '공유해도 된다고 동의' in candidate
                and '공유해도 된다고 동의' not in visible,'Consent unsupported precondition absent')
    elif code=='unknown_as_known':
        require(stage==2 and any(q in candidate for q in case['unknowns']) and '이미 확인이 끝난' in candidate,
                'Unknown promoted to known precondition absent')
    elif code=='redundant_question':
        q=case['redundant_question']
        require(stage==2 and q['text'] in candidate and q['quote'] in case['turn'+str(q['turn'])]
                and '아직 답을 듣지 못' in candidate,'Repeated known question contrast absent')
    elif code=='ignored_goal_change':
        old=[f['quote'] for f in facts if f['subject']=='user_goal' and f['turn']==1]
        require(stage==2 and any(q in candidate for q in old) and any(f['subject']=='user_goal' and f['turn']==2 for f in case['facts']),
                'Changed goal precondition absent')
    elif code=='scope_overreach':
        require(stage==2 and '일정 조율을 앞으로 모두 맡기로' in candidate and '전체 진행을 책임진다고' in candidate,
                'Unsupported expanded commitment absent')
        require(not any('일정 조율을 앞으로 모두 맡기로' in case['turn'+str(t)] for t in (1,2)),
                'Expanded commitment actually exists')
    else:raise ValueError('Unsupported issue category')
    return {'label':'error','rule':code+'_source_contrast_preconditions'}


def select_review_cases(rows,cases):
    selected={r['source_root_ids'][0].split(':')[-1] for r in rows
              if r['review_metadata']['error_type'] in ('stale_information','ignored_negation')}
    groups=defaultdict(list)
    for row in rows:
        meta=row['review_metadata']
        if not meta['approved']:groups[row['split'],meta['stage'],meta['error_type']].append(row)
    for values in groups.values():selected.add(min(values,key=lambda r:r['row_id'])['source_root_ids'][0].split(':')[-1])
    for split in ('train','validation'):
        for challenge in sorted({c['challenge'] for c in cases.values()}):
            selected.add(min(c['case_id'] for c in cases.values() if c['split']==split and c['challenge']==challenge))
    return selected


def audit(bundle):
    rows,cases=load(bundle);issues=[];patches=[];counts=Counter();selected=select_review_cases(rows,cases)
    for original in rows:
        row=repair(original);case_id=row['source_root_ids'][0].split(':')[-1]
        if row!=original:patches.append(dict(row_id=row['row_id'],original_row_sha256=digest(original),
            patched_row_sha256=digest(row),patched_row=row,reason='Remove malformed negation-mutation morphology; preserve incorrect reported meaning and rejection label'))
        try:checked=inspect(row,cases[case_id]);counts[checked['label']+'/'+checked['rule']]+=1
        except (ValueError,KeyError,TypeError) as ex:issues.append(dict(row_id=row['row_id'],reason=str(ex)))
    return dict(schema=VERSION,status='passed' if not issues else 'failed',mechanically_checked_rows=len(rows),
        mechanically_checked_scope='source/polarity/evidence/time and fault-precondition invariants, not unrestricted semantic proof',
        source_manifest_sha256=hashlib.sha256((Path(bundle)/'MANIFEST.json').read_bytes()).hexdigest(),
        counts=dict(counts),patches=patches,unresolved_issues=issues,
        planned_independent_sample_rows=[dict(row_id=r['row_id'],original_row_sha256=digest(r),
            row_sha256=digest(repair(r)),case_id=r['source_root_ids'][0].split(':')[-1])
            for r in rows if r['source_root_ids'][0].split(':')[-1] in selected])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True);parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args();report=audit(args.bundle)
    require(not args.report.resolve().is_relative_to(args.bundle.resolve()),'Report outside frozen bundle required')
    with args.report.open('x') as handle:json.dump(report,handle,ensure_ascii=False,indent=2)
    print(canonical({k:v for k,v in report.items() if k not in ('patches','planned_independent_sample_rows')}))
    return 0 if report['status']=='passed' else 2


if __name__=='__main__':raise SystemExit(main())
