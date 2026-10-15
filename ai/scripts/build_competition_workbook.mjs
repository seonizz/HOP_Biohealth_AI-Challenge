import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const out = path.resolve('outputs/malssi_competition_20261009');
const d = JSON.parse(await fs.readFile(path.join(out, 'presentation_data.json'), 'utf8'));
const wb = Workbook.create();
const names = ['발표요약','데이터분포','분류기결과','검증기록','모델비교'];
const sheets = Object.fromEntries(names.map(n=>[n,wb.worksheets.add(n)]));
const ink='#20324D', blue='#365E9D', gray='#EFF3F8', amber='#FFF1D8';

function base(s,title,lastRow,lastCol=14) {
  s.showGridLines=false;
  s.getRangeByIndexes(0,0,lastRow,lastCol).format.font={name:'Arial',size:11,color:ink};
  s.getRangeByIndexes(0,0,lastRow,lastCol).format.rowHeight=25;
  s.getRangeByIndexes(0,0,lastRow,lastCol).format.verticalAlignment='center';
  s.getRangeByIndexes(0,0,lastRow,lastCol).format.columnWidth=14;
  s.getRange('A2').values=[[title]];
  s.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:ink};
  s.getRange('A2:F2').format.borders={bottom:{style:'thin',color:blue}};
}
function table(s,row,headers,values,widths) {
  const n=headers.length;
  s.getRangeByIndexes(row-1,0,values.length+1,n).values=[headers,...values];
  const h=s.getRangeByIndexes(row-1,0,1,n);
  h.format={fill:ink,font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},horizontalAlignment:'center',verticalAlignment:'center',rowHeight:31,wrapText:true};
  s.getRangeByIndexes(row,0,values.length,n).format.rowHeight=29;
  for(let i=0;i<values.length;i++) if(i%2===1) s.getRangeByIndexes(row+i,0,1,n).format.fill=gray;
  s.getRangeByIndexes(row,0,values.length,n).setNumberFormat('#,##0');
  if(widths) widths.forEach((w,i)=>s.getRangeByIndexes(0,i,Math.max(row+values.length,3),1).format.columnWidth=w);
}
function text(s,cell,value,width=90) {
  s.getRange(cell).values=[[value]];
  s.getRange(cell).format.columnWidth=width;
}
function note(s,row,value) {
  s.getRangeByIndexes(row-1,0,1,6).merge();
  s.getRangeByIndexes(row-1,0,1,6).values=[[value]];
  s.getRangeByIndexes(row-1,0,1,6).format.wrapText=true;
  s.getRangeByIndexes(row-1,0,1,6).format.rowHeight=42;
}
function chart(s,range,title,from,to) {
  const c=s.charts.add('bar',range);
  c.title=title;
  c.titleTextStyle.typeface='Arial';c.titleTextStyle.fontSize=14;
  c.hasLegend=false;
  c.xAxis={axisType:'textAxis',textStyle:{typeface:'Arial',fontSize:11}};
  c.yAxis={numberFormatCode:'#,##0',numberFormatSourceLinked:false,textStyle:{typeface:'Arial',fontSize:11}};
  c.series.items[0].fill=blue;
  c.setPosition(from,to);
  return c;
}

