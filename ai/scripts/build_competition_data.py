"""Read existing aggregate evidence; export presentation data without counseling text."""
import csv
import gzip
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / 'data'
OUT = Path(__file__).resolve().parents[1] / 'outputs/malssi_competition_20261009'
OUT.mkdir(parents=True, exist_ok=True)
sources = {}


def read(rel):
    path = ROOT / rel
    sources[rel] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    return json.loads(path.read_text())


def write_csv(name, rows):
    with (OUT / name).open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


policy_path = 'outputs/private/malssi_round3_20261009/candidate_4096/token_admission_policy.json'
audit_path = 'outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json'
budget_path = 'outputs/private/malssi_round5_review_20261009/budget_profile_review.json'
baseline_path = '데이터셋/학습용_3종_v1_20261009/baseline_smoke.json'
sft_path = '데이터셋/말씨_원본상담_SFT_v1_20261009/manifest.json'
policy, audit, budget, baseline, sft = [read(p) for p in [policy_path, audit_path, budget_path, baseline_path, sft_path]]
assert audit['status'] == 'passed' and audit['processed_rows'] == 45974
assert policy['source_admission_counts']['admitted_rows'] == 44713
assert not policy['model_training_authorized'] and not sft['readiness']['model_trained']

funnel = []
stages = [('원본 응답 SFT', 40652, 5322, '휴리스틱 선별 원본 응답; 말씨 승인 정답 아님'),
          ('내용 노출 보류 후', 40415, 4298, '원문 내용 중복 정책의 조건부 수용'),
          ('4,096토큰 연구 후보', 15512, 1724, '전체 직렬화 길이와 내용 보류를 함께 적용'),
          ('생성 128토큰 예약 후보', budget['profiles']['128']['train']['rows'], budget['profiles']['128']['validation']['rows'], '기존 4,096 후보 안에서 prefix+128≤4,096'),
          ('예약 64~1,024 공통 후보', budget['common_rows_by_split']['train'], budget['common_rows_by_split']['validation'], '예약량 조건 비교용 교집합; 최종 test 아님')]
previous = None
for stage, train, val, note in stages:
    total = train + val
    funnel.append({'단계': stage, 'Train_행': train, 'Validation_행': val, '합계_행': total,
                   '원본대비_비율': total/45974, '직전단계_감소행': '' if previous is None else previous-total,
                   '해석': note, '근거': policy_path if total in [45974, 44713, 17236] else budget_path})
    previous = total
assert funnel[3]['합계_행'] == 17001 and funnel[4]['합계_행'] == 13594

caps = []
for cap, data in policy['caps'].items():
    caps.append({'토큰상한': int(cap), 'Train_행': data['train']['admitted_rows'],
                 'Validation_행': data['validation']['admitted_rows'],
                 '합계_행': data['train']['admitted_rows']+data['validation']['admitted_rows'],
                 '원본대비_수용률': (data['train']['admitted_rows']+data['validation']['admitted_rows'])/45974,
                 'GPU_실행가능_판정': '미확정; 길이 수용량만 계산', '근거': policy_path})

profiles = []
for reservation, by_split in budget['profiles'].items():
    for split, d in by_split.items():
        pos = d['original_position_thirds']
        profiles.append({'생성예약_토큰': int(reservation), 'split': split, '수용_행': d['rows'],
                         '기존4096후보_행': policy['selected'][split]['admitted_rows'], '보류_행': d['held'],
                         '수용률': d['rows']/policy['selected'][split]['admitted_rows'],
                         '원문앞1_3_행': pos.get('early', 0), '중간1_3_행': pos.get('middle', 0),
                         '뒤1_3_행': pos.get('late', 0), '앞1_3_비율': pos.get('early', 0)/d['rows'],
                         '상담수': d['source_conversations'], '관측그룹수': d['observed_groups'],
                         '최대그룹_비율': d['largest_group_share'], '상위5그룹_비율': d['top5_group_share'], '근거': budget_path})

