// Check fictional targets against the existing app's typed wire and saved schema.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { modelResponseFormat } from '../../app/src/model-schema.js';
import { validateSchema, canonicalAvoidCard, avoidCardDraftSchema } from '../../app/src/relationship-agent.js';

const root = path.resolve(process.argv[2]);
const partial = process.argv.includes('--partial');
const guide = modelResponseFormat({}, true).json_schema.schema.properties.guide;
const savedAvoid = { type: 'object', properties: { avoid: guide.properties.avoid }, required: ['avoid'], additionalProperties: false };
const seen = new Set();
let count = 0;
for (const name of fs.readdirSync(path.join(root, 'source')).filter(n => /^author_.*\.jsonl$/.test(n)).sort()) {
  const content = fs.readFileSync(path.join(root, 'source', name), 'utf8');
  if (!partial && !content.endsWith('\n')) throw new Error('Incomplete author file');
  const lines = content.split('\n');
  lines.pop();
  for (const line of lines) {
    const item = JSON.parse(line);
    if (seen.has(item.case_id)) throw new Error('Duplicate case ID');
    seen.add(item.case_id);
    try {
      validateSchema({ avoid: item.cards.avoid }, avoidCardDraftSchema(savedAvoid));
      const canonical = canonicalAvoidCard({ avoid: item.cards.avoid }, savedAvoid);
      // top is a schema-only fixture here; it is not a diagnostic training label.
      validateSchema({ top: '통합', ...item.cards, avoid: canonical.avoid }, guide);
    } catch (error) {
      throw new Error(`Case ${item.case_id} fails app schema: ${error.message}`);
    }
    count += 1;
  }
}
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = ['app/src/model-schema.js', 'app/src/relationship-agent.js'];
console.log(JSON.stringify({ status: 'passed', cases: count, field_targets: count * 5,
  typed_avoid_and_canonical_saved_schema: true, app_ui_changed: false,
  top_used_only_as_schema_fixture: true, app_request_transport_parity: false,
  contract_sha256: Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(project, name))).digest('hex')])) }));
