import ast
import csv
import hashlib
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

WORKSPACE = Path(__file__).resolve().parents[1]
OUT = WORKSPACE/'outputs/malssi_competition_20261009'
ROOT = Path(__file__).resolve().parents[2] / 'data'
d = json.loads((OUT/'presentation_data.json').read_text())
for rel,meta in d['sources'].items():
    assert hashlib.sha256((ROOT/rel).read_bytes()).hexdigest() == meta['sha256'], rel
for row in d['funnel']:
    assert row['합계_행'] == row['Train_행']+row['Validation_행']
    assert abs(row['원본대비_비율']-row['합계_행']/45974) < 1e-12
assert [r['값'] for r in d['metrics'] if r['상태']=='미측정']==[None,None]
assert d['checks']['hold_union'] == 1261
oom = [r for r in d['gpu'] if r['상태']=='oom']
assert len(oom)==1 and oom[0]['반복']==0 and '첫 probe' in oom[0]['범위']

csv_counts={}
for p in OUT.glob('*.csv'):
    with p.open(encoding='utf-8-sig',newline='') as f:
        rows=list(csv.DictReader(f))
    assert rows and all(None not in row for row in rows),p
    csv_counts[p.name]=len(rows)
report=(OUT/'발표_근거와_방법론.md').read_text()
assert report.count('```')%2==0
for target in re.findall(r'\]\(([^)]+)\)',report):
    assert (OUT/target).exists(),target
pattern_literal=re.search(r'```python\n([^\n]+)\n```',report).group(1)
pattern=ast.literal_eval(pattern_literal)
constants=[n.value for n in ast.walk(ast.parse((ROOT/'counseling_pipeline/text.py').read_text())) if isinstance(n,ast.Constant) and isinstance(n.value,str)]
assert pattern in constants,'Documented sentence regex differs from source'
re.compile(pattern)

ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(OUT/'대회발표_데이터.xlsx') as z:
    assert z.testzip() is None
    book=ET.fromstring(z.read('xl/workbook.xml'))
    tabs=[s.attrib['name'] for s in book.findall('m:sheets/m:sheet',ns)]
    assert tabs==['발표요약','데이터분포','분류기결과','검증기록','모델비교']
    chart_files=[p for p in z.namelist() if re.fullmatch(r'xl/(?:drawings/)?charts/chart\d+\.xml',p)]
    assert len(chart_files)==3
    for p in chart_files:
        chart=z.read(p).decode()
        references=ET.fromstring(chart).findall('.//{http://schemas.openxmlformats.org/drawingml/2006/chart}f')
        assert '365E9D' in chart and references,p
    error_cells=[]
    for p in z.namelist():
        if re.fullmatch(r'xl/worksheets/sheet\d+\.xml',p):
            root=ET.fromstring(z.read(p))
            error_cells.extend((p,c.attrib['r']) for c in root.findall('.//m:c',ns) if c.attrib.get('t')=='e')
    assert not error_cells,error_cells
    first=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    cells={c.attrib['r']:c for c in first.findall('.//m:c',ns)}
    assert float(cells['D7'].find('m:v',ns).text)==17236

verification={'date':'2026-10-09','source_hashes_checked':len(d['sources']),
              'existing_token_ledger_rows_reaggregated':45974,'csv_rows':csv_counts,
              'xlsx_sheets':tabs,'editable_native_charts':len(chart_files),
              'cached_formula_errors':error_cells,'artifact_engine_recalculation':'passed in workbook builder',
              'visual_review':'all five sheets reviewed; corrected truncated model configuration',
              'independent_content_review':'no substantive fact or denominator errors; regex and OOM scope corrected',
              'new_gpu_execution':False,'new_model_training':False,'new_model_quality_scores':False,
              'native_excel_application_recalculation_tested':False}
(OUT/'verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2)+'\n')
members=[p for p in OUT.iterdir() if p.suffix in {'.csv','.xlsx','.json','.md'}]
archive=OUT/'대회발표_자료묶음.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(members):z.write(p,p.name)
    for name in ['build_competition_data.py','build_competition_workbook.mjs','verify_competition_outputs.py']:
        z.write(WORKSPACE/'scripts'/name,'repro/'+name)
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
print(json.dumps({'verified':True,'sources':len(d['sources']),'csv_files':len(csv_counts),
                  'sheets':len(tabs),'charts':len(chart_files),'archive':str(archive),'bytes':archive.stat().st_size},ensure_ascii=False))