const summary=sheets['발표요약'];base(summary,'말씨 발표 데이터 | 2026-10-09',43);
table(summary,4,['선별 단계','Train (행)','Validation (행)','합계 (행)','원본 대비'],d.funnel.map(r=>[r['단계'],r['Train_행'],r['Validation_행'],null,null]),[32,15,19,16,16]);
for(let r=5;r<=9;r++){
  summary.getRange(`D${r}`).formulas=[[`=SUM(B${r}:C${r})`]];
  summary.getRange(`E${r}`).formulas=[[`=D${r}/$D$5`]];
}
summary.getRange('E5:E9').setNumberFormat('0.00%');
chart(summary,[summary.getRange('A4:A9'),summary.getRange('D4:D9')],'선별 후 응답 후보 (행)','G4','O16');
note(summary,11,'내용 보류: 1,244 + 54 − 37 = 1,261행. 길이 초과는 원문 절단 없이 보류.');
note(summary,13,'후보 수는 승인된 말씨 학습량과 다릅니다. 학습 전후 생성 품질 개선율은 미측정입니다.');
table(summary,18,['길이 통계 대상','응답 (행)','입력 토큰 합','p50 (토큰)','p95 (토큰)','최대 (토큰)'],d.stage_stats.map(r=>[r['단계'],r['행수'],r['총토큰'],r['p50_토큰'],r['p95_토큰'],r['최대_토큰']]),[32,15,19,16,16,16]);
table(summary,26,['감독 대상','전체 사례 토큰','감독 토큰','감독 비중'],[
  ['원본 전체',d.tokens.find(r=>r.split==='all'&&r['길이종류']==='full')['총토큰'],d.tokens.find(r=>r.split==='all'&&r['길이종류']==='supervised')['총토큰'],null],
  ['4,096 후보',34152923,1200410,null]
]);
summary.getRange('D27:D28').formulas=[['=C27/B27'],['=C28/B28']];
summary.getRange('D27:D28').setNumberFormat('0.00%');
note(summary,30,'입력·과거 응답·패딩 labels=-100. 마지막 목표 응답과 종료 경계만 감독합니다.');
note(summary,32,'감독 비중은 손실 대상의 비중입니다. 전체 문맥의 처리 시간·GPU 메모리 감소율은 아닙니다.');
note(summary,35,'재집계 범위: 기존 실제 토큰 장부 45,974행. 새 토크나이저·GPU·학습 실행은 하지 않았습니다.');
note(summary,38,'수치 출처: 데이터분포·분류기결과·검증기록의 근거 영역 및 presentation_data.json.');

const dist=sheets['데이터분포'];base(dist,'토큰 제한과 평가 대상 분포',59);
table(dist,4,['토큰 상한','Train (행)','Validation (행)','합계 (행)','원본 대비'],d.caps.map(r=>[r['토큰상한'],r['Train_행'],r['Validation_행'],null,null]),[16,17,19,18,16]);
for(let r=5;r<=11;r++){
  dist.getRange(`D${r}`).formulas=[[`=SUM(B${r}:C${r})`]];
  dist.getRange(`E${r}`).formulas=[[`=D${r}/'발표요약'!$D$5`]];
}
dist.getRange('E5:E11').setNumberFormat('0.00%');
chart(dist,[dist.getRange('A4:A11'),dist.getRange('D4:D11')],'내용 보류 적용 후 토큰 상한별 후보 (행)','G4','O16');
note(dist,13,'상한별 수용량은 데이터 길이 통계입니다. 해당 길이의 GPU 학습 가능성을 입증하지 않습니다.');
const pv=d.profiles.filter(r=>r.split==='validation');
table(dist,20,['생성 예약 (토큰)','Validation (행)','기존 후보 (행)','수용률','앞 1/3 (행)','앞부분 비중'],pv.map(r=>[r['생성예약_토큰'],r['수용_행'],r['기존4096후보_행'],null,r['원문앞1_3_행'],null]),[22,20,20,16,18,18]);
for(let r=21;r<=25;r++){
  dist.getRange(`D${r}`).formulas=[[`=B${r}/C${r}`]];
  dist.getRange(`F${r}`).formulas=[[`=E${r}/B${r}`]];
}
dist.getRange('D21:D25').setNumberFormat('0.00%');dist.getRange('F21:F25').setNumberFormat('0.00%');
chart(dist,[dist.getRange('A20:A25'),dist.getRange('B20:B25')],'생성 예약별 Validation 후보 (행)','G20','O32');
note(dist,28,'예약 64~1,024토큰의 공통 Validation은 1,335행입니다. 같은 ID에서 paired 비교해야 합니다.');
note(dist,31,'모든 예약 조건: 원문 뒤 1/3 Validation 0행, 96상담·21관측 그룹. 서비스 종료 행동 분류와 다릅니다.');
table(dist,36,['입력 길이 구간','Train (행)','Validation (행)','합계 (행)'],d.histogram.map(r=>[r['구간'],r['Train_행'],r['Validation_행'],r['합계_행']]),[24,20,20,16]);
note(dist,45,'구간은 원본 SFT 전체 실제 직렬화 토큰 길이입니다. 문자 수·단어 등장 수로 계산하지 않았습니다.');
text(dist,'A48','근거',22);
for(let i=0;i<3;i++){
  dist.getRangeByIndexes(49+i*3,0,3,6).merge();
  const source=[d.caps[0]['근거'],d.profiles[0]['근거'],d.histogram[0]['근거']][i];
  dist.getRangeByIndexes(49+i*3,0,3,6).values=[[source]];
  dist.getRangeByIndexes(49+i*3,0,3,6).format.wrapText=true;
}

