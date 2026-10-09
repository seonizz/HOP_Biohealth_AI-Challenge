// 백엔드 연결 지점: 지금은 규칙 기반 목업, 이후 fetch('/api/guide') → LLM → 자체 모델로 교체
// p.tags: 질문 보기에서 모은 태그 (questions.js의 t 메타)
const GOAL_LINES={
  goal_near:"무슨 일이 있어도 내가 옆에 있을게.",
  goal_worry:"네가 걱정돼서 하는 말이야. 탓하려는 게 아니야.",
  goal_treat:"혼자 견디지 않아도 돼. 괜찮다면 같이 이야기 나눌 곳을 알아보고 싶어.",
  goal_reduce:"당장 끊으라는 게 아니야. 조금씩 줄여 가는 방법을 같이 찾아보고 싶어.",
  goal_reconcile:"예전에 내 말 때문에 마음 상한 게 있었다면 미안해. 다시 잘 지내고 싶어."
};
// 도움받기 어려운 이유(14번)별로 덧붙이는 "이렇게 해 보세요"
const BARRIER_TIPS={
  bar_denial:"고치라는 말보다 \"요즘 이런 모습이 보여서 걱정됐어\"처럼 내가 본 것을 그대로 전하기",
  bar_refuse:"도움을 거절해도 다그치지 말고, 마음이 바뀌면 언제든 함께하겠다고 문 열어 두기",
  bar_stigma:"상담 내용은 비밀이 지켜진다는 점을 알려 주기",
  bar_cost:"정신건강복지센터처럼 비용 부담이 적은 곳부터 함께 알아보기",
  bar_time:"전화 상담(1577-0199)처럼 시간 부담이 적은 방법부터 제안하기",
  bar_where:"어디로 갈지 함께 찾아보기 (1577-0199에서 가까운 기관을 안내받을 수 있어요)",
  bar_bad:"전에 받은 도움이 맞지 않았다면, 다른 곳이나 다른 상담사도 있다고 알려 주기"
};
async function generateGuide(p){
  const has=t=>(p.tags||[]).includes(t);
  const top=Object.entries(p.scores).sort((a,b)=>b[1]-a[1])[0][0];
  const who=p.name||"그분";
  const want=p.want&&!p.want.startsWith("(")?p.want:"";
  const opener={우울:"요즘 많이 지쳐 보여서 마음이 쓰였어. 뭘 해결하려는 건 아니고, 그냥 어떻게 지내는지 듣고 싶어.",
    불안:"요즘 신경 쓰이는 게 많아 보이더라. 걱정되는 게 있으면 천천히 얘기해 줘도 돼. 서두르지 않아도 괜찮아.",
    중독:"너를 탓하려는 게 아니야. 요즘 혹시 힘든 일이 있는지 궁금했어. 네 얘기를 듣고 싶어."}[top];
  const lines=Object.keys(GOAL_LINES).filter(has).map(k=>GOAL_LINES[k]);
  if(!want&&!lines.length) lines.push("늘 곁에 있다는 걸 알아줬으면 해.");
  const body=[want&&`그리고 꼭 말하고 싶었던 건… ${want}.`,...lines,"지금 바로 대답하지 않아도 돼."].filter(Boolean).join(" ");

  const doList={우울:["판단하지 않고 들어 주기, 말 사이의 침묵도 기다려 주기","\"그렇게 느낄 수 있지\"처럼 감정을 그대로 인정하기","산책이나 식사처럼 작고 구체적인 함께하기 제안하기"],
    불안:["걱정을 반박하기보다 먼저 이름 붙여 주기","해결책보다 지금 여기로 돌아오게 도와주기","작은 약속이라도 예측 가능하게 지키기"],
    중독:["행동보다 사람에 대한 관심으로 시작하기","바뀌고 싶다는 말이 나오면 그 말을 되짚어 주기","감시 대신 함께 정한 작은 목표 세우기"]}[top];
  doList.push(...Object.keys(BARRIER_TIPS).filter(has).slice(0,2).map(k=>BARRIER_TIPS[k]));
  const avoid=["\"힘내\", \"다들 그래\", \"의지 문제야\" 같은 말","한 번의 대화로 결론을 내려는 압박"];
  if(has("bar_denial")||has("bar_refuse")) avoid.push("억지로 병원에 데려가거나 진단명을 붙이는 말");
  if(top==="중독") avoid.push("몰래 확인하거나 감시하는 것");
  if(has("goal_reconcile")) avoid.push("지난 일의 잘잘못을 따지는 대화");

  // 주변인(사용자) 입장에 대한 공감: 힘들었던 순간(SSCS 1)과 그때의 마음(SSCS 2)
  const t=`${p.moment||""} ${p.feeling||""}`;
  let feel=`${who}${josa(who,"을")} 위해 이렇게 시간을 내어 고민하는 것 자체가 이미 큰 돌봄이에요.`;
  if(/화|짜증|서운|속상|답답|원망/.test(t)) feel=`서운하고 답답한 마음이 드는 건 자연스러워요. 그건 당신이 잘못해서가 아니라, ${who}${josa(who,"이")} 지금 그만큼 버거운 상태라는 신호일 때가 많아요.`;
  else if(/무서|두려|불안|겁|걱정|조마/.test(t)) feel=`혹시 나쁜 일이 생길까 봐 조마조마한 마음, 충분히 이해해요. 그 걱정이 바로 ${who}${josa(who,"을")} 아끼는 마음이에요.`;
  else if(/미안|죄책|내 탓|잘못|자책/.test(t)) feel=`스스로를 탓하는 마음이 드셨군요. ${who}의 어려움은 당신 탓이 아니에요. 지금 이렇게 방법을 찾는 것만으로도 충분히 애쓰고 있어요.`;
  else if(/지쳐|지치|지침|힘들|버거|포기|막막/.test(t)) feel=`오랫동안 애써 오면서 많이 지치셨을 거예요. 그래도 포기하지 않고 다시 방법을 찾는 당신은 ${who}에게 든든한 사람이에요.`;
  if(has("cgfreq_daily")) feel+=" 이런 일이 거의 매일 있다면, 당신에게도 쉬어 갈 틈이 꼭 필요해요.";
  if(p.safety) feel+=" 위험한 신호를 마주하는 건 정말 무섭고 무거운 일이에요. 혼자 다 책임지려 하지 않으셔도 돼요.";

  // 당신을 위한 팁 (SSCS 3·5): 첫 번째는 공감 카드, 나머지는 다음 단계 카드에 보임
  const tips=["대화가 생각처럼 흘러가지 않아도 실패가 아니에요. 문을 두드린 것만으로 충분해요."];
  tips.push(has("cg_sleep")||has("cg_body")?"잠을 못 자거나 몸이 지쳤다면 당신의 건강부터 챙겨 주세요. 돌보는 사람이 버텨야 곁을 지킬 수 있어요.":"당신의 잠과 식사, 쉬는 시간도 함께 챙겨 주세요.");
  if(has("cg_notime")||has("cg_isolation")) tips.push("짧게라도 온전히 나를 위한 시간과 만남을 지켜 주세요.");
  if(has("cg_family_conflict")) tips.push("혼자 다 떠안지 말고 다른 가족과 역할을 나눠 보세요.");
  if(top==="중독") tips.push("중독은 가족도 함께 지치기 쉬워요. 중독관리통합지원센터의 가족 상담도 도움이 돼요.");
  else if(has("sup_none")||!(p.tags||[]).some(x=>x.startsWith("sup_"))) tips.push("가족도 정신건강복지센터(1577-0199)에서 상담을 받을 수 있어요.");
  const care={feel,tips:tips.slice(0,4)};

  const serious=p.scores[top]>=1.5||has("freq_high")||has("dur_long");
  const next=p.safety?"안전 신호가 있었어요. 대화 전후로 109 또는 1577-0199에 함께 연락해 보는 것을 먼저 생각해 주세요.":
    has("help_treat")?`${who}${josa(who,"이")} 이미 도움을 받고 있다면, 그 도움을 이어 가도록 곁에서 응원해 주는 것이 큰 힘이 돼요.`:
    serious?(top==="중독"?"오래 이어지고 있다면, 중독관리통합지원센터 상담을 \"같이 가 볼래?\" 하고 제안해 보세요.":"오래 이어지고 있다면, 정신건강복지센터나 병원 상담을 \"같이 가 볼래?\" 하고 제안해 보세요."):
    "부담 없는 다음 만남을 약속하며 대화를 마무리해 보세요.";
  return {top,care,script:`${opener}\n\n${body}`,doList,avoid,next};
}
