// 칼럼 본문 파일 만들기
// 사용법 (저장소 폴더에서): node tools/build-column-bodies.mjs "../../정신건강_기사본문_정리본.txt"
// 정리본 형식: ===== 구분선 / 제목 / 출처: … / 원문 링크: … / (빈 줄) / 본문
// 결과: frontend/js/core/columnBodies.js (COLUMN_BODIES = { "원문 링크(http(s):// 뺀 주소)": ["문단", …] })
import fs from "node:fs";

const src = process.argv[2];
if (!src) { console.error('정리본 경로를 넣어 주세요: node tools/build-column-bodies.mjs "<파일.txt>"'); process.exit(1); }

const txt = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
const blocks = txt.split(/\n=+\n/).slice(1); // 첫 덩어리는 파일 설명
const bodies = {};
for (const block of blocks) {
  const lines = block.split("\n");
  const linkAt = lines.findIndex(l => l.startsWith("원문 링크:"));
  if (linkAt < 0) continue;
  const key = lines[linkAt].replace("원문 링크:", "").trim().replace(/^https?:\/\//, "");
  // 문단: 빈 줄에서 나누고, PDF에서 끊긴 줄(문장이 끝나지 않은 줄)은 앞 줄에 이어 붙임
  const paras = []; let cur = "";
  for (const raw of lines.slice(linkAt + 1)) {
    const l = raw.trim();
    if (!l) { if (cur) paras.push(cur); cur = ""; continue; }
    if (cur && !/[.?!…"'”’)\]>다요]$/.test(cur)) cur += (/[가-힣]$/.test(cur) && /^[가-힣]/.test(l) ? "" : " ") + l;
    else { if (cur) paras.push(cur); cur = l; }
  }
  if (cur) paras.push(cur);
  if (paras.length) bodies[key] = paras;
}

const out = new URL("../frontend/js/core/columnBodies.js", import.meta.url);
fs.writeFileSync(out, "// 자동 생성 파일: tools/build-column-bodies.mjs 로 다시 만들 수 있어요. 직접 고치지 말고 정리본을 고친 뒤 다시 실행해 주세요.\n" +
  "const COLUMN_BODIES = " + JSON.stringify(bodies, null, 1) + ";\n");
console.log(`본문 ${Object.keys(bodies).length}편을 frontend/js/core/columnBodies.js 에 저장했어요.`);
