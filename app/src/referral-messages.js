import {readFileSync} from 'node:fs';
const URGENCIES = ['immediate', 'soon', 'planned', 'undetermined'];
// Developer-owned text only: no interpolation, model prose, or character prompts.
export function createReferralMessages(config = JSON.parse(readFileSync(new URL('../seeds/referral-messages.json', import.meta.url), 'utf8'))) {
  const invalid = () => { throw new TypeError('Invalid referral message configuration'); };
  const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  if (!keys(config, ['schema_version','messages']) || config.schema_version !== '1.0' || !keys(config.messages, URGENCIES)) invalid();
  const messages = new Map(), ids = new Set();
  for (const urgency of URGENCIES) {
    const item = config.messages[urgency];
    if (!keys(item, ['id','text']) || typeof item.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(item.id) || ids.has(item.id) ||
      typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)) invalid();
    ids.add(item.id); messages.set(urgency, Object.freeze({...item}));
  }
  return Object.freeze({get(urgency) {
    if (!messages.has(urgency)) throw new TypeError('Unknown referral urgency');
    return {...messages.get(urgency)};
  }});
}
