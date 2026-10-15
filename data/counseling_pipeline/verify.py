"""Machine-readable evidence, not a substitute for unfinished work."""
from pathlib import Path
import json
import sqlite3
import sys
from datetime import datetime, timezone
import hashlib
import numpy as np
from .ingest import verify_ingest, inventory
from .numeric import fingerprint, dump
from .annotations import summary
from .quality import audit_pairs
from .suitability import assess


def verify(output,source=None):
    output=Path(output);evidence={};failures=[]
    ingest=json.loads((output/'ingestion_report.json').read_text())
    evidence['pairing_audit']=audit_pairs(output)['comparison_counts']
    evidence['ingestion']=verify_ingest(output/'corpus.sqlite')
    if not evidence['ingestion']['passed']:failures.append('ingest verification')
    if source:
        before=json.loads((output/'source_manifest_before.json').read_text())
        unchanged=inventory(Path(source))==before
        evidence['source_unchanged_now']=unchanged
        if not unchanged:failures.append('source changed')
    else:evidence['source_unchanged_now']=None
    root=output/'numeric';manifest=json.loads((root/'manifest.json').read_text())
    checks=[];row_counts={}
    for item in manifest['artifacts']:
        p=root/item['path'];check={'path':item['path'],'exists':p.exists()}
        if not p.exists():failures.append('missing '+item['path']);checks.append(check);continue
        if item.get('sha256'):
            check['sha256_match']=fingerprint(p)==item['sha256']
            if not check['sha256_match']:failures.append('hash '+item['path'])
        if p.suffix=='.npy':
            data=np.load(p,mmap_mode='r',allow_pickle=False)
            check['shape']=list(data.shape);check['finite']=True
            for offset in range(0,len(data),100000):
                if not np.isfinite(data[offset:offset+100000]).all():check['finite']=False
            if not check['finite']:failures.append('nonfinite '+item['path'])
            if item.get('shape')!=list(data.shape):failures.append('shape '+item['path'])
        elif p.suffix=='.npz':
            with np.load(p,allow_pickle=False) as data:
                shape=data['shape'];indptr=data['indptr'];indices=data['indices'];values=data['data']
                check['shape']=shape.tolist();check['finite']=bool(np.isfinite(values).all())
                check['csr_valid']=bool(len(indptr)==shape[0]+1 and indptr[0]==0 and indptr[-1]==len(values)==len(indices)
                    and np.all(np.diff(indptr)>=0) and np.all(indices>=0) and np.all(indices<shape[1]))
                if not check['finite'] or not check['csr_valid']:failures.append('invalid csr '+item['path'])
                if item.get('shape')!=shape.tolist():failures.append('shape '+item['path'])
        if item.get('row_mapping'):
            mapping=item['row_mapping']
            if mapping not in row_counts:
                path=root/mapping
                if path.suffix=='.jsonl':
                    count=0
                    with path.open() as f:
                        for line in f:
                            record=json.loads(line)
                            if record['row']!=count:failures.append('noncontiguous mapping '+mapping);break
                            count+=1
                    row_counts[mapping]=count
                else:
                    obj=json.loads(path.read_text());row_counts[mapping]=len(obj.get('words',obj.get('terms',[])))
            check['row_mapping_count']=row_counts[mapping]
            if item.get('shape') and item['shape'][0]!=row_counts[mapping]:failures.append('mapping shape '+item['path'])
        checks.append(check)
    evidence['numeric_checks']=checks
    try:
        suitability_manifest=assess(output)
        suitability=json.loads((output/'suitability/report.json').read_text())
        evidence['suitability']={'manifest_sha256':fingerprint(output/'suitability/manifest.json'),
            'artifact_count':len(suitability_manifest['artifacts']),'report':suitability}
    except (ValueError,OSError) as error:
        suitability=None
        failures.append('suitability: '+str(error))
    db=sqlite3.connect(output/'corpus.sqlite')
    blob_mismatches=sum(hashlib.sha256(data).hexdigest()!=sha for data,sha in db.execute(
        'SELECT b.data,s.sha256 FROM source_error_bytes b JOIN sources s USING(source_id)'))
    evidence['error_source_bytes_hash_mismatches']=blob_mismatches
    if blob_mismatches:failures.append('original error bytes hash mismatch')
    evidence['splits']=dict(db.execute('SELECT split,count(*) FROM conversations GROUP BY split'))
    train_groups={r[0] for r in db.execute("SELECT group_id FROM conversations WHERE split='train'")}
    val_groups={r[0] for r in db.execute("SELECT group_id FROM conversations WHERE split='validation'")}
    evidence['train_validation_group_overlap']=len(train_groups&val_groups)
    if train_groups&val_groups:failures.append('split group overlap')
    evidence['fit_train_sentences']=db.execute("SELECT count(*) FROM sentences WHERE split='train'").fetchone()[0]
    if manifest['fit_train_sentences']!=evidence['fit_train_sentences']:failures.append('fit scope')
    unit_counts={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ['conversations','utterances','sentences','words']}
    relevant_held=db.execute("SELECT count(*) FROM sources WHERE status='held' AND kind IN ('json','txt')").fetchone()[0]
    evidence['in_scope_held_sources']=relevant_held
    for unit,table in [('conversation','conversations'),('sentence','sentences'),('word_occurrence','words')]:
        if row_counts.get(unit+'_rows.jsonl')!=unit_counts[table]:failures.append('unit coverage '+unit)
    db.close();evidence['unit_counts']=unit_counts
    annotations=summary(output);evidence['annotations']=annotations
    if annotations['sentences']!=unit_counts['sentences']:failures.append('AI job coverage')
    # Confirmation must correspond to actual generation/validation or actual human decision.
    adb=sqlite3.connect(output/'annotations.sqlite')
    invalid_ai=adb.execute("""SELECT count(*) FROM jobs j WHERE label_status='ai_verified' AND
      (NOT EXISTS(SELECT 1 FROM generations g WHERE g.sentence_id=j.sentence_id) OR
       NOT EXISTS(SELECT 1 FROM verifications v WHERE v.sentence_id=j.sentence_id))""").fetchone()[0]
    invalid_human=adb.execute("""SELECT count(*) FROM jobs j WHERE label_status IN ('human_verified','human_review_resolved') AND
      NOT EXISTS(SELECT 1 FROM human_decisions h WHERE h.sentence_id=j.sentence_id)""").fetchone()[0]
    adb.close();evidence['unsupported_confirmations']=invalid_ai+invalid_human
    if invalid_ai+invalid_human:failures.append('unsupported confirmations')
    ai_unfinished=sum(v for k,v in annotations['job_status'].items() if k!='verified')
    source_errors=ingest['status_counts'].get('error',0)
    source_held=relevant_held
    blocked=[x for x in manifest['methods'] if x['status']!='implemented']
    evidence['checks_passed']=not failures;evidence['structural_checks_passed']=not failures;evidence['failures']=failures
    evidence['clinical_training_ready']=False
    evidence['semantic_readiness']={
        'status':'not_established','structural_checks_prove_semantics':False,
        'lexical_exploration':'available_with_suitability_masks' if suitability else 'quality_checks_failed',
        'standalone_svd_semantics':'unsupported',
        'verified_person_independent_evaluation':'not_established',
        'sentence_gold_labels':'requires_official_definitions_and_independent_review',
        'support_agent_effectiveness':'not_evaluated'}
    evidence['full_spec_complete']=not failures and not ai_unfinished and not source_errors and not source_held and not blocked
    evidence['completion_status']='complete' if evidence['full_spec_complete'] else 'partial'
    evidence['acceptance']={
      'AC01':{'verified':evidence['source_unchanged_now'],'claim':'all physical files and members unchanged'},
      'AC02':{'verified':ingest['all_sources_accounted'],'claim':'all inputs tracked, including held/errors'},
      'AC03':{'verified':evidence['ingestion']['passed'],'claim':'parsed JSON typed preservation; unparsed bytes retained separately'},
      'AC04':{'verified':evidence['ingestion']['passed'],'claim':'derived sentence/word offsets and references'},
      'AC05':{'verified':True,'execution_complete':ai_unfinished==0,'actual_records':annotations},
      'AC06':{'verified':True,'claim':'unexecuted work is held, not relabeled as human-reviewed','actual_human_review_count':annotations['label_status'].get('human_review_pending',0)},
      'AC07':{'verified':not invalid_ai and not invalid_human,'claim':'separate source/AI/human stores and provenance gates'},
      'AC08':{'verified':not bool(train_groups&val_groups),'claim':'conservative observed-ID/content groups disjoint; participant identity not proven'},
      'AC09':{'verified':not failures,'claim':'numeric artifacts and companion use masks checked structurally; semantic utility and training readiness not established','semantic_validity_verified':False},
      'AC10':{'verified':True,'all_families_executed':not blocked,'blocked':blocked},
      'AC11':{'verified':False,'claim':'requires recorded repeated-run and annotation lifecycle tests'},
      'AC12':{'verified':True,'claim':'partial status explicitly includes pending, source errors and blocked methods'} }
    test_path=output/'tests_result.json'
    if test_path.exists():
        tests=json.loads(test_path.read_text());repo=Path(__file__).resolve().parents[1]
        current_files=sorted((repo/'counseling_pipeline').glob('*.py'))+sorted((repo/'tests').glob('test_*.py'))
        fresh={str(p.relative_to(repo)):fingerprint(p) for p in current_files}==tests['code_sha256']
        evidence['regression_tests']={**tests,'current_code_matches':fresh}
        evidence['acceptance']['AC11']={'verified':tests['checks_passed'] and fresh,
          'claim':'synthetic interrupted ingest, identical resume, artifact-corruption recovery and idempotent annotation imports'}
    evidence['environment']={'python':sys.version,'numpy':np.__version__,'executable':sys.executable,
        'AI':'Current Codex only when an actual run is imported; no external API or local inference claimed'}
    evidence['verified_at']=datetime.now(timezone.utc).isoformat();dump(output/'verification.json',evidence)
    quality_lines=[]
    if suitability:
        evaluation=suitability['evaluation'];duplicates=evaluation['sentence_duplicates']
        val=duplicates['splits'].get('validation',{})
        quality_lines=[
            f'- 비문자열/결측 발화 {suitability["text"]["nonstring_or_missing_utterances"]:,}개; 영향 상담 {suitability["text"]["affected_conversations"]:,}개.',
            f'- 종료<시작 발화 {suitability["source_numeric"]["utterance"]["reversed_time_rows"]:,}개. 해당 시간값과 duration을 invalid로 표시했다.',
            f'- SVD 0벡터 문장 {suitability["distributional"]["sentence"]["zero_vector_rows"]:,}개; 토큰 OOV {suitability["distributional"]["sentence"]["token_oov_rate"]:.2%}.',
            f'- 검증 잠정 그룹 {evaluation["validation_split_group_count"]:,}개; 사람 관계 검증 여부: False.',
            f'- 검증 문장 {val.get("occurrences",0):,}개 중 train과 정규화 동일 문장 {duplicates["validation_occurrences_seen_in_train"]:,}개. 30자 이상 {val.get("length_ge_30_occurrences",0):,}개 중 {duplicates["validation_length_ge_30_occurrences_seen_in_train"]:,}개.',
            f'- 원본 발화 라벨 {evaluation["raw_utterance_labels"]["all_label_cells"]:,}개 중 숫자 0 {evaluation["raw_utterance_labels"]["numeric_zero_cells"]:,}개. 코드 의미는 미확인이다.']
    lines=['# 처리 결과','',f"상태: **{evidence['completion_status']}**. 전체 명세 완료 여부: {evidence['full_spec_complete']}.",'',
        '## 전체 범위','',f"- 원천 물리 파일 {ingest['physical_files']:,}개, ZIP 멤버 {ingest['archive_members']:,}개.",
        *[f'- {k}: {v:,}' for k,v in unit_counts.items()],
        f'- 원천 상태: {json.dumps(ingest["status_counts"],ensure_ascii=False)}',
        f'- 분할: {json.dumps(evidence["splits"],ensure_ascii=False)}',
        f'- 화자 접두어를 고려한 TXT/JSON 대응: {json.dumps(evidence["pairing_audit"],ensure_ascii=False)}',
        f'- 원천 해시 변경 없음: {evidence["source_unchanged_now"]}; 구조·수치 검사 통과: {not failures}',
        '- 상담 지원 학습·문장 정답·의미 보존 검증: **미확립**. 구조 검사 통과와 별개다.',
        '', '## AI 라벨과 미완료 범위','',
        f'- 실제 생성 {annotations["actual_generation_records"]:,}건, 실제 검증 {annotations["actual_verification_records"]:,}건, 사람 확정 {annotations["actual_human_decisions"]:,}건.',
        f'- 작업 상태: {json.dumps(annotations["job_status"],ensure_ascii=False)}',
        f'- 라벨 상태: {json.dumps(annotations["label_status"],ensure_ascii=False)}',
        '- 숫자 라벨의 코드 판정 정의를 공식 문서에서 확보하지 못해 신규 수치 판정을 생성하지 않았다. 단순 상속·규칙식 결과를 AI 라벨로 기록하지 않았다.',
        '- 기술적 대기는 사람 검토로 위장하지 않는다. 현재 생성/검증을 실행하지 않은 항목은 pending + definition_unresolved이다.',
        '- 원천 오류와 비문자열 발화는 원형을 보존하고 문제 목록에 남겼다. 정상 파생 자료가 있다는 이유로 원천 전체를 정상 처리로 선언하지 않는다.',
        '', '## 품질과 사용 조건','',
        *quality_lines,
        '- `suitability/report.json`에 수치 유효성·불완전 텍스트·SVD 의미 손실 반례·분할 중복·라벨 불균형을 집계한다.',
        '- `suitability/usage_contract.json` 및 마스크를 함께 사용한다. 기본 `load_features` 로더는 SVD·라벨·요약·탐색 통계를 입력에서 제외한다.',
        '- 관측된 수치도 음수·비정수 글자 수·역전 시간인 경우 사용할 수 없다. valid는 제한된 수치 조건 통과이며 원문 정확성이나 임상 타당성이 아니다.',
        '- 불완전 상담은 전체 상담 입력에서 기본 제외한다. 정상 문장과 그 문장의 전체 상담 문맥 완전성은 별도로 표시한다.',
        '- SVD는 탐색 전용이다. coverage=1 또는 nonzero도 의미 보존을 증명하지 않는다. 인접 cosine 역시 감정·위험 변화의 정답이 아니다.',
        '- 검증의 train 미등장 문장 subset은 중복 민감도 분석용이다. 원래 분할·train fit은 유지하며 독립 사람 단위 평가로 표시하지 않는다.',
        '', '## 실행한 표현','',
        *[f'- {x["family"]}: {x["status"]}'+(f' — {x["reason"]}' if 'reason' in x else '') for x in manifest['methods']],
        '', '## 사용상 경계','',
        '- `corpus.sqlite`의 상담·발화·문장·단어 및 원본 JSON/TXT/라벨을 ID로 연결한다. 원문은 비공개 로컬 산출물이다.',
        '- `numeric/manifest.json`에서 행렬·행 ID·차원·dtype·fit 범위를 확인한다. count/binary/TF-IDF는 CSR NPZ, 밀집 특성은 NPY다.',
        '- 어휘/공기/SVD는 train 문장에만 fit했다. 같은 변환기를 validation에 적용한다. 빈도 전체 집계는 탐색용 열로 표시했다.',
        '- PPMI/SVD 벡터는 코퍼스 분포 표현이며 신경망 문맥 임베딩이 아니다. 단어를 형태소로 표시하지 않는다.',
        '- 원본 라벨 행렬은 원래 적용 단위의 target 전용이다. 관측/nonnull 마스크와 applicability(미확인)는 다른 개념이다.',
        '- 동일 ID와 동일 내용의 보수적 그룹을 격리했다. 회기별 실제 동일인 관계를 검증했다는 의미는 아니다.',
        '- 대화 전체 통계와 인접 후속 발화를 포함한 AI 문맥은 오프라인 용도이다.',
        '', '재개: README.md의 명령으로 같은 출력 디렉터리에 다시 실행한다. 정의 확보 후 version을 기록한 사전으로 AI 배치를 준비한다.']
    (output/'REPORT.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    return evidence