lengths_path = 'outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz'
length_file = ROOT / lengths_path
sources[lengths_path] = {'sha256': hashlib.sha256(length_file.read_bytes()).hexdigest()}
arrays = {s: {k: [] for k in ['sequence_length', 'prefix_length', 'target_length']} for s in ['train', 'validation']}
admission_path = 'outputs/private/malssi_round3_20261009/admission_rows.jsonl.gz'
admission_file = ROOT / admission_path
sources[admission_path] = {'sha256': hashlib.sha256(admission_file.read_bytes()).hexdigest()}
with gzip.open(admission_file, 'rt') as f:
    admitted = {r['id'] for r in map(json.loads, f) if r['admitted']}
stage_lengths = {stage: [] for stage in ['원본', '내용 보류 후', '4,096 후보', '생성 128 예약 후보']}
bins = {s: Counter() for s in arrays}
edges = [512, 1024, 2048, 4096, 8192, 16384, 32768]
with gzip.open(length_file, 'rt') as f:
    for line in f:
        row = json.loads(line)
        assert row['status'] == 'encoded'
        split = row['split']
        assert row['sequence_length'] == row['prefix_length'] + row['target_length']
        for key in arrays[split]:
            arrays[split][key].append(row[key])
        stage_lengths['원본'].append(row['sequence_length'])
        if row['id'] in admitted:
            stage_lengths['내용 보류 후'].append(row['sequence_length'])
            if row['sequence_length'] <= 4096:
                stage_lengths['4,096 후보'].append(row['sequence_length'])
                if row['prefix_length'] + 128 <= 4096:
                    stage_lengths['생성 128 예약 후보'].append(row['sequence_length'])
        bins[split][next(e for e in edges if row['sequence_length'] <= e)] += 1

def quantile(xs, p):
    return sorted(xs)[max(0, math.ceil(len(xs)*p)-1)]

tokens = []
map_keys = {'sequence_length': 'full', 'prefix_length': 'prefix', 'target_length': 'supervised'}
for split, data in arrays.items():
    for key, xs in data.items():
        record = {'split': split, '길이종류': map_keys[key], '행수': len(xs), '총토큰': sum(xs),
                  '평균_토큰': sum(xs)/len(xs), 'p50_토큰': quantile(xs, .5), 'p95_토큰': quantile(xs, .95),
                  'p99_토큰': quantile(xs, .99), '최대_토큰': max(xs),
                  '측정범위': '전체 원본 SFT; 기존 실토큰 장부에서 이번에 재집계', '근거': lengths_path}
        ref = audit['splits'][split][map_keys[key]]
        assert record['총토큰'] == ref['sum'] and record['행수'] == ref['count']
        assert record['p50_토큰'] == ref['p50'] and record['p95_토큰'] == ref['p95'] and record['최대_토큰'] == ref['max']
        tokens.append(record)
arrays['all'] = {k: arrays['train'][k]+arrays['validation'][k] for k in map_keys}
for key, xs in arrays['all'].items():
    tokens.append({'split': 'all', '길이종류': map_keys[key], '행수': len(xs), '총토큰': sum(xs),
                   '평균_토큰': sum(xs)/len(xs), 'p50_토큰': quantile(xs, .5), 'p95_토큰': quantile(xs, .95),
                   'p99_토큰': quantile(xs, .99), '최대_토큰': max(xs),
                   '측정범위': '전체 원본 SFT; 기존 실토큰 장부에서 이번에 재집계', '근거': lengths_path})
stage_stats = [{'단계': stage, '행수': len(xs), '총토큰': sum(xs), 'p50_토큰': quantile(xs,.5),
                'p95_토큰': quantile(xs,.95), 'p99_토큰': quantile(xs,.99), '최대_토큰': max(xs),
                '근거': lengths_path+' + '+admission_path} for stage,xs in stage_lengths.items()]
assert [r['행수'] for r in stage_stats] == [45974,44713,17236,17001]
assert stage_stats[0]['총토큰'] == audit['totals']['full']['sum']
histogram = [{'구간': f'{0 if i==0 else edges[i-1]+1:,}~{e:,}',
              'Train_행': bins['train'][e], 'Validation_행': bins['validation'][e],
              '합계_행': bins['train'][e]+bins['validation'][e], '근거': lengths_path} for i,e in enumerate(edges)]
assert sum(r['합계_행'] for r in histogram) == 45974

