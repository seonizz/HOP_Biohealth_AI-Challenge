// 질문셋 (질문 정리.txt: CFI·FMI 기반 그분의 상황 + SSCS 기반 당신의 마음 + 전하고 싶은 말)
// {name} = 호칭, {name:은}/{name:이}/{name:을}/{name:와} = 받침에 맞춰 조사 자동 처리
// 보기 메타: d/a/x 우울·불안·중독 가중치, s 증상 라벨, r 위험 요인, p 보호 요인 → 프론트는 계산하지 않고 모델에 그대로 보냄(목업은 이 값으로 계산)
//           t 흐름 태그(질문 분기·가이드에 씀), none 다른 보기와 함께 고를 수 없음, input 고르면 직접 입력창이 열림
// 문항 속성: sec 단계 이름, intro 질문 전 안내, when 보일 조건, cue 모델이 신호를 읽을 자유 서술, noOwn 직접 입력 숨김, noSkip 건너뛰기 숨김(네/아니요 질문), rare 자주 못 보는 사이일 때 바꿔 쓸 질문 문구,
//           required 핵심 정보라 건너뛸 수 없고 빈 답도 받지 않음
// 연락 빈도에서 "그보다 드물게"를 고르면 요즘 모습을 잘 모를 수 있어 문구를 바꿔 물음
const RARE=s=>s.tags.has("rare_contact");
const Q = [
 {id:"name",required:true,sec:"시작",face:"hello",q:"오늘 이야기할 분을 어떻게 부르면 될까요?\n이름이나 별명, 호칭 무엇이든 괜찮아요.",why:"기록의 제목으로 쓰여요. 이 브라우저에만 저장돼요.",type:"text",ph:"예: 엄마, 친구 지수",short:true},

 // 전하고 싶은 말 (모델이 이후 필요한 질문만 고를 수 있도록 맨 앞에서 목적을 먼저 물음)
 {id:"want",required:true,sec:"전하고 싶은 말",face:"thanks",intro:"먼저 {name}에게 건네고 싶은 마음부터 여쭤볼게요. 그 마음이 잘 닿도록 필요한 이야기를 이어서 함께 살펴볼게요.",q:"{name}에게 꼭 전하고 싶은 말이 있다면 무엇인가요?",why:"당신의 진심을 그분이 받아들이기 쉬운 말로 옮겨 드릴게요.",type:"text",ph:"예: 네 편이라는 것, 병원에 같이 가 보자는 것"},
 {id:"goal",sec:"전하고 싶은 말",face:"cheer",q:"그 말을 통해 바라는 것은 무엇인가요?",type:"multi",opts:[
   ["내가 곁에 있다는 걸 알리고 싶어요",{t:"goal_near"}],["상담이나 진료를 권하고 싶어요",{t:"goal_treat"}],["술·도박 등을 줄이자고 말하고 싶어요",{t:"goal_reduce"}],
   ["걱정된다는 마음을 전하고 싶어요",{t:"goal_worry"}],["예전 갈등을 풀고 싶어요",{t:"goal_reconcile"}]]},

 // A. 관계
 {id:"rel",required:true,sec:"관계",face:"hello",q:"{name:와} 어떤 관계인가요?",type:"one",opts:["부모","자녀","배우자·연인","형제자매","친구","직장 동료"]},
 {id:"contact",sec:"관계",face:"listen",q:"{name:와} 평소 얼마나 자주 만나거나 연락하세요?",type:"one",opts:["함께 살아요","일주일에 몇 번","한 달에 몇 번",["그보다 드물게",{t:"rare_contact"}]]},

 // B. 현재 겪고 있는 어려움
 {id:"mood",required:true,sec:"현재 겪고 있는 어려움",face:"listen",q:"요즘 {name}에게서 보이는 모습을 모두 골라 주세요.",rare:"마지막으로 {name:을} 보거나 연락했을 때 보인 모습을 모두 골라 주세요.\n다른 사람에게 전해 들은 모습도 괜찮아요.",type:"multi",cue:true,groups:[
   ["기분과 의욕",[
     ["자주 우울하거나 가라앉아 보여요",{d:2,s:"depressive_mood"}],["좋아하던 일에 흥미를 잃었어요",{d:2,s:"anhedonia"}],
     ["잠을 잘 못 자거나, 반대로 너무 많이 자요",{d:1,s:"sleep_disturbance"}],["늘 피곤해하고 기운이 없어 보여요",{d:1,s:"fatigue"}],
     ["식사량이 눈에 띄게 줄었거나 늘었어요",{d:1,s:"weight_appetite"}],["자신을 탓하거나 \"나는 쓸모없다\"는 말을 해요",{d:2,s:"worthlessness"}],
     ["집중을 잘 못 해요 (TV, 대화, 일 등)",{d:1,s:"concentration"}],["말이나 행동이 눈에 띄게 느려졌거나, 반대로 안절부절못해요",{d:1,s:"psychomotor"}],
     ["죽고 싶다거나 사라지고 싶다는 말 또는 행동을 했어요",{d:2,s:"suicidal"}]]],
   ["걱정과 긴장",[
     ["초조하거나 긴장한 모습이 자주 보여요",{a:2,s:"anxiety_mood"}],["걱정을 멈추지 못하는 것 같아요",{a:2,s:"uncontrollable_worry"}],
     ["여러 가지 일을 지나치게 걱정해요",{a:1,s:"excessive_worry"}],["편하게 쉬지 못해요",{a:1,s:"trouble_relaxing"}],
     ["가만히 있지 못하고 안절부절해요",{a:1,s:"restlessness"}],["쉽게 짜증을 내거나 화를 내요",{a:1,s:"irritability"}],
     ["무슨 나쁜 일이 생길 것처럼 불안해해요",{a:1,s:"fear_of_catastrophe"}]]],
   ["술·약물·도박·게임 등의 사용",[
     ["하려던 것보다 더 많이, 더 오래 해요",{x:2,s:"loss_of_control"}],["그것을 하고 싶어 하는 모습이 강하게 보여요",{x:2,s:"craving"}],
     ["못 하게 되면 예민해지거나 몸이 불편해 보여요",{x:2,s:"withdrawal"}],["그것 때문에 일, 학업, 집안일을 소홀히 해요",{x:1,s:"role_failure"}],
     ["그것 때문에 가족이나 주변 사람과 갈등이 생겨요",{x:1,s:"social_problems"}]]],
   ["",[["특별히 관찰된 변화가 없음",{none:1,t:"no_change"}]]]]},
 {id:"dur",required:true,sec:"현재 겪고 있는 어려움",face:"listen",when:s=>!s.tags.has("no_change")||!!s.ans.mood?.custom,q:"이런 모습이 보인 지 얼마나 됐나요?",rare:"이런 모습을 처음 알게 된 지 얼마나 됐나요?",type:"one",noOwn:true,
   opts:["2주 미만","2주~1개월",["1~6개월",{t:"dur_long"}],["6개월~1년",{t:"dur_long"}],["1년 이상",{t:"dur_long"}],"잘 모르겠어요"]},
 {id:"freq",required:true,sec:"현재 겪고 있는 어려움",face:"listen",when:s=>!s.tags.has("no_change")||!!s.ans.mood?.custom,q:"최근 2주 동안 이런 모습은 얼마나 자주 보였나요?",rare:"최근 2주 동안 이런 모습을 얼마나 자주 보거나 전해 들었나요?",type:"one",noOwn:true,
   opts:[["거의 없었어요",{t:"freq_low"}],"며칠 정도",["절반 이상",{t:"freq_high"}],["거의 매일",{t:"freq_high"}],["최근에 보거나 연락하지 못해서 잘 모르겠어요",{t:"freq_unknown"}]]},
 {id:"describe",sec:"현재 겪고 있는 어려움",face:"hear",q:"다른 가족이나 친구에게 {name:의} 상황을 설명한다면, 어떻게 말씀하시겠어요?",type:"text",cue:true,ph:"예: 요즘 회사 일로 많이 지쳐서 주말엔 잠만 자요"},
 {id:"concern",required:true,sec:"현재 겪고 있는 어려움",face:"empathy",q:"{name:의} 모습 중 가장 걱정되거나 마음에 걸리는 부분은 무엇인가요?",rare:"{name:의} 모습 중 가장 걱정되거나 마음에 걸리는 부분은 무엇인가요?\n마지막으로 봤을 때의 모습이나 전해 들은 이야기도 괜찮아요.",type:"text",cue:true,ph:"예: 밥을 거의 안 먹는 게 제일 걱정돼요"},

 // C. 어려움의 원인과 생활환경
 {id:"cause",sec:"어려움의 원인과 생활환경",face:"ponder",q:"{name:이} 현재 어려움에 영향을 준 경험이나 상황이 있었을까요?",type:"one",noOwn:true,noSkip:true,opts:["네","아니요"]},
 {id:"events",sec:"어려움의 원인과 생활환경",face:"ponder",q:"최근 1년 사이 {name}에게 있었던 일을 모두 골라 주세요.",type:"multi",when:s=>s.ans.cause?.sel[0]===0,opts:[
   ["이별·이혼",{r:"breakup"}],["가까운 사람과의 사별",{r:"bereavement"}],["실직·퇴사·휴학",{r:"job_school_loss"}],["경제적 어려움",{r:"financial_difficulty"}],
   ["이사·환경 변화",{r:"environment_change"}],["본인 또는 가족의 질병",{r:"illness"}],["학업·업무 스트레스",{r:"academic_work_stress"}],["대인관계 갈등",{r:"interpersonal_conflict"}],
   ["없어요",{none:1}]]},
 {id:"others_why",sec:"어려움의 원인과 생활환경",face:"hear",q:"가족이나 주변 사람들은 {name:이} 왜 힘들어한다고 이야기하나요?",type:"text",cue:true,ph:"예: 승진에서 떨어지고 나서부터라고들 해요"},
 {id:"support",sec:"어려움의 원인과 생활환경",face:"joy",q:"{name}에게 힘이 되어 주는 사람, 관계, 활동이 있나요?",type:"one",noOwn:true,noSkip:true,opts:[
   ["네",{input:true,ph:"예: 교회 친구들, 강아지 산책",p:"social_support"}],["아니요",{r:"lack_of_support"}]]},
 {id:"burden",sec:"어려움의 원인과 생활환경",face:"think",q:"반대로, {name:을} 더 힘들게 하거나 회복을 어렵게 하는 생활 속 부담이 있을까요?",type:"one",noOwn:true,noSkip:true,opts:[
   ["네",{input:true,ph:"예: 빚 문제, 야근이 많은 회사",r:"life_burden"}],"아니요"]},

 // D. 생활 배경과 가치관
 {id:"values",sec:"{name:의} 생활 배경과 가치관",face:"ponder",q:"{name:을} 이해하려면 알아 두면 좋을 생활 배경이나 중요하게 여기는 가치가 있을까요?\n(예: 가족 안에서의 역할, 종교, 직업, \"약한 모습을 보이면 안 된다\"는 생각 등)",type:"text",ph:"예: 맏이라서 집안을 책임져야 한다고 생각해요"},
 {id:"values_effect",sec:"{name:의} 생활 배경과 가치관",face:"think",q:"이러한 생활 배경이나 가치관이 {name:의} 현재 어려움에 어떤 영향을 주는 것 같나요?",type:"text",ph:"예: 힘들다는 말을 못 하고 혼자 참는 것 같아요"},
 {id:"extra",sec:"{name:의} 생활 배경과 가치관",face:"empathy",q:"{name:와} 관련해서 따로 걱정되는 부분이 있다면 들려주세요.",type:"text",cue:true,ph:"없으면 \"없어요\"라고 적어도 괜찮아요"},

 // E. 지금까지의 대처와 도움
 {id:"coping",sec:"지금까지의 대처와 도움",face:"listen",q:"{name:은} 현재의 어려움을 해결하거나 견디기 위해 어떤 방법을 사용해 왔나요?",type:"text",cue:true,ph:"예: 술을 마시거나, 친구를 만나 이야기해요"},
 {id:"help",sec:"지금까지의 대처와 도움",face:"listen",q:"{name:이} 지금까지 받아 본 도움을 모두 골라 주세요.",type:"multi",opts:[
   ["정신건강의학과 진료",{p:"accepting_attitude",t:"help_treat"}],["약물 치료",{p:"accepting_attitude",t:"help_treat"}],["심리상담",{p:"accepting_attitude",t:"help_treat"}],
   ["정신건강복지센터·중독관리센터",{p:"accepting_attitude",t:"help_treat"}],["학교·직장 상담",{p:"accepting_attitude",t:"help_treat"}],["종교 기관",{t:"help_religion"}],
   ["가족·친구의 도움",{p:"social_support"}],["아직 받은 적 없어요",{none:1,t:"help_none"}],["잘 모르겠어요",{none:1}]]},
 {id:"barrier",sec:"지금까지의 대처와 도움",face:"ponder",q:"{name:이} 필요한 도움을 받는 데 어려웠던 점을 모두 골라 주세요.",type:"multi",opts:[
   ["본인이 문제라고 생각하지 않아요",{t:"bar_denial"}],["본인이 도움받기를 거부해요",{t:"bar_refuse"}],["주변 시선이 신경 쓰여요",{t:"bar_stigma"}],
   ["비용이 부담돼요",{t:"bar_cost"}],["시간을 내기 어려워요",{t:"bar_time"}],["어디로 가야 할지 몰라요",{t:"bar_where"}],
   ["전에 받은 도움이 별로였어요",{t:"bar_bad"}],["없어요",{none:1}]]},

 // F. 현재 필요한 도움
 {id:"need",required:true,sec:"현재 필요한 도움",face:"think",q:"현재 {name}에게 가장 필요하다고 생각하는 도움은 무엇인가요?",type:"text",ph:"예: 전문가 상담, 푹 쉴 수 있는 시간"},
 {id:"others_help",sec:"현재 필요한 도움",face:"hear",q:"가족이나 주변 사람들은 {name}에게 어떤 도움을 권하고 있나요?",type:"text",ph:"예: 병원에 가 보라고 해요"},

 // SSCS 기반: 당신의 마음
 {id:"moment",required:true,sec:"당신의 마음",face:"empathy",intro:"이제 당신에 대해 여쭤볼게요. 누군가를 곁에서 돕는 일은 생각보다 많이 지치는 일이에요.",q:"요즘 {name:의} 일로 가장 마음이 쓰이거나 힘들었던 순간은 언제였나요?",type:"text",ph:"예: 새벽까지 연락이 안 됐을 때"},
 {id:"moment_freq",sec:"당신의 마음",face:"listen",q:"그런 일은 얼마나 자주 있나요?",type:"one",noOwn:true,opts:[["거의 매일",{t:"cgfreq_daily"}],"일주일에 몇 번","한 달에 몇 번","가끔"]},
 {id:"feeling",sec:"당신의 마음",face:"hear",q:"그 순간 당신의 마음은 어떠셨어요?",type:"text",ph:"예: 무섭고, 내가 뭘 잘못했나 싶었어요"},
 {id:"cgchange",sec:"당신의 마음",face:"empathy",q:"{name:을} 돕는 동안 당신에게 생긴 변화를 모두 골라 주세요.",type:"multi",opts:[
   ["잠을 잘 못 자요",{t:"cg_sleep"}],["몸이 자주 아프거나 지쳐요",{t:"cg_body"}],["일이나 공부에 집중하기 어려워요",{t:"cg_focus"}],
   ["개인 시간이 거의 없어요",{t:"cg_notime"}],["다른 사람을 만나는 일이 줄었어요",{t:"cg_isolation"}],["다른 가족과 갈등이 생겼어요",{t:"cg_family_conflict"}],
   ["경제적 부담이 커졌어요",{t:"cg_money"}],["특별한 변화는 없어요",{none:1}]]},
 {id:"cgchange_more",sec:"당신의 마음",face:"hear",q:"위의 변화에 대해 더 들려주고 싶은 게 있다면 적어 주세요.",type:"one",noOwn:true,noSkip:true,
   when:s=>[...s.tags].some(t=>t.startsWith("cg_"))||!!s.ans.cgchange?.custom,opts:[["네",{input:true,ph:"예: 저도 요즘 출근이 힘들어요"}],"없어요"]},
 {id:"mycoping",sec:"당신의 마음",face:"listen",q:"힘든 상황이 생기면 당신은 보통 어떻게 하세요?\n해 봤던 방법 중 도움이 된 것과 그렇지 않았던 것이 있다면 들려주세요.",type:"text",ph:"예: 친구에게 털어놓으면 좀 나아졌어요"},
 {id:"mysupport",sec:"당신의 마음",face:"joy",q:"이 어려움을 나누거나 기댈 수 있는 곳을 모두 골라 주세요.",type:"multi",opts:[
   ["가족",{t:"sup_family"}],["친구",{t:"sup_friend"}],["같은 상황을 겪는 사람들(자조모임 등)",{t:"sup_peer"}],["상담사·의료진",{t:"sup_pro"}],
   ["종교 공동체",{t:"sup_religion"}],["아직 없어요",{none:1,t:"sup_none"}]]}
];
// 묶음(groups)으로 적은 보기를 한 줄로 펼침 (보기마다 묶음 이름 g를 붙임)
Q.forEach(q=>{if(q.groups)q.opts=q.groups.flatMap(([g,os])=>os.map(([t,m])=>[t,{...m,g}]));});

