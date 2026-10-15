cd /home/slim/choieram || exit 1
set -euo pipefail
export MALSSI_KIT=/home/slim/choieram/model_Training/malssi_stage1_training_20261009
cd "$MALSSI_KIT"
PYTHONDONTWRITEBYTECODE=1 /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - <<'PY'
from pathlib import Path
from counseling_pipeline.stage1_preparation import bindings, load_config, verify_bundle, read_rows, sha_file
kit = Path.cwd()
expected = {
    'dataset_sha256': 'fa7f2c09be9b2c7ffa3f10c360f9abe533302b9002c25396d7f59c1bc8f842f2',
    'config_sha256': 'a3982a83de30f81a333fb70b5c2894cc264496b61b99d3ce4eef307efd866a35',
    'model_sha256': '3834bee34ebfb601c03e1de0c19510aa969cb1087d9a1501434d1333fcfff1d5',
    'template_sha256': '845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b',
    'code_sha256': '75e813d39ba9c6acb04e7f79d0218778515093ae25c864856f693924abc7ef55',
    'environment_sha256': '984128ac0d5cfcf38652259d3a463ec63c86d56e2189a9012e3d2427e583b689',
}
verify_bundle(kit)
actual = bindings(kit, load_config(kit))
if actual != expected:
    raise SystemExit('기준 패키지와 binding 불일치. 원인을 확인하고 중단하세요.')
if sha_file(kit / 'run.sh') != 'e3090b8d1e71446b654d8996d27006f810460aba3da2a7a5dcccaecea573520d':
    raise SystemExit('run.sh 불일치')
rows, _ = read_rows(kit)
print('지문/데이터 확인:', {k: len(v) for k, v in rows.items()})
for name in ('work/canary_gate.json', 'work/training/RUN.json', 'work/COMPLETE.json'):
    print(name, (kit / name).exists())
PY
