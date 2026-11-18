import { HttpError } from './errors.js';

const profileIds = new Set(['local12b', 'gpu31b']);
const distinctRoles = () => new HttpError(422, 'INVALID_MODEL_PROFILE', '대화와 분석·카드에 서로 다른 모델을 선택해 주세요.');
const roles = row => ({ question_profile_id: row.profile_id, result_profile_id: row.result_profile_id });

export async function readModelRoles(store, defaultId = 'local12b') {
  const result = await store.pool.query('SELECT profile_id,result_profile_id FROM model_selection WHERE singleton=TRUE');
  return roles(result.rows[0] ?? { profile_id: defaultId, result_profile_id: null });
}

export async function saveModelRoles(store, questionId, resultId) {
  if (!profileIds.has(questionId) || (resultId != null && !profileIds.has(resultId))) {
    throw new HttpError(422, 'INVALID_MODEL_PROFILE', '사용할 모델을 다시 선택해 주세요.');
  }
  try {
    const result = await store.pool.query(`INSERT INTO model_selection(singleton,profile_id,result_profile_id) VALUES (TRUE,$1,$2)
      ON CONFLICT (singleton) DO UPDATE SET profile_id=EXCLUDED.profile_id,
        result_profile_id=CASE WHEN $3 THEN EXCLUDED.result_profile_id ELSE model_selection.result_profile_id END,
        updated_at=CURRENT_TIMESTAMP RETURNING profile_id,result_profile_id`, [questionId, resultId ?? null, resultId !== undefined]);
    return roles(result.rows[0]);
  } catch (error) {
    // The row constraint also validates a legacy write that preserves a concurrent result selection.
    if (error.code === '23514' && error.constraint === 'model_selection_distinct_roles') throw distinctRoles();
    throw error;
  }
}
