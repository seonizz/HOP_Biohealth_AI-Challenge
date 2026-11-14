// Legacy-only DB fixtures use the bank archived by migration 010. New-default
// and v3 migration behavior is exercised separately by questionnaire-v3 tests.
// Call once after creating the disposable schema, never when reconnecting:
// reconnect tests must observe their administrative edits exactly as stored.
export async function restoreLegacyQuestionBank(store) {
  await store.transaction(async client => {
    const { rows:[{ schema }] } = await client.query('SELECT current_schema() AS schema');
    if (!/^(?:api_test_|test_|turn_api_|mixed_answer_|referral_api_)[a-z0-9_]+$/.test(schema || '')) {
      throw new Error('Legacy question fixtures require an isolated test schema');
    }
    const { rows } = await client.query('SELECT rows FROM question_bank_archive WHERE bundle_id=$1',
      ['before-malssi-intake-3.0.0-rc1']);
    if (rows.length !== 1 || !Array.isArray(rows[0].rows) || !rows[0].rows.length) {
      throw new Error('Archived legacy question fixture is missing');
    }
    await client.query("UPDATE questions SET enabled=FALSE WHERE id ~ '^q3_'");
    await client.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition,updated_at)
      SELECT id,kind,sort_order,enabled,subject,definition,updated_at
      FROM jsonb_to_recordset($1::jsonb)
      AS q(id TEXT,kind TEXT,sort_order INTEGER,enabled BOOLEAN,subject TEXT,definition JSONB,updated_at TIMESTAMPTZ)
      ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,sort_order=EXCLUDED.sort_order,
        enabled=EXCLUDED.enabled,subject=EXCLUDED.subject,definition=EXCLUDED.definition,updated_at=EXCLUDED.updated_at`,
    [JSON.stringify(rows[0].rows)]);
  });
}
