// 5. 서비스 소개 화면
const AboutScreen={
  render(){return `
<section class="screen" id="about" hidden>
  ${TopBar(`<span class="pill">서비스 소개</span><button class="ghost" id="aboutHome" style="margin-left:auto">처음으로</button><button class="btn" id="aboutGo" style="padding:10px 26px;font-size:18px">말씨와 시작하기</button>`)}
  <div class="abody">
    <div class="ahero">
      <div>
        <h2><br><em>어떻게 말해야 할지</em> 몰라 막막할 때가 있어요.</h2>
        <p>가족이나 친구가 우울, 불안, 중독으로 힘들어하면 무슨 말을 해줘야 할지 모르겠고, 결국 "힘내"라는 말밖에 떠오르지 않을 때가 있죠. 말씨는 그런 순간에 어떤 말을 건네야 할지 함께 고민해 주는 서비스예요. 상대의 상황을 함께 정리하고, 내 마음을 어떻게 전하면 좋을지 생각하면서 진심을 담은 첫마디를 준비할 수 있도록 도와줘요.
</p>
      </div>
      <img data-m="front" alt="새싹 머리를 한 말씨">
    </div>

    <div class="asec">
      <h3 class="t">말씨는 이렇게 도와드려요</h3>
      <div class="agrid">
        <div class="acard"><img data-m="listen" alt=""><h3>질문으로 상황 이해하기</h3><p>심리 면담 원리(CFI, FMI, SSCS)에 바탕을 둔 질문으로 그분의 상황과 당신의 마음을 차근차근 여쭤봐요. 답이 부족하면 한 번 더 구체적으로 물어요.</p></div>
        <div class="acard"><img data-m="ponder" alt=""><h3>배경 정리하기</h3><p>답변을 증상, 힘들게 하는 요인, 버팀목이 되는 요인으로 나누어 정리해요. 실제 상담 데이터에 쓰인 분류와 같은 기준이에요.</p></div>
        <div class="acard"><img data-m="cheer" alt=""><h3>말하는 방법 안내하기</h3><p>바로 쓸 수 있는 첫 문장, 해 보면 좋은 것과 피할 것, 다음 단계를 알려드려요. 상대방을 돕는 동안 지치거나 막막해진 당신의 마음도 함께 살펴봐요.</p></div>
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
        <li>당신과 함께 상황을 정리해요. 말씨는 답변을 바탕으로 상대방의 어려움과 당신의 마음을 이해하고, 서로에게 도움이 되는 대화 방법을 찾아가요.
</li>
        <li>실명 대신 별명이나 호칭으로도 충분해요. 기록은 이 브라우저에만 남아요.</li>
        <li>전문적인 도움의 필요성을 함께 살펴요. 말씨는 의료진이나 전문 상담사의 판단을 대신하지 않아요. 증상이나 어려움을 단정적으로 진단하지 않으며, 전문적인 도움이 필요해 보이는 경우 적절한 상담 및 지원 기관을 안내해요.</li>
        <li>당신을 평가하지 않아요. 어떻게 도와야 할지 몰라 막막한 마음도 괜찮아요. 모든 문제를 혼자 해결하려 하지 않아도 돼요. 말씨는 당신이 할 수 있는 다음 한 걸음을 함께 찾아요.
</li>
      </ul>
    </div>
  </div>
</section>`;},
  mount(){
    $("aboutHome").onclick=()=>show("start");
    $("aboutGo").onclick=begin;
  },
  open(){show("about");document.querySelector("#about .abody").scrollTop=0;}
};
