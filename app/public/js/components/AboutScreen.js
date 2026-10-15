// 5. 서비스 소개 화면 (내용: 2026HOP/소개글_정립.txt — 요약은 바로 보이고, 세부 내용은 「자세히 보기」로 펼침)
// 칸(상자)을 줄이고, 단계마다 번호·큰 여백으로 나눔. 숫자는 큰 숫자와 막대 그래프로
const ABOUT_SESSIONS=[["우울증",484],["불안장애",487],["중독",448],["일반군 (비교용)",242]];
const ABOUT_LABELS=[["증상",28,"우울한 기분, 불안감, 갈망 등 · DSM-5-TR 기준"],["위험요인",20,"사회적 지지 부족, 스트레스 사건 등"],["상담사의 개입",11,"공감과 지지, 명료화와 반영 등"],["개선요인",5,"정서적 변화, 변화 동기 증진 등"]];
// 가로 막대 그래프 (한 가지 값이라 한 색, 값은 막대 옆에 바로 표시)
const aboutBars=(rows,unit,label)=>{const max=Math.max(...rows.map(r=>r[1]));
  return `<div class="bars" role="img" aria-label="${label}: ${rows.map(r=>r[0]+" "+r[1]+unit).join(", ")}">${rows.map(([k,v,sub])=>`
    <div class="bar" title="${k} ${v}${unit}"><span class="bk">${k}${sub?`<small>${sub}</small>`:""}</span><span class="bt"><i style="--w:${(v/max*100).toFixed(1)}%"></i></span><b>${v}${unit}</b></div>`).join("")}</div>`;};
