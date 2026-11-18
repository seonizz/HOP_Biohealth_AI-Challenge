// 서비스 소개: 기존 화면 구성에 현재 질문 계약과 이용 안내를 반영합니다.
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
        <li class="it"><img data-m="listen" alt=""><h4>질문으로 상황 이해하기</h4><p>먼저 어떤 도움을 원하는지와 다루고 싶은 상황을 여쭤봐요. 답변에 이미 담긴 내용은 건너뛰고, 안내에 꼭 필요한 내용을 더 확인해요.</p></li>
        <li class="it"><img data-m="ponder" alt=""><h4>배경 정리하기</h4><p>들려주신 관찰과 걱정, 도움을 주고받은 상황을 함께 정리해요. 아직 알기 어려운 부분은 미확인으로 남겨요.</p></li>
        <li class="it"><img data-m="cheer" alt=""><h4>말하는 방법 안내하기</h4><p>바로 쓸 수 있는 첫 문장, 해 보면 좋은 것과 피할 것, 다음 단계를 알려드려요. 상대방을 돕는 동안 지치거나 막막해진 당신의 마음도 함께 살펴봐요.</p></li>
      </ol>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">02</span><div><span class="kicker">개발에 참고한 상담 데이터</span><h3 class="t">실제 상담실에서 오간 한국어 대화</h3></div></header>
      <p class="alead it">말씨 개발에서는 AI허브에 공개된 「심리상담 데이터」를 참고했어요. 이 데이터는 우울증, 불안장애, 중독으로 어려움을 겪는 분들과 전문 상담사가 실제로 나눈 상담 대화 <b>1,661회기</b>를 기록한 것이에요.</p>
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
        <p class="learn-t">말씨는 답변을 정리할 때 <b>두 가지</b>를 살펴요</p>
        <div class="learn-row"><div><span>1</span><b>어떤 일이 있었는지</b><p>직접 보고 들은 일과 상대가 표현한 말을 살펴요.</p></div><i aria-hidden="true">→</i><div><span>2</span><b>어떤 도움을 원하는지</b><p>당신의 마음, 가능한 범위와 원하는 선택을 함께 살펴요.</p></div></div>
      </div>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">03</span><div><span class="kicker">질문은 이렇게 이어져요</span><h3 class="t">원하는 도움에 필요한 내용을 함께 정리해요</h3></div></header>
      <p class="alead it">먼저 <b>어떤 도움을 원하는지, 누구와의 어떤 일인지</b> 들려주세요. 답변을 바탕으로 안내에 필요한 질문을 골라요. 이미 말씀하신 내용은 다시 묻지 않도록 해요.</p>
      <ol class="basis">
        <li class="it">
          <span class="qnum">1</span>
          <div>
            <span class="qtag">목적과 상황</span>
            <h4>이번에 무엇을 정리하고 싶은지부터</h4>
            <p>상대에게 건넬 말, 거절하고 싶은 일, 정리하고 싶은 상황이나 내 마음을 알려 주세요. 상대는 실명 대신 친구·어머니처럼 관계로 적어도 괜찮아요.</p>
            <div class="chipsrow"><span>원하는 도움</span><span>상대와의 관계</span><span>다루고 싶은 상황</span></div>
            <details class="more"><summary>자세히 보기</summary>
              <p>한 답변에 목적과 관계, 상황이 함께 들어 있어도 괜찮아요. 필요한 내용이 이미 있으면 해당 질문은 건너뛰고, 원하는 안내를 만드는 데 중요한 정보가 빠졌을 때 더 확인해요.</p>
            </details>
          </div>
        </li>
        <li class="it">
          <span class="qnum">2</span>
          <div>
            <span class="qtag">관찰과 경험</span>
            <h4>실제로 보고 들은 일과 내 마음 살피기</h4>
            <p>상대가 실제로 한 말과 행동, 내가 지금까지 한 대응과 확인한 반응을 살펴요. 그 일로 내가 느낀 생각과 마음도 함께 들려주세요.</p>
            <ol class="sscs" aria-label="필요할 때 확인하는 내용">
              <li><b>상대의 말·행동</b><span>직접 보고 들은 일은 무엇인가요?</span></li>
              <li><b>지금까지의 대응</b><span>내가 한 일과 확인한 반응은 무엇인가요?</span></li>
              <li><b>내 생각과 마음</b><span>이 상황에서 어떤 마음이 드나요?</span></li>
              <li><b>상대의 바람</b><span>바란다고 했거나 하지 말아 달라고 한 것이 있나요?</span></li>
            </ol>
            <details class="more"><summary>자세히 보기</summary>
              <p>잘 모르는 내용은 모른다고 답해도 되고, 답하기 어려운 질문은 건너뛸 수 있어요. 전해 들은 말이라면 그렇게 밝혀 주세요. 아직 확인하지 못한 반응이나 상대의 마음은 미확인으로 남겨요.</p>
            </details>
          </div>
        </li>
        <li class="it">
          <span class="qnum">3</span>
          <div>
            <span class="qtag">가능한 범위와 원하는 선택</span>
            <h4>앞으로 할 수 있는 일과 하고 싶은 일</h4>
            <p>앞으로 가능한 방법과 시간, 본인이 원하는 선택을 살펴요. 할 수 있다는 답은 하겠다는 약속이 아니에요. 일부만 돕기, 지금은 돕지 않기, 아직 정하지 않기도 답이 될 수 있어요.</p>
          </div>
        </li>
      </ol>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">04</span><h3 class="t">웹이라서 더 좋아진 점도 있어요</h3></header>
      <div class="web">
        <div class="it"><img data-m="joy" alt=""><p>말씨에서는 <b>당신이 원하는 때에, 원하는 속도로</b> 답할 수 있어요.</p></div>
        <div class="it"><img data-m="hear" alt=""><p>답변에 맞춰 <b>안내에 필요한 내용을 구체적으로 확인해요.</b> 잘 모르겠거나 답하기 어려운 내용은 그대로 알려 주세요.</p></div>
      </div>
    </section>

    <section class="asec">
      <div class="notice it">
        <h3>꼭 알아 두세요</h3>
        <p>말씨의 질문은 진단을 위한 검사가 아니에요. 당신의 관찰을 정리해서 더 잘 맞는 말을 찾기 위한 도구예요. 그분의 상태를 판단하는 일은 의료진과 전문 상담사의 몫이에요. 위험 신호가 보이면 말씨는 전문 기관을 안내해 드려요.</p>
      </div>
      <div class="acc it">
        <details id="data-policy"><summary>대화 내용은 어디에 남나요?<span>보관과 삭제 안내</span></summary>
          <p>입력한 답변은 서버에 저장되고, 안내 생성을 위해 연결된 AI 모델로 전송돼요. 이름·연락처처럼 당사자를 알아볼 수 있는 정보는 꼭 필요한 만큼만 적어 주세요.</p>
          <p>대화를 중단하거나 브라우저를 닫아도 바로 삭제되지 않아요. 마지막 이용 후 ${typeof API!=="undefined"&&API.retentionDays?API.retentionDays():30}일이 지나면 기록을 열 수 없고, 서버 운영 중 1시간 안에 자동 삭제돼요. 서버가 멈춰 있었다면 다시 시작할 때 삭제해요.</p>
          <p>완료 기록과 진행 중이거나 중단한 대화는 「내 기록」에서 하나씩 또는 모두 삭제할 수 있어요. 대화를 삭제하면 관련 결과도 함께 지워져요. 칼럼의 읽음·담음은 유지돼요.</p>
          <p>쿠키를 지우거나 접근 기간이 끝나면 기존 기록을 열 수 없어요. 그 전에 「내 기록」에서 삭제 키를 만들어 따로 보관하면 나중에도 해당 대화만 삭제할 수 있어요. 삭제 키는 기록을 다시 여는 데 사용할 수 없어요.</p>
        </details>
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
