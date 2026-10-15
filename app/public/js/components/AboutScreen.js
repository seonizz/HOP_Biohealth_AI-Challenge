// 서비스 화면은 이용 안내만 담습니다. 사용자 지정 원칙: docs/UI_CONTENT_POLICY.md
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
        <li class="it"><img data-m="listen" alt=""><h4>질문으로 상황 이해하기</h4><p>질문을 통해 그분의 상황과 당신의 마음을 차근차근 여쭤봐요. 답이 부족하면 한 번 더 구체적으로 물어요.</p></li>
        <li class="it"><img data-m="ponder" alt=""><h4>배경 정리하기</h4><p>들려주신 관찰과 걱정, 도움을 주고받은 상황을 함께 정리해요. 당사자의 마음이나 상태를 확정하지 않고, 아직 알기 어려운 부분도 남겨요.</p></li>
        <li class="it"><img data-m="cheer" alt=""><h4>말하는 방법 안내하기</h4><p>바로 쓸 수 있는 첫 문장, 해 보면 좋은 것과 피할 것, 다음 단계를 알려드려요. 상대방을 돕는 동안 지치거나 막막해진 당신의 마음도 함께 살펴봐요.</p></li>
      </ol>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">02</span><h3 class="t">본 그대로, 내 마음도 함께</h3></header>
      <div class="web">
        <div class="it"><img data-m="joy" alt=""><p>그분에게서 직접 보고 들은 일을 알려 주세요. 잘 모르겠는 내용은 <b>모른다고 답해도 괜찮아요.</b></p></div>
        <div class="it"><img data-m="hear" alt=""><p>전하고 싶은 말과 당신의 마음도 들려 주세요. <b>서로에게 부담이 덜한 첫마디</b>를 함께 준비해요.</p></div>
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
          <p>대화를 중단하거나 브라우저를 닫아도 저장 내용은 자동으로 삭제되지 않아요.</p>
          <p>완료 기록과 진행 중이거나 중단한 대화는 「내 기록」에서 하나씩 또는 모두 삭제할 수 있어요. 대화를 삭제하면 관련 결과도 함께 지워져요. 칼럼의 읽음·담음은 유지돼요.</p>
          <p>쿠키를 지우거나 접근 기간이 끝나면 기존 기록을 열거나 삭제할 수 없어요. 삭제가 필요하면 기록에 접근할 수 있을 때 진행해 주세요.</p>
        </details>
      </div>
    </section>
  </div>
</section>`;},
  mount(){},
  open(){show("about");window.scrollTo(0,0);this.animate();},
  // 열 때마다: 머리 부분은 바로, 아래 부분은 스크롤해서 화면에 들어올 때 차례로 떠오름
  animate(){
    const a=$("about"),hero=a.querySelector(".ahero");
    reveal([hero,...hero.children],{step:160});
    a.querySelectorAll(".asec").forEach(sec=>{
      reveal(sec.querySelectorAll(".ahead"),{scroll:true});
      reveal(sec.querySelectorAll(".it"),{scroll:true,step:110,start:120});
    });
  }
};
