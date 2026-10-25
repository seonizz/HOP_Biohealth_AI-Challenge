import { readFileSync } from 'node:fs';

export const REFERRAL_URGENCIES = Object.freeze(['immediate', 'soon', 'planned', 'undetermined']);
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const fail = () => { throw new Error('Invalid referral institution configuration'); };
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail();
}
function bookingUrl(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>\\{}]/u.test(value)) fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) fail();
  return url.href;
}

export function createReferralDirectory(config = JSON.parse(readFileSync(new URL('../seeds/referral-institutions.json', import.meta.url), 'utf8'))) {
  exact(config, ['schema_version', 'institutions']);
  if (config.schema_version !== '1.0' || !Array.isArray(config.institutions) || config.institutions.length > 500) fail();
  const records = new Map();
  for (const row of config.institutions) {
    exact(row, ['id', 'name', 'active', 'urgencies', 'phone', 'booking_url', 'last_verified_on']);
    if (typeof row.id !== 'string' || !ID.test(row.id) || records.has(row.id) ||
        typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || /[<>\u0000-\u001f]/u.test(row.name) ||
        typeof row.active !== 'boolean' || !Array.isArray(row.urgencies) || !row.urgencies.length ||
        new Set(row.urgencies).size !== row.urgencies.length || row.urgencies.some(value => !REFERRAL_URGENCIES.includes(value)) ||
        !(row.phone === null || typeof row.phone === 'string' && /^\+?[0-9][0-9 -]{1,28}[0-9]$/.test(row.phone)) ||
        typeof row.last_verified_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.last_verified_on) ||
        !Number.isFinite(Date.parse(row.last_verified_on)) || new Date(row.last_verified_on).toISOString().slice(0,10) !== row.last_verified_on) fail();
    const booking = bookingUrl(row.booking_url);
    if (!row.phone && !booking) fail();
    records.set(row.id, {...structuredClone(row), booking_url:booking});
  }
  const view = row => ({id:row.id, name:row.name, urgencies:[...row.urgencies], last_verified_on:row.last_verified_on,
    actions:[
      ...(row.phone ? [{kind:'phone', label:'전화 안내', href:`tel:${row.phone.replace(/[ -]/g, '')}`}] : []),
      ...(row.booking_url ? [{kind:'booking', label:'예약 페이지 열기', href:row.booking_url}] : []),
    ].map(action => ({...action, requires_user_action:true, shares_conversation:false,
      ...(action.kind === 'booking' ? {referrer_policy:'no-referrer', rel:'noopener noreferrer'} : {})}))});
  return Object.freeze({
    list: () => ({schema_version:'1.0', configured:records.size > 0,
      institutions:[...records.values()].filter(row => row.active).map(view)}),
    has: id => records.has(id),
    // Ranking/eligibility belong to the provider. An ordinary appointment must
    // never be presented as an immediate response to a current emergency.
    select: (ids, urgency) => ids.flatMap(id => {
      const row = records.get(id);
      if (!row?.active || !row.urgencies.includes(urgency)) return [];
      const institution = view(row);
      if (urgency === 'immediate') institution.actions = institution.actions.filter(action => action.kind === 'phone');
      return institution.actions.length ? [institution] : [];
    }),
  });
}