classifiers = []
label_counts = []
names = {'conversation': '상담', 'sentence': '문장', 'word': '단어'}
for d in baseline['results']:
    feature_path = f'데이터셋/학습용_3종_v1_20261009/{d["unit"]}/numeric/manifest.json'
    feature = read(feature_path)
    for split, c in feature['counts'].items():
        for label, count in c['labels'].items():
            label_counts.append({'단위': names[d['unit']], 'split': split, '라벨': label, '양성라벨_행': count,
                                 '전체_행': c['rows'], '라벨_비율': count/c['rows'],
                                 '다중라벨_행': c['multi_label_rows'], '특징차원': c['matrix_shape'][1],
                                 '근거': feature_path})
    classifiers.append({'단위': names[d['unit']], 'Train_행': d['train_rows'], 'Validation_행': d['validation_rows'],
                        'macro_F1': d['f1_macro_smoke_only'], 'micro_F1': d['f1_micro_smoke_only'],
                        '우울_F1': d['label_f1_smoke_only']['우울'], '중독_F1': d['label_f1_smoke_only']['중독'],
                        '불안_F1': d['label_f1_smoke_only']['불안'], '기타_F1': d['label_f1_smoke_only']['기타'],
                        '모델': d['model'], '범위': '기존 실행 smoke; 생성 품질·임상 효과 아님', '근거': baseline_path})

gpu_rows = []
for gpu_path in ['outputs/private/malssi_round3_20261009/remote/gpu_validation_initial.json',
                 'outputs/private/malssi_round3_20261009/remote/gpu_validation.json']:
    g = read(gpu_path)
    for d in g['benchmarks']:
        run = d['runs'][-1]
        gpu_rows.append({'입력길이_토큰': d['sequence_length'], 'batch': d['batch_size'], '반복': run['repetition'],
                         '상태': run['status'], '소요_초': run.get('seconds'),
                         '입력토큰_초': run.get('input_tokens_per_second'),
                         '최대할당_GiB': run.get('peak_allocated_gib'), '최대예약_GiB': run.get('peak_reserved_gib'),
                         'optimizer상태_할당': d['optimizer_state_allocated'], '가중치_업데이트': run.get('weights_updated',False),
                         '범위': 'RTX4090 1장; '+('첫 probe OOM' if run['status']=='oom' else 'forward/backward warm run')+'; 학습 step 아님', '근거': gpu_path})
gpu_rows.sort(key=lambda r:r['입력길이_토큰'])

selected = policy['selected']
supervised = sum(v['supervised_tokens'] for v in selected.values())
full = sum(v['full_tokens'] for v in selected.values())
metrics = []
def metric(key, label, value, unit, numerator, denominator, status, scope, source):
    metrics.append(dict(metric_id=key, 지표=label, 값=value, 단위=unit, 분자=numerator, 분모=denominator, 상태=status, 해석=scope, 근거=source))

metric('sft_rows', '원본 응답 SFT 행', 45974, '행', '', '', '기존 실행 기록', '1,069개 상담의 파생 응답; 독립 상담 수 아님', sft_path)
metric('hold_rows', '내용 노출 고유 보류', 1261, '행', '', '', '기존 실행 기록', '1,244+54−37; 보류 사유 단순 합산 금지', policy_path)
metric('hold_rate', '내용 노출 보류율', 1261/45974, '비율', 1261, 45974, '이번 계산', '원본 응답 SFT 기준', policy_path)
metric('candidate_rows', '4,096 연구 후보', 17236, '행', '', '', '기존 실행 기록', '말씨 승인 학습 정답과 구분', policy_path)
metric('candidate_retention', '4,096 후보 원본 대비 수용률', 17236/45974, '비율', 17236, 45974, '이번 계산', '내용 보류와 길이 제한 결합', policy_path)
metric('candidate_128', '128토큰 예약 후보', 17001, '행', '', '', '기존 실행 기록', '기존4,096 후보 안에서 생성 입력 예산 검사', budget_path)
metric('supervised_total', '4,096 후보 감독 토큰', supervised, '토큰', '', '', '기존 실행 기록', 'Train+Validation 마지막 목표와 종료 직렬화 경계', policy_path)
metric('supervised_share', '4,096 후보 감독 토큰 비중', supervised/full, '비율', supervised, full, '이번 계산', '손실 대상 토큰/전체 사례 토큰; GPU 계산량 감소율 아님', policy_path)
metric('cache_matches', '캐시·비캐시 표본 일치', 3155/3155, '비율', 3155, 3155, '기존 실행 기록', '1,069개 상담의 3,155행 표본; 전행 동등성 아님', 'docs/support_agent/말씨_4차_실검증_수정_결과_2026-10-09.md')
metric('common_val', '예약 조건 공통 Validation', 1335, '행', '', '', '기존 실행 기록', '5개 예약조건 paired 비교용; 미사용 final test 아님', budget_path)
metric('val_groups', '4,096 후보 Validation 관측 그룹', 21, '그룹', '', '', '기존 실행 기록', '1,724행이 21그룹; 사람 신원으로 보증하지 않음', policy_path)
metric('optimizer_steps', '4차 GPU optimizer 업데이트', 0, 'step', '', '', '기존 실행 기록', '생성·손실 진단; 전체 모델 학습 미수행', 'docs/support_agent/말씨_4차_실검증_수정_결과_2026-10-09.md')
metric('lora_parameters','제한 GPU 검증의 학습 가능 LoRA 파라미터',61214720,'개','','','기존 실행 기록','r=8 alpha=8; optimizer 업데이트 없음','docs/support_agent/말씨_3차_실데이터_토큰_GPU_검증_2026-10-09.md')
for c in classifiers:
    metric('macro_f1_'+c['단위'], c['단위']+' 보조분류 macro-F1', c['macro_F1'], 'F1', '', '', '기존 실행 smoke', '단위별 과제·집단이 달라 우열 비교 금지', baseline_path)
