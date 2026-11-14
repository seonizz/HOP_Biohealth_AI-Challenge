// Shared, browser-only import contract. Server validates every normalized answer.
const TestInput = {
  maxBytes:262144,
  parse(text, questions) {
    if (new TextEncoder().encode(text).length > this.maxBytes) throw new Error('테스트 파일은 256 KiB 이내로 넣어 주세요.');
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('JSON 형식을 확인해 주세요. 예시 불러오기로 입력 형식을 확인할 수 있어요.'); }
    const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
    if (plain(data) && Object.hasOwn(data, 'cases') && !exact(data, ['cases'])) throw new Error('여러 사례는 cases 항목에 넣어 주세요.');
    const cases = plain(data) && Object.hasOwn(data, 'cases') ? data.cases : [data];
    if (!Array.isArray(cases) || !cases.length || cases.length > 20) throw new Error('한 번에 1~20개 사례를 넣어 주세요.');
    return cases.map((item, index) => {
      if (!exact(item, ['title','answers']) || !Object.hasOwn(item, 'answers')) throw new Error(`${index + 1}번 사례에 answers 항목이 필요해요.`);
      if (item.title !== undefined && (typeof item.title !== 'string' || item.title.length > 100)) throw new Error('사례 이름은 100자 이내로 적어 주세요.');
      const rows = Array.isArray(item.answers) ? item.answers : plain(item.answers)
        ? Object.entries(item.answers).map(([question_id, answer]) => ({ question_id, answer })) : null;
      if (!rows?.length) throw new Error(`${index + 1}번 사례에 답변을 넣어 주세요.`);
      const seen = new Set();
      const answers = rows.map(row => {
        if (!plain(row)) throw new Error('답변은 문항 ID와 답변으로 구성해 주세요.');
        const q = questions.find(question => question.id === row.question_id);
        if (!q || seen.has(q.id)) throw new Error(`알 수 없거나 중복된 문항 ID: ${String(row.question_id)}`);
        seen.add(q.id);
        const label = option => Array.isArray(option) ? option[0] : option;
        const optionIndex = value => {
          if (Number.isInteger(value) && value >= 0 && value < (q.opts?.length || 0)) return value;
          const found = typeof value === 'string' ? q.opts?.findIndex(option => label(option) === value) : -1;
          if (found === undefined || found < 0) throw new Error(`${q.id}: 문항 목록의 보기 문구 또는 0부터 시작하는 보기 번호를 사용해 주세요.`);
          return found;
        };
        let answer;
        if (Array.isArray(item.answers)) {
          if (!exact(row, ['question_id','text','selected','custom','skipped'])) throw new Error(`${q.id}: 지원하지 않는 답변 항목이 있어요.`);
          const { question_id, ...value } = row;
          answer = value;
        } else {
          const value = row.answer;
          if (value === null) answer = { skipped:true };
          else if (plain(value)) {
            if (!exact(value, ['text','selected','custom','skipped'])) throw new Error(`${q.id}: 지원하지 않는 답변 항목이 있어요.`);
            answer = { ...value };
          } else if (q.type === 'text' && typeof value === 'string') answer = { text:value };
          else if (q.type !== 'text' && Array.isArray(value)) answer = { selected:value };
          else if (q.type !== 'text' && typeof value === 'string') {
            const selected = q.opts.findIndex(option => label(option) === value);
            if (selected >= 0) answer = { selected:[selected] };
            else if (!q.noOwn) answer = { custom:value };
            else throw new Error(`${q.id}: 문항 목록에 있는 보기를 선택해 주세요.`);
          } else throw new Error(`${q.id}: 답변 형식을 확인해 주세요.`);
        }
        if (answer.selected !== undefined) {
          if (!Array.isArray(answer.selected)) throw new Error(`${q.id}: selected는 보기 배열이어야 해요.`);
          answer.selected = answer.selected.map(optionIndex);
        }
        return { question_id:q.id, ...answer };
      });
      return { title:item.title?.trim() || `테스트 ${index + 1}`, answers };
    });
  },
  example(questions) {
    if(questions.some(question=>question.id==='q3_01'))return JSON.stringify({title:'친구에게 연락 제안하기',answers:{
      q3_01:{selected:[1],custom:'금요일 저녁에 잠깐 통화하자고 제안하고 싶어요.'},
      q3_02:'친구',q3_03:'친구와 이번 주에 통화할 시간을 정하고 싶어요.',
      q3_08:{selected:[1],custom:'금요일 저녁 8시에 20분 정도 가능해요.'},
      q3_09:'가능한지 먼저 물어보고 싶어요.',
    }},null,2);
    const relation = questions.find(question => question.id === 'rel');
    const friend = relation?.opts.find(option => (Array.isArray(option) ? option[0] : option) === '친구');
    return JSON.stringify({ title:'친구에게 마음 전하기', answers:{
      name:'테스트 친구', want:'친구에게 부담을 주지 않고 이야기를 들어 주고 싶어요.',
      ...(friend ? { rel:'친구' } : {}),
      concern:'친구가 최근 일이 많아 피곤하다고 말했어요. 더 자세한 상황은 아직 몰라요.',
      moment:'어제 통화에서 피곤하다고 말했을 때 어떻게 답할지 망설였어요.',
      feeling:'걱정되지만 내 생각으로 단정하고 싶지는 않아요.',
    } }, null, 2);
  },
};