// ── 후속 질문 알고리즘 ──
// 1) 문항 단위: 답이 비었거나 짧거나 모호하면 그 문항에 맞춘 후속 질문을 한 번 던지고(q), 답을 합침(merge)
// 2) 마무리 전: 가이드 생성에 꼭 필요한 정보가 비었으면 보충 질문 (conversation.js의 gapCheck)
const VAGUE=/^(몰라|모르겠|글쎄|그냥|별로|없어|없음|음+|\.+|ㅇ+|-)$|모르겠|잘 모르/;
function isThin(t,min=10){t=(t||"").trim();return !t||t.startsWith("(")||t.length<min||VAGUE.test(t);}
const FOLLOW={
  rel:{when:a=>a.custom&&isThin(a.custom,2),q:{type:"text",q:"조금만 더 알려 주세요. {name:와}는 어떤 사이인가요?",ph:"예: 대학 때부터 친한 친구",short:true},
    merge:(a,r)=>isThin(r.text,1)?a:{text:r.text,sel:[]}},
  mood:{when:a=>!a.sel.length&&isThin(a.custom,6),q:{type:"text",q:"골라 주신 항목은 없었어요. 요즘 {name}에게서 '평소와 다르다'고 느낀 순간이 있다면 하나만 적어 주세요.",ph:"예: 주말 내내 방에서 안 나와요"},
    merge:(a,r)=>isThin(r.text,1)?a:{...a,custom:r.text}},
  concern:{when:a=>isThin(a.text,8),q:{type:"text",q:"짧게라도 괜찮아요. 요즘 {name:을} 보며 마음이 덜컥했던 장면 하나만 떠올려 적어 주세요.",ph:"예: 방에서 며칠째 안 나왔을 때"},
    merge:(a,r)=>isThin(r.text,1)?a:{text:r.text,sel:[]}},
  feeling:{when:a=>isThin(a.text,4),q:{type:"multi",q:"말로 꺼내기 어려우시죠. 가장 가까운 마음을 골라 주세요.",opts:["속상하고 서운했어요","무섭고 걱정됐어요","내 탓 같아 미안했어요","지치고 막막했어요","화가 났어요"]},
    merge:(a,r)=>isThin(r.text,1)||r.text==="해당 없음"?a:{text:r.text,sel:[]}}
};

// 보기 읽기 도우미: 보기는 "라벨" 또는 ["라벨", 메타]
const optLabel=o=>Array.isArray(o)?o[0]:o, optMeta=o=>Array.isArray(o)?o[1]||{}:{};