const cls=sheets['분류기결과'];base(cls,'기존 TF-IDF·Naive Bayes 분류 smoke 결과',50,10);
table(cls,4,['단위','Train (행)','Validation (행)','Macro F1','Micro F1','우울 F1','중독 F1','불안 F1','기타 F1'],d.classifiers.map(r=>[r['단위'],r['Train_행'],r['Validation_행'],r.macro_F1,r.micro_F1,r['우울_F1'],r['중독_F1'],r['불안_F1'],r['기타_F1']]),[12,15,19,15,15,13,13,13,13]);
cls.getRange('D5:I7').setNumberFormat('0.0000');
note(cls,10,'과제가 다른 세 단위를 우열 비교하지 않습니다. 생성 도움 정도·안전성·진단 정확도 점수가 아닙니다.');
note(cls,12,'NFD 문자·자모 1~3gram. train-only 어휘·IDF, sublinear TF, L2. 가중 one-vs-rest NB alpha=0.1.');
table(cls,16,['단위','split','라벨','라벨 양성 (행)','전체 (행)','라벨 비중','다중라벨 (행)','특징 차원'],d.labels.map(r=>[r['단위'],r.split,r['라벨'],r['양성라벨_행'],r['전체_행'],null,r['다중라벨_행'],r['특징차원']]),[12,16,13,20,16,16,19,16]);
for(let r=17;r<=40;r++) cls.getRange(`F${r}`).formulas=[[`=D${r}/E${r}`]];
cls.getRange('F17:F40').setNumberFormat('0.00%');
cls.freezePanes.freezeRows(16);
note(cls,42,'다중라벨은 라벨 수의 합이 행 수를 넘을 수 있습니다. 별도 final test와 사람 독립성은 미확립입니다.');
cls.getRange('A45:I47').merge();cls.getRange('A45').values=[['근거: '+d.classifiers[0]['근거']+' 및 각 단위 numeric/manifest.json']];cls.getRange('A45:I47').format.wrapText=true;

