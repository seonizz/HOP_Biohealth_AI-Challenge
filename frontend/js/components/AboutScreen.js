// 5. 서비스 소개 화면
const AboutScreen={
  render(){return `
<section class="screen" id="about" hidden>
  ${TopBar(`<span class="pill">서비스 소개</span><button class="ghost" id="aboutHome" style="margin-left:auto">처음으로</button><button class="btn" id="aboutGo" style="padding:10px 26px;font-size:18px">말씨와 시작하기</button>`)}
  <div class="abody">
    <div class="ahero">
      <div>
        <h2>곁에 있는 사람도<br><em>어떻게 말해야 할지</em> 몰라 힘들어요</h2>
        <p>가족이나 친구가 우울, 불안, 중독으로 힘들어할 때, 많은 사람이 "힘내"라는 말밖에 떠올리지 못해요. 말씨는 그 곁의 사람이 마음을 잘 전할 수 있도록 첫 마디를 함께 준비하는 서비스예요.</p>
      </div>
      <img data-m="front" alt="새싹 머리를 한 말씨">
    </div>

    <div class="asec">
      <h3 class="t">말씨는 이렇게 도와드려요</h3>
      <div class="agrid">
        <div class="acard"><img data-m="listen" alt=""><h3>질문으로 상황 이해하기</h3><p>심리 면담 원리(CFI, FMI, SSCS)에 바탕을 둔 질문으로 그분의 상황과 당신의 마음을 차근차근 여쭤봐요. 답이 부족하면 한 번 더 구체적으로 물어요.</p></div>
        <div class="acard"><img data-m="ponder" alt=""><h3>배경 정리하기</h3><p>답변을 증상, 힘들게 하는 요인, 버팀목이 되는 요인으로 나누어 정리해요. 실제 상담 데이터에 쓰인 분류와 같은 기준이에요.</p></div>
        <div class="acard"><img data-m="cheer" alt=""><h3>말하는 방법 안내하기</h3><p>바로 쓸 수 있는 첫 문장, 해 보면 좋은 것과 피할 것, 다음 단계를 알려드려요. 애쓰고 있는 당신의 마음도 함께 살펴요.</p></div>
      </div>
    </div>

    <div class="asec">
      <h3 class="t">한국어 심리상담 데이터로 배우는 말씨</h3>
      <div class="facts">
        <div class="fact"><b>1,661회기</b><span>실제 심리상담 기록 (AI허브 심리상담 데이터)</span></div>
        <div class="fact"><b>CBT 8회기</b><span>근거 기반 인지행동치료 구조로 진행된 상담</span></div>
        <div class="fact"><b>60여 개 라벨</b><span>증상·위험·개선·개입 요인을 전문가가 표시</span></div>
        <div class="fact"><b>한국어</b><span>우리말 정서와 표현을 그대로 담은 대화</span></div>
      </div>
      <p class="note" style="margin:12px 0 0">현재 시범 운영 중인 버전은 일반 AI로 답을 만들고 있으며, 상담 데이터로 학습한 말씨 모델로 바꿔 가는 중이에요.</p>
    </div>

    <div class="asec">
      <h3 class="t">말씨의 약속</h3>
      <ul class="promise">
        <li>진단이나 치료를 하지 않아요. 전문가를 대신하지 않고, 필요할 땐 전문 기관을 안내해요.</li>
        <li>위험 신호가 보이면 대화보다 안전을 먼저 챙겨요. (109, 1577-0199, 112/119)</li>
        <li>실명 대신 별명이나 호칭으로도 충분해요. 기록은 이 브라우저에만 남아요.</li>
        <li>당신을 평가하지 않아요. 곁을 지키는 것만으로도 큰 힘이 된다는 걸 알아요.</li>
      </ul>
    </div>
    <p class="note" style="text-align:center;margin:0">2026 제3회 CO-SHOW 연계 HOP Biohealth AI Challenge 출품작</p>
  </div>
</section>`;},
  mount(){
    $("aboutHome").onclick=()=>show("start");
    $("aboutGo").onclick=begin;
  },
  open(){show("about");document.querySelector("#about .abody").scrollTop=0;}
};
