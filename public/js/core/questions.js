// 질문 문구·보기·순서는 PostgreSQL에서 내려오는 현재 문항을 사용해요.
// 보기 렌더링 도우미만 브라우저에 둡니다.
const optLabel=o=>Array.isArray(o)?o[0]:o, optMeta=o=>Array.isArray(o)?o[1]||{}:{};