const ver=sheets['검증기록'];base(ver,'저장된 실행 검증의 범위',63,12);
table(ver,4,['검사','대상','확인량','결과','범위'],[
 ['실제 토큰화','원본 SFT',45974,'전체 encoded','토큰 길이·정확한 경계'],
 ['비캐시 배열 대조','1,069개 상담',3155,'3,155 / 3,155 일치','표본 token·label·attention'],
 ['코드 회귀','정상 모드',295,'통과, skip 0','기존 저장된 실행 결과'],
 ['코드 회귀','최적화 모드',295,'통과, skip 0','같은 검사; 590개로 합산 금지'],
 ['엄격 손실 gate','제한 GPU 배치',null,'실패 유지','loss_reference_mismatch'],
 ['optimizer step','4차 GPU',0,'미수행','학습·저장·재개 미검증'],
],[24,24,19,29,40]);
table(ver,14,['입력 (토큰)','batch','상태','시간 (초)','입력 토큰/초','할당 (GiB)','예약 (GiB)','optimizer 상태'],d.gpu.map(r=>[r['입력길이_토큰'],r.batch,r['상태'],r['소요_초'],r['입력토큰_초'],r['최대할당_GiB'],r['최대예약_GiB'],r['optimizer상태_할당']?'할당':'미할당']),[20,10,18,17,20,18,18,22]);
ver.getRange('D15:G19').setNumberFormat('0.00');
note(ver,21,'RTX 4090 한 장, 4bit 31B, BF16, LoRA r=8/alpha=8, batch=1. 성공 행은 warm forward+backward입니다.');
note(ver,23,'7,670토큰은 첫 probe OOM입니다. optimizer 상태가 없는 제한 검증이므로 전체 학습 가능 판정은 미확정입니다.');
table(ver,27,['생성 prefix','생성 예약','실제 생성 (토큰)','prefill 일치','종료 관측'],[
 [48,64,16,'정확 일치','EOS token 관측'],[221,128,52,'정확 일치','EOS token 관측'],[4024,64,64,'정확 일치','길이 소진']
],[20,18,22,25,34]);
note(ver,32,'생성 3건은 입력 연결과 종료 동작 검사입니다. 모델 품질·안전·자연 완결률로 해석하지 않습니다.');
table(ver,36,['구성','기록 값','상태','설명'],[
 ['LoRA 파라미터',61214720,'기존 검증 설정','optimizer 업데이트 0'],
 ['r / alpha','8 / 8','기존 검증 설정','dropout=0, bias=none'],
 ['packing / truncation','false / false','입력 계약','초과 사례 보류/거절'],
 ['손실 mask','마지막 응답 + 종료 경계','입력 계약','prefix·padding = -100'],
 ['12B 대안','미실측','후속 후보','31B와 성능·자원 비교 없음']
],[24,38,24,40]);
ver.getRange('A44:H48').merge();ver.getRange('A44').values=[['근거: docs/support_agent/말씨_3차_실데이터_토큰_GPU_검증_2026-10-09.md; 말씨_4차_실검증_수정_결과_2026-10-09.md; 말씨_5차_보고서_대조검토_2026-10-09.md. 숫자 원본은 presentation_data.json의 sources와 연결.']];ver.getRange('A44:H48').format.wrapText=true;

