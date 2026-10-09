// 말씨 마스코트 이미지 (assets/mascot/*.png)
const MASCOTS=["front","basic","listen","think","thanks","joy","empathy","hello","hear","ponder","cheer",
  "hello_high","front_high"]; // 고화질: 시작 화면·서비스 소개의 큰 그림에만 씀
const M=Object.fromEntries(MASCOTS.map(k=>[k,`assets/mascot/${k}.png`]));
// 마크업의 <img data-m="이름">에 이미지 경로를 채움
function applyMascots(root=document){root.querySelectorAll("img[data-m]").forEach(i=>i.src=M[i.dataset.m]);}
