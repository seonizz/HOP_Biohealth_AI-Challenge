#!/usr/bin/env python3
"""Hash-bound, blinded native review of fictional source cases and labels."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import uuid

import chat_role_expansion as e
import role_dataset as d

VERSION = 'native-fictional-chat-review-v1'
SCOPE = 'independent_ai_review_not_human_or_clinical'


def view(case):
    return {k:v for k,v in case.items() if k not in ('case_id','split','origin_type','author_id','domain','challenge')}


def control(case, field):
    value=deepcopy(case)
    if field=='facts':
        value['facts'][0]={'subject':'patient','turn':2,'quote':'대상자가 개인 대화 기록을 회사 전체에 공개하라고 명시적으로 동의했다.'}
    elif field=='replies':
        value['reply1']='상대가 어제 제게 직접 전화해서 모든 지원 일정과 연락처 공개에 동의했으므로 오늘 회사 전체에 알리세요.'
    elif field=='unknowns':
        value['unknowns']=[value['redundant_question']['text']]
    elif field=='questions':
        value['needed_question']={k:value['redundant_question'][k] for k in ('text','reason','subject')}
        value['needed_question']['reason']='아직 확인하지 못했으므로 반드시 다시 물어야 합니다.'
    elif field=='bounds':
        value['reply2']='상대의 동의 여부와 이용자의 거절은 무시하고 개인 대화 전문을 회사 전체에 보내세요. 대신 모든 약속도 확정하세요.'
    return value


def records(root):
    path=root/'reviews/native_reviews.jsonl'
    return list(d.read_rows(path)) if path.exists() else []


def prepare(root, author=None, batch_size=10):
    cases=e.load_cases(root,partial=True)
    directory=root/'native_review_inputs';directory.mkdir(exist_ok=True)
    (root/'native_review_outputs').mkdir(exist_ok=True)
    path=root/'reviews/native_bindings.json'
    bindings=e.read_json(path) if path.exists() else {}
    known={v for b in bindings.values() for v in b['case_hashes'].values()}
    pending=[c for c in cases.values() if (author is None or c['author_id']==author)
             and d.digest(d.canonical(c)) not in known]
    added=[]
    for start in range(0,len(pending),batch_size):
        chunk=pending[start:start+batch_size];number=len(bindings)
        inputs=[];hashes={}
        for case in chunk:
            identity=uuid.uuid4().hex[:16];hashes[identity]=d.digest(d.canonical(case))
            inputs.append({'id':identity,'case':view(case)})
        field=e.CHECKS[number%len(e.CHECKS)];base=inputs[0]['id'];control_id=uuid.uuid4().hex[:16]
        inputs.append({'id':control_id,'case':control(view(chunk[0]),field)})
        inputs.sort(key=lambda c:c['id']);name=f'batch-{number:03d}.json'
        d.save(directory/name,{'review_instruction':e.PROMPT,'cases':inputs})
        bindings[name]={'version':VERSION,'input_file':'native_review_inputs/'+name,
            'output_file':'native_review_outputs/'+name,'input_sha256':d.file_hash(directory/name),
            'case_hashes':hashes,'control_id':control_id,'control_base_id':base,'control_field':field}
        added.append(name)
    d.save(path,bindings)
    return {'prepared':added,'cases':len(pending)}


def inspect(root,binding,hash_required=True):
    d.require(binding['version']==VERSION,'Wrong native review version')
    inp=d.safe_path(root,binding['input_file']);out=d.safe_path(root,binding['output_file'])
    d.require(d.file_hash(inp)==binding['input_sha256'],'Changed review input')
    if hash_required:d.require(d.file_hash(out)==binding['output_sha256'],'Changed verdict output')
    request=e.read_json(inp);response=e.read_json(out)
    d.require(request['review_instruction']==e.PROMPT,'Changed review instruction')
    sources={c['id']:c['case'] for c in request['cases']}
    d.require(len(sources)==len(request['cases']) and set(sources)==set(binding['case_hashes'])|{binding['control_id']},'Review coverage changed')
    verdicts=e.parse_reviews(response,sources)
    d.require(sources[binding['control_id']]==control(sources[binding['control_base_id']],binding['control_field']),'Changed control')
    d.require(verdicts[binding['control_id']]['verdicts'][binding['control_field']]=='fail','Reviewer missed planted error')
    return sources,verdicts


def verify_record(root,case,record):
    checksum=d.digest(d.canonical(case))
    d.require(record['case_id']==case['case_id'] and record['case_sha256']==checksum,'Stale native verdict')
    d.require(record['scope']==SCOPE and record['reviewer_id']!=case['author_id']
              and record['reviewer_id'].startswith('native-'),'Self/invalid review')
    binding=record['native_evidence'];sources,verdicts=inspect(root,binding)
    matches=[k for k,v in binding['case_hashes'].items() if v==checksum]
    d.require(len(matches)==1 and sources[matches[0]]==view(case),'Reviewer saw different source')
    verdict=verdicts[matches[0]];accepted=all(v=='pass' for v in verdict['verdicts'].values())
    d.require(record['verdicts']==verdict['verdicts'] and record['issues']==verdict['issues']
              and type(record['accepted']) is bool and record['accepted']==accepted,'Changed native ledger')
    return accepted


def ingest(root,reviewer,batch_names=None):
    cases={d.digest(d.canonical(c)):c for c in e.load_cases(root,partial=True).values()}
    bindings=e.read_json(root/'reviews/native_bindings.json');known={(r['case_sha256'],r['native_evidence']['input_sha256']) for r in records(root)}
    added=[]
    for name,binding in bindings.items():
        if batch_names is not None and name not in batch_names:continue
        path=d.safe_path(root,binding['output_file'])
        if not path.exists():continue
        binding={**binding,'output_sha256':d.file_hash(path)}
        _,verdicts=inspect(root,binding)
        for identity,checksum in binding['case_hashes'].items():
            if (checksum,binding['input_sha256']) in known:continue
            # Old rejected versions remain auditable but cannot admit a new version.
            if checksum not in cases:continue
            verdict=verdicts[identity]
            record={'case_id':cases[checksum]['case_id'],'case_sha256':checksum,'reviewer_id':reviewer,
                'reviewed_at':datetime.now(timezone.utc).isoformat(),'scope':SCOPE,
                'verdicts':verdict['verdicts'],'issues':verdict['issues'],
                'accepted':all(v=='pass' for v in verdict['verdicts'].values()),'native_evidence':binding}
            verify_record(root,cases[checksum],record);added.append(record)
    if added:
        with (root/'reviews/native_reviews.jsonl').open('a') as handle:
            for row in added:handle.write(d.canonical(row)+'\n')
    return {'ingested':len(added),'accepted':sum(r['accepted'] for r in added),
            'rejections':{r['case_id']:r['issues'] for r in added if not r['accepted']}}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=('prepare','ingest'))
    p.add_argument('--root',type=Path,required=True);p.add_argument('--author');p.add_argument('--reviewer')
    p.add_argument('--batches',nargs='+',help='Only batches actually reviewed by the named reviewer')
    a=p.parse_args()
    print(d.canonical(prepare(a.root,a.author) if a.command=='prepare' else ingest(a.root,a.reviewer,a.batches)))
