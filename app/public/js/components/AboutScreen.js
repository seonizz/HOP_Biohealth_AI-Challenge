// 서비스 소개: 기존 화면 구성에 현재 질문 계약과 이용 안내를 반영합니다.
// 칸(상자)을 줄이고, 단계마다 번호·큰 여백으로 나눔. 숫자는 큰 숫자와 막대 그래프로
const ABOUT_SOURCES=[["우울증",484],["불안장애",487],["중독",448],["일반군 (비교용)",242]];
const ABOUT_LABELS=[["증상",28,"우울한 기분, 불안감, 갈망 등"],["위험요인",20,"사회적 지지 부족, 스트레스 사건 등"],["상담사의 개입",11,"공감과 지지, 명료화와 반영 등"],["개선요인",5,"정서적 변화, 변화 동기 증진 등"]];
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
      <header class="ahead"><span class="anum">02</span><div><span class="kicker">말씨에 맞게 새로 구성한 상담 데이터</span><h3 class="t">대화의 맥락을 담고, 필요한 안내로 이어지도록</h3></div></header>
      <p class="alead it">실제 상담실에서 오간 한국어 대화를 바탕으로, <b>말씨가 해야 할 일에 맞는 자료를 별도로 만들었어요.</b> 다음 질문을 고르는 것부터 인물과 상황을 정리하고, 잘못 이해한 내용을 확인하고, 근거에 맞게 안내 카드를 고치는 것까지 담았어요.</p>
      <p class="alead it">처음에는 앞선 상담 대화에 맞는 응답을 만드는 데 집중했어요. 이후에는 <b>대화에 없는 말을 덧붙이지 않고, 잘못된 답변을 찾아 바로잡는 일</b>을 더 다루도록 자료를 보완하고 추가 학습을 진행했어요.</p>
      <p class="note it">아래 숫자는 새로 만든 말씨 자료의 규모가 아니라, 개발에 참고한 AI허브 원천 자료의 공개 통계예요.</p>
      <p class="alead it">말씨 개발에서는 AI허브에 공개된 「심리상담 데이터」를 참고했어요. 공개 통계에는 우울증·불안장애·중독·일반군의 상담을 담은 원천 데이터 <b>1,661건</b>과 라벨링 데이터 <b>465,474건</b>이 안내되어 있어요.</p>
      <div class="bignums">
        <div class="it"><b>1,661<small>건</small></b><span>공개 통계의 원천 데이터</span></div>
        <div class="it"><b>4<small>개 집단</small></b><span>우울증·불안장애·중독·일반군</span></div>
        <div class="it"><b>46만<small>여 건</small></b><span>공개 통계의 라벨링 데이터</span></div>
        <div class="it"><b>64<small>개 항목</small></b><span>증상·위험·개선·상담 개입의 분류 항목</span></div>
      </div>
      <div class="charts">
        <figure class="chart it"><figcaption><b>어떤 대화가 담겨 있나요</b><span>원천 데이터 건수</span></figcaption>${aboutBars(ABOUT_SOURCES,"건","원천 데이터 건수")}</figure>
        <figure class="chart it"><figcaption><b>무엇을 표시했나요</b><span>분류 항목 64개의 구성</span></figcaption>${aboutBars(ABOUT_LABELS,"개","분류 항목 수")}</figure>
      </div>
      <div class="acc it">
        <details><summary>한 문장보다, 대화의 흐름을 살펴요<span>상담 대화의 구성</span></summary>
          <p>실제 상담 대화를 누가 어떤 순서로 말했는지에 맞춰 정리했어요. 내담자가 설명한 상황과 앞선 상담사의 말을 함께 보고, 그다음 상담사가 실제로 한 말을 연결했어요. 지나치게 단순하거나 맥락이 부족한 대화는 제외했어요.</p>
          <p>중복이나 빠진 내용, 대화의 길이와 과업별 분포도 점검했어요. 같은 사례가 학습 자료와 검증 자료에 함께 들어가지 않도록 나눴어요.</p></details>
        <details><summary>지금 필요한 질문을 고르기 위해<span>말씨에 맞춘 별도 자료</span></summary>
          <p>말씨의 질문과 안내에 필요한 자료도 별도로 구성했어요. 대화에 맞는 다음 질문을 고르고, 인물 관계와 상황을 정리하는 자료예요.</p>
          <p>앞뒤 내용이 달라지거나 답변에 오류가 있을 때, 무엇을 다시 확인해야 하는지도 다뤄요. 예를 들어 아버지 이야기를 하다가 동생 이야기로 바뀌면, 누구에 관한 말인지 구분해 확인하는 식이에요.</p></details>
        <details><summary>하지 않은 말을 덧붙이지 않도록<span>사실과 안내의 근거 확인</span></summary>
          <p>대화에서 실제로 나온 사실을 확인하고, 그 말을 정확하게 인용했는지 평가하는 자료를 구성했어요. 잘못된 안내를 찾아 고치고, 상황에 맞는 최종 안내 카드를 만드는 자료도 포함했어요.</p></details>
        <details><summary>말씨의 역할에 맞게 추가로 학습했어요<span>상담 응답에서 질문·사실·안내 검토로</span></summary>
          <p>Gemma 4 31B를 바탕으로, 먼저 상담의 앞뒤 흐름에 맞는 응답을 만드는 학습을 진행했어요. 이후 질문 선택, 인물 관계와 사실 파악, 오류 확인, 근거에 맞는 답변, 안내 카드 수정과 생성에 필요한 자료로 추가 학습했어요.</p>
          <p>정상 답변과 오류가 있는 답변을 함께 다뤄, 잘못된 답변은 찾아내고 괜찮은 답변은 유지하도록 보완했어요. 기존 모델의 가중치를 고정하고 일부 파라미터만 학습하는 LoRA 방식과 4비트 양자화를 사용했어요.</p></details>
        <details><summary>무엇이 좋아졌고, 무엇이 남았나요?<span>완료된 비교 평가 · 2026년 11월 15일</span></summary>
          <p>기존 추가 학습 모델 <b>step4723</b>과 개선 후보 <b>step5128</b>에 같은 입력과 생성 조건을 적용했어요. 정상 답변을 받아들이고 오류 답변을 걸러내는 능력에서 다음 변화가 확인됐어요.</p>
          <ul>
            <li>정상 답변을 올바르게 승인: <b>47.2% → 100.0%</b></li>
            <li>오류 답변을 올바르게 거절: <b>68.6% → 98.1%</b></li>
            <li>오류 항목과 실제 값·기대 값을 정확히 일치: <b>1.1% → 79.2%</b></li>
            <li>상태에 담긴 전체 사실을 정확히 일치: <b>37.8% → 54.4%</b></li>
          </ul>
          <p>이 평가는 <b>20개 원천 사례를 변형한 1,080개 입력</b>으로 진행했어요. 실제 상담 1,080건을 평가한 것은 아니에요. 사실 전체를 정확히 파악하는 능력은 더 개선해야 하고, 종합 평가 기준도 아직 충족하지 못했어요. 이 수치가 실제 이용에서의 정확도나 상담 효과를 뜻하지는 않아요.</p>
          <p><a href="https://github.com/seonizz/HOP_Biohealth_AI-Challenge/blob/668bc07/ai/docs/review_approval_bias_repair.md#31b-step4723--step5128" target="_blank" rel="noopener noreferrer">비교 평가의 조건과 한계 보기<span class="sr">(새 탭에서 열림)</span></a></p></details>
        <details><summary>다음으로 확인하고 있는 것들<span>추가 평가 진행 중 · 2026년 11월 19일 기준</span></summary>
          <p>이번에는 <b>31B 원본 모델과 step5128</b>을 같은 조건에서 비교하고 있어요. 필요한 질문을 잘 고르는지, 사실과 정정을 정확히 반영하는지, 정상 초안은 유지하고 잘못된 초안은 걸러내는지 확인하는 평가예요.</p>
          <p>자체 평가 336개와 과학 지식·추론을 확인하는 ARC-Challenge 200문항, ARC-Easy 200문항으로 구성해요. 모델당 736개, 두 모델 합계 1,472개 입력이며, 서로 다른 평가를 하나의 종합 점수로 합치지 않아요. <b>진행 중인 평가의 점수와 개선 여부는 완료 후 확정해요.</b></p>
          <p>ARC는 전체 시험이 아닌 일부 문항의 결과예요. 영문 과학 문제의 점수가 한국어 상담의 품질을 직접 보여 주지는 않아요. 이번 실행에는 사람의 품질 평가와 앱 전체 이용 과정의 평가는 포함하지 않아요.</p>
          <p>사람이 안내의 충실성과 실제 유용성을 살펴보는 평가는 별도 계획으로 두고 있어요. 모델의 평가 결과와 실제로 도움이 되는 경험을 구분해 확인하겠습니다.</p></details>
      </div>
      <p class="note it">공개 자료에는 이름 등 민감한 정보를 비식별 처리했다고 안내되어 있어요. <a href="https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=71806" target="_blank" rel="noopener noreferrer">AI허브 데이터 소개<span class="sr">(새 탭에서 열림)</span></a></p>
      <div class="learn it">
        <p class="learn-t">말씨는 답변을 정리할 때 <b>두 가지</b>를 살펴요</p>
        <div class="learn-row"><div><span>1</span><b>어떤 일이 있었는지</b><p>직접 보고 들은 일과 상대가 표현한 말을 살펴요.</p></div><i aria-hidden="true">→</i><div><span>2</span><b>어떤 도움을 원하는지</b><p>당신의 마음, 가능한 범위와 원하는 선택을 함께 살펴요.</p></div></div>
      </div>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">03</span><div><span class="kicker">자문을 바탕으로 다듬은 질문 · v3.1</span><h3 class="t">원하는 도움에 필요한 내용을 함께 정리해요</h3></div></header>
      <p class="alead it">질문의 출발점은 <b>상담사 자문을 바탕으로 정리한 v2 설계</b>예요. 상황과 내 생각·감정·행동을 나누어 살피고, 사건의 전후를 구분하며, 무엇을 할지는 이용자가 선택하도록 했어요. 질문을 많이 하기보다 <b>원하는 안내에 꼭 필요한 것을 묻는 것</b>을 중요하게 보았어요.</p>
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
      <div class="acc it">
        <details><summary>자문을 바탕으로 어떤 원칙을 세웠나요?<span>상황을 함께 이해하고, 선택은 존중하기</span></summary>
          <p>v2 설계는 인지행동치료(CBT)의 협력적 상황 평가를 참고했어요. 무슨 일이 있었는지, 나는 어떻게 받아들였는지, 어떤 감정을 느끼고 어떻게 행동했는지를 구분해 살펴보는 원리예요. 현실의 시간 부족이나 부담을 생각의 문제로 돌리거나, 이용자의 해석이 틀렸다고 먼저 가정하지 않아요.</p>
          <p>행동 ABC는 사건의 전후를 구분하는 데 참고했어요. 예를 들어 “내일 통화하자고 말했어요”에서 이미 한 일은 제안이고, 내일의 통화는 아직 일어나지 않은 일이에요. 어떤 일 뒤에 반응이 있었다고 해서 그 일이 원인이라고 단정하지 않아요.</p>
          <p>동기강화면담(MI)의 협력과 자율성 원칙도 참고했어요. “한 시간 도울 수 있어요”와 “돕고 싶어요”, “서로 돕기로 했어요”는 다른 뜻이에요. 가능한 범위, 본인의 의사, 서로의 합의를 구분하고 돕지 않거나 아직 정하지 않을 선택도 존중해요.</p>
          <p>이 원리들을 말씨의 질문 설계에 참고한 것이며, 말씨가 치료를 수행하거나 질문셋의 임상 효과가 검증됐다는 뜻은 아니에요.</p></details>
        <details><summary>왜 모든 질문을 다 묻지 않나요?<span>답이 안내를 바꿀 때만 확인하기</span></summary>
          <p>v2에서 정리한 기준은 “이 답을 알면 원하는 안내의 무엇이 달라질까?”예요. 거절하는 문장만 필요하다면 대안 시간까지 꼭 물을 이유는 없어요. 반대로 시간을 넣은 제안을 원한다면 가능한 시간을 확인해야 해요.</p>
          <p>이미 답한 내용은 활용하고, 모르는 내용은 없다고 바꾸지 않아요. 말하지 않은 사실이나 상대의 속마음을 채워 넣지 않고, 답하기 어려운 내용은 건너뛸 수 있게 해요. 질문을 끝까지 채우는 것보다 요청하신 도움을 근거에 맞게 드리는 것이 목적이에요.</p></details>
        <details><summary>어떻게 v3.1로 다듬었나요?<span>기본 구조는 유지하고, 문구 6개를 더 분명하게</span></summary>
          <p>v2에서는 질문이 필요한 조건과 사실·의사·합의를 구분하는 기준을 정리했어요. 이후 v3는 기본 질문 후보 9개와 필요한 때의 확인 질문 1개로 구성됐고, v3.1에서는 질문의 개수·ID·보기·입력 형식을 유지하면서 여섯 질문의 문구를 고쳤어요. 모든 질문에 답해야 한다는 뜻은 아니에요.</p>
          <ul>
            <li><b>상황과 관계를 함께:</b> “누구와의 어떤 일”인지 물어, 답에 관계가 담기면 따로 되묻지 않도록 했어요.</li>
            <li><b>해석보다 관찰:</b> 상대가 “실제로” 한 말과 행동을 물어요.</li>
            <li><b>이미 한 일과 앞으로 할 일 구분:</b> 나의 대응에는 “지금까지”, 가능한 일에는 “앞으로”와 “가능한 시간”을 넣었어요.</li>
            <li><b>도움을 원한다고 미리 정하지 않기:</b> 상대가 바란다고 했거나 하지 말아 달라고 한 것을 물어요.</li>
            <li><b>가능함과 원함 구분:</b> 할 수 있는 범위와 별개로, 이번 일에서 본인이 하고 싶은 것을 물어요.</li>
          </ul>
          <p>사용 과정에서 질문이 앞 단계로 되돌아가거나 시간을 다시 묻는 문제도 보완했어요. 이미 다룬 주제를 맞춤 질문으로 반복하거나, 무엇이 부족한지 없이 막연히 더 묻는 일을 제한했어요. 답변을 정정하면 바뀐 내용을 기준으로 필요한 질문을 다시 판단해요.</p>
          <p>문구 후보 비교와 가상 진행으로 개정안을 점검했어요. 이는 실제 이용자에게 효과가 입증됐다는 뜻은 아니며, 상담사 자문을 바탕으로 한 설계와 이후의 개발·검증 과정을 구분해 설명하고 있어요.</p>
          <p><a href="https://github.com/seonizz/HOP_Biohealth_AI-Challenge/blob/main/app/docs/QUESTIONNAIRE_DESIGN_BACKGROUND.md" target="_blank" rel="noopener noreferrer">질문 설계의 배경과 개정 근거 보기<span class="sr">(새 탭에서 열림)</span></a></p></details>
      </div>
    </section>

    <section class="asec">
      <header class="ahead"><span class="anum">04</span><h3 class="t">편한 때에, 편한 속도로 답할 수 있어요</h3></header>
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
          <p>「내 기록」에서 완료 기록의 보관키를 만들어 두면, 쿠키를 잃어도 보관기간 안에는 그 기록을 다시 열 수 있어요. 보관키를 가진 사람은 해당 기록과 대화 내용을 볼 수 있으니 안전하게 보관해 주세요. 키를 교체·해제하거나 기록이 삭제되면 사용할 수 없어요.</p>
          <p>「내 기록」에서 삭제 키를 만들어 따로 보관하면 쿠키를 잃은 뒤에도 그 키에 연결된 대화들을 삭제할 수 있어요. 보관키로 기록을 열어도 보관기간이 연장되지는 않아요.</p>
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