const AboutScreen={
  render(){return `
<section class="screen" id="about" hidden>
  ${NavBar("about")}
  <div class="abody">
    <div class="ahero">
      <div>
        <h2><em>어떻게 말해야 할지</em><br>몰라 막막할 때가 있어요.</h2>
        <p>가족이나 친구가 우울, 불안, 중독으로 힘들어하면 무슨 말을 해줘야 할지 모르겠고, 결국 "힘내"라는 말밖에 떠오르지 않을 때가 있죠. 말씨는 그런 순간에 어떤 말을 건네야 할지 함께 고민해 주는 서비스예요. 상대의 상황을 함께 정리하고, 내 마음을 어떻게 전하면 좋을지 생각하면서 진심을 담은 첫마디를 준비할 수 있도록 도와줘요.
</p>
      </div>
      <img data-m="front_high" alt="새싹 머리를 한 말씨">
    </div>

    <section class="asec">
      <header class="ahead"><span class="anum">01</span><h3 class="t">말씨는 이렇게 도와드려요</h3></header>
      <ol class="flow">
        <li class="it"><img data-m="listen" alt=""><h4>질문으로 상황 이해하기</h4><p>심리 면담 원리(CFI, FMI, SSCS)에 바탕을 둔 질문으로 그분의 상황과 당신의 마음을 차근차근 여쭤봐요. 답이 부족하면 한 번 더 구체적으로 물어요.</p></li>
        <li class="it"><img data-m="ponder" alt=""><h4>배경 정리하기</h4><p>답변을 증상, 힘들게 하는 요인, 버팀목이 되는 요인으로 나누어 정리해요. 실제 상담 데이터에 쓰인 분류와 같은 기준이에요.</p></li>
        <li class="it"><img data-m="cheer" alt=""><h4>말하는 방법 안내하기</h4><p>바로 쓸 수 있는 첫 문장, 해 보면 좋은 것과 피할 것, 다음 단계를 알려드려요. 상대방을 돕는 동안 지치거나 막막해진 당신의 마음도 함께 살펴봐요.</p></li>
      </ol>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">02</span><div><span class="kicker">말씨가 배우고 있는 데이터</span><h3 class="t">실제 상담실에서 오간 한국어 대화</h3></div></header>
      <p class="alead it">말씨는 AI허브에 공개된 「심리상담 데이터」를 바탕으로 만들어지고 있어요. 이 데이터는 우울증, 불안장애, 중독으로 어려움을 겪는 분들과 전문 상담사가 실제로 나눈 상담 대화 <b>1,661회기</b>를 기록한 것이에요.</p>
      <div class="bignums">
        <div class="it"><b>1,661<small>회기</small></b><span>전문 상담사와 실제로 나눈 상담 대화</span></div>
        <div class="it"><b>8<small>회기</small></b><span>내담자 한 분당, 검증된 인지행동치료(CBT) 흐름으로</span></div>
        <div class="it"><b>46만<small>여 단락</small></b><span>전문가가 한 단락씩 읽고 표시</span></div>
        <div class="it"><b>64<small>개 항목</small></b><span>단락마다 0~3점으로 평가한 마음의 신호</span></div>
      </div>
      <div class="charts">
        <figure class="chart it"><figcaption><b>어떤 대화가 담겨 있나요</b><span>상담 회기 수</span></figcaption>${aboutBars(ABOUT_SESSIONS,"회기","상담 회기 수")}</figure>
        <figure class="chart it"><figcaption><b>무엇을 표시했나요</b><span>평가 항목 64개의 구성</span></figcaption>${aboutBars(ABOUT_LABELS,"개","평가 항목 수")}</figure>
      </div>
      <div class="acc it">
        <details><summary>실제 정신건강 어려움을 겪는 분들의 대화<span>참여자 선정과 구성</span></summary>
          <p>참여자는 먼저 선별 검사를 받았어요. 기준을 넘은 분들은 질환별 공인 심리검사를 거쳤고, 정신보건 임상심리사와 정신과 전문의가 평가해 최종 선정했어요. 대화는 우울증 484회기, 불안장애 487회기, 중독 448회기, 비교를 위한 일반군 242회기로 고르게 구성되어 있어요.</p></details>
        <details><summary>근거 기반 상담 구조<span>인지행동치료(CBT) 8회기</span></summary>
          <p>모든 상담은 효과가 연구로 검증된 인지행동치료(CBT)를 바탕으로 진행됐어요. 내담자 한 분당 8회기씩, 정해진 흐름에 따라 이뤄졌어요.</p></details>
        <details><summary>전문가가 한 단락씩 읽고 표시한 마음의 신호<span>46만여 단락 · 64개 항목</span></summary>
          <p>상담 대화 46만여 단락마다 64개 세부 항목을 0~3점으로 평가했어요.</p>
          <ul>
            <li><b>증상</b> 우울한 기분, 불안감, 갈망 등 28개 항목이에요. 정신질환 진단 기준인 DSM-5-TR을 따랐어요.</li>
            <li><b>위험요인</b> 사회적 지지 부족, 스트레스 사건 등 20개 항목이에요. 질환별 체계적 문헌고찰 연구를 참고했어요.</li>
            <li><b>개선요인</b> 정서적 변화, 변화 동기 증진 등 5개 항목이에요.</li>
            <li><b>상담사의 개입</b> 공감과 지지, 명료화와 반영 등 11개 항목이에요.</li>
          </ul>
          <p>라벨링은 임상·상담심리 석사 이상의 준전문가가 맡았고, 정신과 전문의와 심리학 교수급 전문가가 검수했어요.</p></details>
        <details><summary>우리말 그대로의 마음<span>번역이 아닌 한국어 대화</span></summary>
          <p>번역된 외국 자료가 아니라 한국어로 오간 대화예요. 그래서 "괜찮아요"라는 말 속에 숨은 힘듦처럼 우리말 특유의 감정 표현과 돌려 말하는 방식이 담겨 있어요.</p></details>
      </div>
      <p class="note it">개인정보 보호를 위해 이름, 연락처, 소속 등은 모두 비식별 처리된 데이터예요.</p>
      <div class="learn it">
        <p class="learn-t">말씨는 이 데이터에서 <b>두 가지</b>를 배우고 있어요</p>
        <div class="learn-row"><div><span>1</span><b>어떤 신호가 보이는지</b><p>당신의 답변에서 증상·위험·버팀목 같은 신호를 알아봐요.</p></div><i aria-hidden="true">→</i><div><span>2</span><b>얼마나 뚜렷한지</b><p>그 신호가 얼마나 뚜렷한지 가늠해요.</p></div></div>
      </div>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">03</span><div><span class="kicker">질문의 근거</span><h3 class="t">전문가가 쓰는 면담 방법 세 가지로 질문을 만들었어요</h3></div></header>
      <p class="alead it">정신건강 전문가가 환자나 가족을 면담할 때 실제로 쓰는 방법과 연구를 바탕으로, <b>곁에 있는 가족·친구가 답하기 쉬운 질문</b>으로 바꿨어요.</p>
      <ol class="basis">
        <li class="it">
          <span class="qnum">1</span>
          <div>
            <span class="qtag">CFI · 문화적 공식화 면담</span>
            <h4>그분의 이야기를 그분의 맥락으로 이해하기</h4>
            <p>진단명이 아니라 당신이 본 그대로의 말로, 증상만이 아니라 맥락까지 함께 살펴요.</p>
            <div class="chipsrow"><span>자기 말로 묻기</span><span>맥락까지 보기</span><span>도움이 막힌 이유 살피기</span><span>주변인의 관찰도 정보</span></div>
            <details class="more"><summary>자세히 보기</summary>
              <p>CFI(Cultural Formulation Interview)는 미국정신의학회의 정신질환 진단 및 통계 편람인 DSM-5(2013)에 공식 수록된 반구조화 면담 도구예요. 6개국 현장시험을 거쳐 실제로 쓸 수 있고, 받아들여지며, 유용하다는 평가를 받았어요. 말씨는 CFI의 원리를 이렇게 담았어요.</p>
              <dl class="pr">
                <div><dt>진단명이 아니라 자기 말로 묻기</dt><dd>"우울증인가요?"를 판단할 필요가 없어요. "다른 가족에게 설명한다면 어떻게 말하겠어요?"처럼 당신이 본 그대로 적으면 돼요.</dd></div>
                <div><dt>증상만이 아니라 맥락까지 보기</dt><dd>무엇이 그분을 힘들게 하는지, 무엇이 버팀목인지, 어떤 가치관과 생활 배경이 있는지 함께 여쭤봐요.</dd></div>
                <div><dt>도움을 받기 어려운 이유 살피기</dt><dd>지금까지 어떻게 견뎌 왔는지, 어떤 도움을 받아 봤는지, 무엇이 도움을 가로막았는지 여쭤봐요. 그래서 "병원 가 보자"는 말이 왜 닿지 않았는지까지 고려해 말을 제안할 수 있어요.</dd></div>
                <div><dt>주변인의 목소리도 공식적인 정보원이에요</dt><dd>CFI에는 본인 대신 가족이나 지인에게 묻는 정보제공자용 버전이 따로 있어요. 곁에 있는 사람의 관찰이 그분을 이해하는 데 중요한 단서라는 것이 이미 면담 체계 안에 반영되어 있는 거예요.</dd></div>
              </dl>
            </details>
          </div>
        </li>
        <li class="it">
          <span class="qnum">2</span>
          <div>
            <span class="qtag">SSCS 모델 · FMI</span>
            <h4>돕는 사람도 영향을 받는다는 사실 인정하기</h4>
            <p>지친 마음으로 건넨 말은 의도와 다르게 전해지기 쉬워요. 그래서 말씨는 상대에게 건넬 말과 함께 당신의 마음을 돌보는 방법도 안내해요.</p>
            <ol class="sscs" aria-label="스트레스, 긴장, 대처, 지지 순서로 여쭤봐요">
              <li><b>스트레스</b><span>가장 힘들었던 순간은 언제였고, 얼마나 자주 있었나요?</span></li>
              <li><b>긴장</b><span>그 순간 마음이 어땠고, 잠·건강·일상에 어떤 변화가 생겼나요?</span></li>
              <li><b>대처</b><span>힘들 때 어떻게 했고, 무엇이 도움이 됐나요?</span></li>
              <li><b>지지</b><span>기댈 곳이 있나요?</span></li>
            </ol>
            <details class="more"><summary>자세히 보기</summary>
              <p>SSCS(Stress–Strain–Coping–Support, 스트레스-긴장-대처-지지) 모델은 영국의 Orford 연구진이 중독 문제를 가진 사람의 가족을 연구하며 정리한 모델이에요. 이 모델은 가족을 문제의 원인이 아니라, 큰 스트레스를 겪으면서도 대처하려 애쓰는 사람으로 바라봐요. 그리고 그 스트레스가 몸과 마음의 긴장으로 이어질 수 있으며, 어떻게 대처하고 어떤 지지를 받느냐가 그 무게를 바꾼다고 설명해요.</p>
              <p>FMI(Family Member Impact, 가족 영향 척도)는 같은 연구 흐름에서 만들어진 도구예요. 가족이 겪는 걱정, 긴장, 일상의 어려움을 살펴봐요.</p>
            </details>
          </div>
        </li>
        <li class="it">
          <span class="qnum">3</span>
          <div>
            <span class="qtag">전하고 싶은 말부터</span>
            <h4>무엇을 전하고 싶은지부터 묻기</h4>
            <p>말씨는 상황을 묻기 전에 당신이 전하고 싶은 말과 그 말로 바라는 것을 먼저 여쭤봐요. 곁에 있겠다는 마음을 전하고 싶은지, 진료를 권하고 싶은지, 예전 갈등을 풀고 싶은지에 따라 같은 상황에서도 좋은 첫마디는 달라지기 때문이에요.</p>
          </div>
        </li>
      </ol>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">04</span><h3 class="t">웹이라서 더 좋아진 점도 있어요</h3></header>
      <div class="web">
        <div class="it"><img data-m="joy" alt=""><p>CFI 현장시험에서 임상가들은 면담에 시간이 오래 걸린다는 점을 아쉬워했어요. 말씨에서는 <b>당신이 원하는 때에, 원하는 속도로</b> 답할 수 있어요.</p></div>
        <div class="it"><img data-m="hear" alt=""><p>사람 면담자가 없어도, 답이 부족하면 말씨가 <b>한 번 더 구체적으로 되물어요.</b> 반구조화 면담의 장점을 그대로 살린 거예요.</p></div>
      </div>
    </section>

    <section class="asec">
      <div class="notice it">
        <h3>꼭 알아 두세요</h3>
        <p>말씨의 질문은 진단을 위한 검사가 아니에요. 당신의 관찰을 정리해서 더 잘 맞는 말을 찾기 위한 도구예요. 그분의 상태를 판단하는 일은 의료진과 전문 상담사의 몫이에요. 위험 신호가 보이면 말씨는 전문 기관을 안내해 드려요.</p>
      </div>
    </section>
  </div>
</section>`;},
  mount(){},
  open(){show("about");window.scrollTo(0,0);this.animate();},
  // 열 때마다: 머리 부분은 바로, 아래 부분은 스크롤해서 화면에 들어올 때 차례로 떠오름 (막대는 보일 때 자라남)
  animate(){
    const a=$("about"),hero=a.querySelector(".ahero");
    reveal([hero,...hero.children],{step:160});
    a.querySelectorAll(".asec").forEach(sec=>{
      reveal(sec.querySelectorAll(".ahead"),{scroll:true});
      reveal(sec.querySelectorAll(".it"),{scroll:true,step:110,start:120});
    });
  }
};
