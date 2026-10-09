// A fixed illustration for internal demos without a connected model.
// It never reads or summarizes the visitor's answers.
export const demoGuidance={
  supporter_acknowledgement:'상대에게 다가갈 말을 고민하는 마음 자체가 소중합니다.',
  situation_summary:'가상의 상황: 한 친구가 요즘 지쳐 보이지만, 무슨 일이 있는지는 아직 모릅니다.',
  suggested_words:[{text:'요즘 조금 지쳐 보여서 걱정됐어. 괜찮다면 이야기 들어줄게.',purpose:'상대의 선택을 존중하면서 대화를 시작하는 예시입니다.'}],
  actions:[{title:'부담 없는 안부 묻기',how:'편한 시간에 짧게 안부를 전하고, 답을 재촉하지 않습니다.',preconditions:['상대가 대화를 원하거나 여유가 있는지 살핍니다.'],stop_if:['상대가 대화를 원하지 않는다고 말합니다.']}],
  avoid:[{expression:'왜 말을 안 해?',reason:'답을 강요받는 느낌을 줄 수 있습니다.',alternative:'말하고 싶을 때 들어줄게.'}],
  supporter_care:['혼자 모든 문제를 해결하려 하지 않아도 됩니다.'],
  limitations:['이 내용은 고정된 가상 예시입니다. 입력한 답변을 분석하거나 개인화하지 않았습니다.'],
};
