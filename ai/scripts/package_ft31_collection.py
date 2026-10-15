#!/usr/bin/env python3
"""Package verified measurements; reject credentials, symlinks and model states."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

import collect_ft31_comparison as c
import verify_ft31_measurements as verifier


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path)
    parser.add_argument('presentation',type=Path)
    args=parser.parse_args()
    run,presentation=args.run.resolve(),args.presentation.resolve()
    result=verifier.verify(run,export=False)
    assert result['verification']['collection_complete']
    assert result['verification']['recorded_first_attempts']==94
    assert c.read(presentation/'datasheet_verification.json')['ft31_records']==94
    xlsx=presentation/'FT31_STEP100_데이터시트.xlsx'
    assert xlsx.is_file() and xlsx.stat().st_size>0
    assert zipfile.is_zipfile(xlsx)
    roundtrip=c.read(presentation/'workbook_roundtrip_verification.json')
    assert roundtrip['verified'] and roundtrip['records']==94 and roundtrip['xlsx_sha256']==c.sha(xlsx.read_bytes())
    shutil.copyfile(xlsx,run/xlsx.name)
    for name in ('datasheet_verification.json','datasheet_formula_scan.json','workbook_roundtrip_verification.json','build_datasheet.mjs'):
        shutil.copyfile(presentation/name,run/name)
    for name in ('metrics.json','local_measurements.csv','comparison.md','public_answers.md','verification.json',
        'generations.jsonl','run_manifest.json','preflight.json','COLLECTION_COMPLETE.json','evidence_manifest.json','verify_measurements.py'):
        shutil.copyfile(run/name,presentation/name)
    codes=run/'evidence/collection_tools'
    codes.mkdir(exist_ok=True)
    for name in ('collect_ft31_comparison.py','preflight_ft31_comparison.py','snapshot_ft31_server.py','prepare_ft31_compatibility.py',
        'deploy_ft31_compatibility.py','reconcile_ft31_first_identity.py','package_ft31_collection.py',
        'verify_ft31_measurements.py','test_collect_ft31_comparison.py','test_verify_ft31_measurements.py','audit_ft31_source_exposure.py',
        'await_ft31_completion.py','verify_ft31_xlsx.py'):
        path=Path(__file__).parent/name
        if path.exists():shutil.copyfile(path,codes/name)
    readme=(
        '# FT31_STEP100 수집 자료\n\n'
        '**내부 전달용**: Excel과 raw_data에는 기존 검증용 상담 입력·답변이 포함되어 있습니다.\n'
        '공개 발표에는 public_answers.md의 공개 합성 자료만 사용합니다.\n\n'
        '모델은 malssi-gemma4-31b-step100, 학습 진행은100/5,052 step입니다.\n'
        '원래 입력94건을 그대로 사용했고 상담512·분류32토큰, temperature0, 동시성1, 첫 시도1회입니다.\n'
        '상담63건과 행동분류31건은 서로 다른 과제입니다. 종료·형식·토큰 지표는 품질·안전성·분류 정확도 점수가 아닙니다.\n'
        '서버의 실제 토크나이저로 생성 전4096 비교 예산을 확인했습니다. 현재 역사 대화 렌더링이 문서의 과거 경로와 다른32건은 preflight에 기록했습니다.\n'
        '실제 HTTP 응답은 system_fingerprint를 생략합니다. 이 값은 null로 보존하고 전후 인증된 health의 동일PID·전체 체크포인트·런타임 지문으로 각 응답을 검증했습니다.\n'
        '첫 DEV001의 상태 판정은 추가 생성 없이 근거를 보강해 재계산했습니다. 기존 판정 원장과 조정 기록도 보존했습니다.\n\n'
        '기존 검증용32건의 원천ID는 전체 학습40,415행 및 step100까지 소비한800행과 겹치지 않았고, 검증4,298행에서는32건 모두 확인됐습니다. 이는 원천ID 점검 결과이며 텍스트 중복 여부 판정은 아닙니다.\n\n'
        'Excel의 요약 수치는 metrics.json과 대조했고 모든 원래94행에 확인된 답변·상태·실제 토큰을 보존했습니다. 연결 단절 등으로 확인되지 않은 답변·토큰은 빈칸으로 유지하며 분모에서 제외하지 않습니다.\n'
        '원자료 재검증: 번들 또는 표준 Python으로 `python3 verify_measurements.py <raw_data 절대경로>`를 실행합니다.\n'
        'Excel 재생성: @oai/artifact-tool이 있는 번들 Node로 `node build_datasheet.mjs --ft31 <raw_data 절대경로> --output <xlsx 절대경로>`를 실행합니다.\n'
        'FILE_SHA256.json은 ZIP의 모든 전달 파일에 대한SHA-256 목록입니다. 인증키·가중치·optimizer 상태는 포함하지 않았습니다.\n')
    (presentation/'먼저읽기.md').write_text(readme,encoding='utf8')
    shutil.copyfile(presentation/'먼저읽기.md',run/'먼저읽기.md')
    top=['FT31_STEP100_데이터시트.xlsx','먼저읽기.md','comparison.md','metrics.json','local_measurements.csv','public_answers.md',
        'datasheet_verification.json','datasheet_formula_scan.json','workbook_roundtrip_verification.json','build_datasheet.mjs']
    entries={name:presentation/name for name in top}
    entries.update({'raw_data/'+str(path.relative_to(run)):path for path in sorted(run.rglob('*')) if path.is_file()})
    secret=(c.ROOT/'trained_model_api/runtime/api_key').read_text().strip().encode()
    assert len(secret)>20
    hashes={}
    for name,path in entries.items():
        assert not path.is_symlink()
        assert path.suffix not in ('.pt','.safetensors','.bin')
        assert path.name not in ('api_key','active_cache_hmac.key')
        data=path.read_bytes()
        assert secret not in data,'Credential found in delivery material'
        hashes[name]=hashlib.sha256(data).hexdigest()
    c.write(presentation/'FILE_SHA256.json',hashes)
    entries['FILE_SHA256.json']=presentation/'FILE_SHA256.json'
    archive=presentation.with_suffix('.zip')
    assert not archive.exists(),'Do not overwrite prior delivery ZIP'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as output:
        for name,path in entries.items():output.write(path,name)
    with zipfile.ZipFile(archive) as saved:
        assert saved.testzip() is None
        for name,expected in hashes.items():assert hashlib.sha256(saved.read(name)).hexdigest()==expected
    c.write(presentation/'delivery_verification.json',{'verified':True,'files':len(entries),
        'zip_file':str(archive),'zip_sha256':c.sha(archive.read_bytes()),'credentials_excluded':True,
        'xlsx_sha256':c.sha(xlsx.read_bytes()),'all_zip_entry_hashes_rechecked':True})
    print(json.dumps({'xlsx':str(xlsx),'zip':str(archive),'files':len(entries)},ensure_ascii=False))


if __name__=='__main__':main()