metric('base_llm_helpfulness', '기반 LLM 요청 해결률', None, '비율', '', '', '미측정', '실제 동일 평가셋 응답과 독립 검토 필요', '../docs/current/현황과_할일.md')
metric('malssi_helpfulness', '말씨 모델 요청 해결률', None, '비율', '', '', '미측정', '학습 완료·응답 평가 근거 없음', '../docs/current/현황과_할일.md')

for name, rows in [('데이터_선별흐름.csv', funnel), ('토큰상한별_후보.csv', caps), ('생성예약별_분포.csv', profiles),
                   ('토큰길이_통계.csv', tokens), ('토큰길이_히스토그램.csv', histogram), ('기존_분류기_점수.csv', classifiers), ('발표_수치.csv', metrics)]:
    write_csv(name, rows)
for name, rows in [('단계별_토큰통계.csv',stage_stats),('분류_라벨분포.csv',label_counts),('GPU_제한검증.csv',gpu_rows)]:
    write_csv(name,rows)

for rel in [
    'docs/support_agent/말씨_3차_실데이터_토큰_GPU_검증_2026-10-09.md',
    'docs/support_agent/말씨_4차_실검증_수정_결과_2026-10-09.md',
    'docs/support_agent/말씨_5차_보고서_대조검토_2026-10-09.md',
    'docs/support_agent/말씨_학습데이터_프로젝트적합성_종합검증_2026-10-09.md',
    'counseling_pipeline/text.py', 'counseling_pipeline/source_sft.py',
    'counseling_pipeline/gemma4_token_validation.py',
    '데이터셋/학습용_3종_v1_20261009/repro/train_baseline.py',
]:
    sources[rel] = {'sha256':hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()}

payload = {'date': '2026-10-09', 'evidence_scope': '기존 실행 증거+이번 로컬 재집계; 새 GPU·모델 학습·응답 평가 미수행',
           'funnel': funnel, 'caps': caps, 'profiles': profiles, 'tokens': tokens, 'histogram': histogram,
           'classifiers': classifiers, 'labels': label_counts, 'stage_stats':stage_stats, 'gpu':gpu_rows,
           'metrics': metrics, 'sources': sources,
           'checks': {'rows': 45974, 'ledger_matches_audit': True, 'hold_union': 1244+54-37,
                      'training_run': False, 'new_model_scores_generated': False}}
(OUT/'presentation_data.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({'output': str(OUT), 'ledger_rows_checked': 45974, 'source_files': len(sources),
                  'sft_candidate_retention': 17236/45974, 'supervised_share': supervised/full,
                  'tokens': [{k:r[k] for k in ['split','길이종류','p50_토큰','p95_토큰','최대_토큰']} for r in tokens]}, ensure_ascii=False))
