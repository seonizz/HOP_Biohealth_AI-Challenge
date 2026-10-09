// ── 기록 저장 (프로토타입: 브라우저 저장소 / 실제 서비스: 백엔드 DB) ──
const KEY="malssi.records.v1";
function loadRecs(){try{return JSON.parse(localStorage.getItem(KEY))||[];}catch(e){return [];}}
function saveRecs(r){try{localStorage.setItem(KEY,JSON.stringify(r));return true;}catch(e){return false;}}
