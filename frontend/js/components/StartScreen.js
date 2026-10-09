// 1. 시작 화면
const StartScreen={
  render(){return `
<section class="screen" id="start">
  ${NavBar()}
  ${CrisisLine("위급할 땐 <b>109</b> 자살예방상담 · <b>1577-0199</b> 정신건강위기상담")}
  <div class="hero">
    <div>
      <h1>소중한 사람에게 건넬<br><em>첫 마디</em>를 함께 심어요</h1>
      <p class="lead">말씨가 몇 가지를 여쭤볼게요. 답해 주시면 그분의 상황을 함께 정리하고, 마음이 잘 닿는 말하기 방법을 알려드려요.</p>
      <button class="btn glow" id="go">말씨와 시작하기</button>
      <div class="steps">
        <div class="step"><img data-m="listen" alt=""><span>질문에 답하기<i>약 10~15분</i></span></div>
        <div class="step"><img data-m="ponder" alt=""><span>상황 정리<i>말씨가 생각해요</i></span></div>
        <div class="step"><img data-m="cheer" alt=""><span>말하는 방법<i>바로 쓸 수 있는 문장</i></span></div>
      </div>
      <p class="note" style="margin-top:22px">말씨는 진단이나 치료를 대신하지 않아요.</p>
    </div>
    <div class="stage">
      <div class="blob"></div>
      <img class="orbit o1" data-m="empathy" alt="">
      <img class="orbit o2" data-m="joy" alt="">
      <img class="orbit o3" data-m="thanks" alt="">
      <img class="main" data-m="hello_high" alt="손을 흔드는 말씨">
      <div class="bubble-tip">안녕하세요, 저는 말씨예요!</div>
    </div>
  </div>
</section>`;},
  mount(){
    $("go").onclick=begin;
    this.updRecN();
  },
  // "내 기록 (n)" 개수 표시
  updRecN(){const n=loadRecs().length;document.querySelectorAll(".recN").forEach(e=>e.textContent=n?`(${n})`:"");}
};
