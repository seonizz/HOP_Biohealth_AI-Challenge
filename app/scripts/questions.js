import { readFileSync } from 'node:fs';
import { Store, loadContentKey } from '../src/store.js';
import { createQuestionSet } from '../src/question-bank.js';

const [action, argument] = process.argv.slice(2);
const usage = 'npm run questions -- list|get ID|set FILE.json|disable ID|enable ID|delete ID';
if (!['list','get','set','disable','enable','delete'].includes(action) || (action !== 'list' && !argument)) {
  console.error(usage); process.exitCode = 1;
} else {
  let store;
  try {
    store = await Store.connect(process.env.DATABASE_URL, loadContentKey('./runtime/content.key'));
    if (action === 'list') {
      const { rows } = await store.pool.query('SELECT id,kind,sort_order,enabled,subject,definition FROM questions ORDER BY sort_order,id');
      console.log(JSON.stringify(rows.map(({ definition, ...row }) => ({ ...row, q:definition.q })), null, 2));
    } else if (action === 'get') {
      const { rows } = await store.pool.query('SELECT id,kind,sort_order,enabled,subject,definition FROM questions WHERE id=$1', [argument]);
      if (!rows.length) throw new Error('Question not found');
      console.log(JSON.stringify(rows[0], null, 2));
    } else {
      const edited = action === 'set' ? JSON.parse(readFileSync(argument, 'utf8')) : null;
      if (action === 'set' && (!edited || Array.isArray(edited) || !edited.id || Object.keys(edited).some(key => !['id','kind','sort_order','enabled','subject','definition'].includes(key)))) throw new Error('Invalid question row');
      await store.transaction(async client => {
        // Serialize local administrative writes so validation and mutation commit together.
        await client.query('LOCK TABLE questions IN SHARE ROW EXCLUSIVE MODE');
        if (edited) {
          // Disabled rows are also validated before they can be stored.
          const existing = (await client.query('SELECT id,kind,sort_order,enabled,subject,definition FROM questions ORDER BY sort_order,id')).rows;
          createQuestionSet([...existing.filter(row => row.id !== edited.id), { ...edited, enabled:true }]);
          if (typeof edited.enabled !== 'boolean') throw new Error('enabled must be boolean');
          await client.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,sort_order=EXCLUDED.sort_order,enabled=EXCLUDED.enabled,
            subject=EXCLUDED.subject,definition=EXCLUDED.definition,updated_at=CURRENT_TIMESTAMP`,
          [edited.id,edited.kind,edited.sort_order,edited.enabled,edited.subject,edited.definition]);
        } else {
          const result = action === 'delete'
            ? await client.query('DELETE FROM questions WHERE id=$1', [argument])
            : await client.query('UPDATE questions SET enabled=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1', [argument, action === 'enable']);
          if (!result.rowCount) throw new Error('Question not found');
        }
        const { rows } = await client.query('SELECT id,kind,sort_order,enabled,subject,definition FROM questions ORDER BY sort_order,id');
        createQuestionSet(rows);
      });
      console.log(JSON.stringify({ changed:edited?.id || argument, action, applies_to:'new_intakes' }));
    }
  } catch (error) {
    // Do not print connection strings, SQL parameters or credentials.
    console.error(error.code === 'QUESTION_BANK_INVALID' ? error.message : '질문 작업에 실패했습니다. DB 연결과 질문 파일 형식을 확인해 주세요.');
    process.exitCode = 1;
  } finally { await store?.close(); }
}