const cmp=sheets['모델비교'];base(cmp,'기존 LLM 대비 비교할 결과와 측정 상태',49,9);
table(cmp,4,['모델 조건','데이터·설정','현재 상태'],[
 ['B0 기본 LLM','동일 Gemma IT + 최소 서비스 지시','동일 과제 평가 미수행'],
 ['B1 정책 프롬프트','동일 Gemma IT + 말씨 응답 정책','동일 과제 평가 미수행'],
 ['B2 원본 SFT','동일 base + 원본 상담 응답 QLoRA','학습 완료 근거 없음'],
 ['B3 말씨 목표 SFT','동일 base + 검토된 주변인 사례','승인 정답 확충·학습 필요']
],[25,51,35]);
table(cmp,12,['평가 지표','B0','B3','차이 (pp)','분모와 측정 규칙'],[
 ['요청 해결률',null,null,null,'동일 사례 전체; 독립 검토 pass 비율'],
 ['말·행동 구체성 통과율',null,null,null,'동일 사례 전체; rubrics로 판정'],
 ['주체·근거 보존율',null,null,null,'동일 사례 전체; 원문 근거 대조'],
 ['불필요 질문률',null,null,null,'질문 필요성 정답이 검토된 사례'],
 ['거절·정정 처리 성공률',null,null,null,'해당 상황의 동일 사례'],
 ['안전 기준 통과율',null,null,null,'안전 사례 전체; 전문 검토 포함'],
 ['다중 턴 요청 해결률',null,null,null,'모델 응답이 누적되는 전체 세션'],
 ['길이 소진률',null,null,null,'성공 생성 전체; 실패 별도 보고']
],[34,13,13,17,58]);
for(let r=13;r<=20;r++) cmp.getRange(`D${r}`).formulas=[[`=IF(AND(ISNUMBER(B${r}),ISNUMBER(C${r})),(C${r}-B${r})*100,"미측정")`]];
cmp.getRange('B13:C20').format.fill=amber;cmp.getRange('B13:C20').setNumberFormat('0.0%');cmp.getRange('D13:D20').setNumberFormat('0.0');
// The result input columns are narrow; keep the configuration text in one wide presentation field.
cmp.getRange('A4:E8').clear({applyTo:'all'});
cmp.getRange('A4').values=[['모델 조건']];
cmp.getRange('B4:E4').merge();cmp.getRange('B4').values=[['데이터·설정과 현재 상태']];
cmp.getRange('A4:E4').format={fill:ink,font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},rowHeight:31,horizontalAlignment:'center'};
const conditions=[
 ['B0 기본 LLM','동일 Gemma IT에 최소 서비스 지시. 해당 평가 미수행.'],
 ['B1 정책 프롬프트','동일 Gemma IT에 말씨 응답 정책. 해당 평가 미수행.'],
 ['B2 원본 SFT','동일 base에 원본 응답 QLoRA. 학습 완료 근거 없음.'],
 ['B3 말씨 목표 SFT','동일 base에 검토된 주변인 사례 SFT. 승인 정답 확충·학습 필요.']
];
for(let i=0;i<conditions.length;i++){
  const r=5+i;cmp.getRange(`A${r}`).values=[[conditions[i][0]]];
  cmp.getRange(`B${r}:E${r}`).merge();cmp.getRange(`B${r}`).values=[[conditions[i][1]]];
  cmp.getRange(`A${r}:E${r}`).format.rowHeight=36;
  cmp.getRange(`B${r}:E${r}`).format.wrapText=true;
  if(i%2===1)cmp.getRange(`A${r}:E${r}`).format.fill=gray;
}
note(cmp,22,'노란 칸은 실제 평가 결과 입력란입니다. 비율을 0~1로 입력하면 차이를 퍼센트포인트로 계산합니다.');
note(cmp,24,'평가 결과가 없는 칸은 빈칸입니다. 미측정을 0점·성능 향상으로 바꾸지 않았습니다.');
note(cmp,27,'동일 입력·토큰 예산·generation config·검토 기준으로 비교. 실패·길이 소진 응답도 결과에 포함합니다.');
note(cmp,30,'행 평균과 상담·관측 그룹 평균을 함께 보고. 최종 품질 주장에는 정책 고정 후 미사용 test가 필요합니다.');
note(cmp,33,'예약량의 개발 비교는 공통 1,335 Validation 행. 원본 응답 재현 평가와 말씨 목표 평가는 분리합니다.');
note(cmp,37,'차이의 방향: 해결·보존·안전 성공률은 높을수록 좋고, 불필요 질문·길이 소진률은 낮을수록 좋습니다.');
note(cmp,41,'PPT용 상세 설명·실험 설계·발표 문장은 발표_근거와_방법론.md에서 확인할 수 있습니다.');

// A result with a missing input stays unavailable; entered rates recalculate in pp.
wb.recalculate();
if(cmp.getRange('D13').values[0][0]!=='미측정') throw new Error('missing score became numeric');
cmp.getRange('B13:C13').values=[[.4,.55]];
if(Math.abs(cmp.getRange('D13').values[0][0]-15)>1e-9) throw new Error('delta does not recalculate');
cmp.getRange('B13:C13').clear({applyTo:'contents'});
wb.recalculate();
if(summary.getRange('D7').values[0][0]!==17236) throw new Error('funnel total');
if(Math.abs(summary.getRange('E7').values[0][0]-17236/45974)>1e-12) throw new Error('funnel retention');
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},maxChars:2000,summary:'Formula error scan'})).ndjson);
console.log((await wb.inspect({kind:'table',range:'발표요약!A4:F9',include:'values,formulas',tableMaxRows:6,tableMaxCols:6,maxChars:2500})).ndjson);
for(const name of names){
  const preview=await wb.render({sheetName:name,range:name==='모델비교'?'A1:F24':name==='분류기결과'?'A1:I13':name==='검증기록'?'A1:H24':'A1:O32',scale:1.5,format:'png'});
  await fs.writeFile(path.join(out,`preview_${name}.png`),new Uint8Array(await preview.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(wb)).save(path.join(out,'대회발표_데이터.xlsx'));
console.log(JSON.stringify({file:path.join(out,'대회발표_데이터.xlsx'),sheets:names,checks:'source totals, ratios, missing-value and score-delta recalculation passed'}));
