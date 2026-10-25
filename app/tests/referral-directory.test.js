import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferralDirectory } from '../src/referral-directory.js';

const institution = (extra = {}) => ({id:'synthetic-center', name:'합성 검증 기관', active:true,
  urgencies:['planned', 'soon'], phone:'+82 10 0000 0000', booking_url:'https://counseling.example.invalid/book',
  last_verified_on:'2026-10-18', ...extra});
const config = (rows = [institution()]) => ({schema_version:'1.0', institutions:rows});
const reject = value => assert.throws(() => createReferralDirectory(value), /Invalid referral institution configuration/);

test('directory emits only user-initiated contact actions without sharing conversation', () => {
  const directory = createReferralDirectory(config()), result = directory.select(['synthetic-center'], 'planned');
  assert.equal(directory.list().configured, true);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].actions.map(action => action.href), ['tel:+821000000000', 'https://counseling.example.invalid/book']);
  for (const action of result[0].actions) {
    assert.equal(action.requires_user_action, true);
    assert.equal(action.shares_conversation, false);
  }
  assert.equal(result[0].actions[1].referrer_policy, 'no-referrer');
  assert.equal(result[0].actions[1].rel, 'noopener noreferrer');
});

test('inactive and unknown institutions are excluded and routine appointments never satisfy immediate urgency', () => {
  const directory = createReferralDirectory(config([
    institution(), institution({id:'inactive', active:false, urgencies:['immediate']}),
    institution({id:'urgent-center', urgencies:['immediate']}),
  ]));
  assert.deepEqual(directory.list().institutions.map(row => row.id), ['synthetic-center', 'urgent-center']);
  assert.deepEqual(directory.select(['synthetic-center', 'inactive', 'missing', 'urgent-center'], 'immediate').map(row => row.id), ['urgent-center']);
  assert.deepEqual(directory.select(['synthetic-center'], 'undetermined'), []);
});

test('empty directory reports unconfigured without inventing fallback contacts', () => {
  const directory = createReferralDirectory(config([]));
  assert.deepEqual(directory.list(), {schema_version:'1.0', configured:false, institutions:[]});
  assert.deepEqual(directory.select(['missing'], 'immediate'), []);
});

test('immediate urgency exposes phone contact only and excludes booking-only institutions', () => {
  const directory = createReferralDirectory(config([
    institution({id:'urgent-phone', urgencies:['immediate', 'planned']}),
    institution({id:'urgent-booking-only', urgencies:['immediate'], phone:null}),
  ]));
  const urgent = directory.select(['urgent-phone', 'urgent-booking-only'], 'immediate');
  assert.deepEqual(urgent.map(row => row.id), ['urgent-phone']);
  assert.deepEqual(urgent[0].actions.map(action => action.kind), ['phone']);
  assert.equal(urgent[0].actions[0].requires_user_action, true);
  assert.deepEqual(directory.select(['urgent-phone'], 'planned')[0].actions.map(action => action.kind), ['phone', 'booking']);
});

test('malformed configuration, duplicate IDs, unknown urgency and invalid contact dates fail closed', () => {
  for (const value of [null, [], {}, {schema_version:'2.0', institutions:[]}, {...config(), injected:true},
    config([institution(), institution()]), config([institution({id:'../invalid'})]),
    config([institution({name:'<script>bad</script>'})]), config([institution({active:'true'})]),
    config([institution({urgencies:[]})]), config([institution({urgencies:['planned', 'planned']})]),
    config([institution({urgencies:['low']})]), config([institution({phone:'tel:123'})]),
    config([institution({phone:null, booking_url:null})]), config([institution({last_verified_on:'2026-02-30'})]),
    config([institution({last_verified_on:'not-a-date'})]), config([institution({automatic_send:true})])]) reject(value);
  const missing = institution(); delete missing.booking_url; reject(config([missing]));
});

test('booking links reject executable, insecure, credential-bearing and local-address URLs', () => {
  for (const booking_url of ['javascript:alert(1)', 'data:text/html,hello', 'http://example.invalid/book',
    'https://user:secret@example.invalid/book', 'https://example.invalid/#fragment', '//example.invalid/book',
    'https://localhost/book', 'https://sub.localhost/book', 'https://127.0.0.1/book', 'https://2130706433/book',
    'https://[::1]/book', 'https://example.invalid/a b', 'https://example.invalid/<bad>',
    'https://example.invalid/\\bad', 'https://example.invalid/{patient}', 'not a URL']) {
    reject(config([institution({booking_url})]));
  }
});

test('caller mutations cannot rewrite registered contacts or urgency eligibility', () => {
  const input = config(), directory = createReferralDirectory(input);
  input.institutions[0].booking_url = 'https://changed.example.invalid';
  const view = directory.list(); view.institutions[0].actions[0].href = 'tel:999';
  view.institutions[0].urgencies.push('immediate');
  assert.equal(directory.list().institutions[0].actions[0].href, 'tel:+821000000000');
  assert.equal(directory.list().institutions[0].actions[1].href, 'https://counseling.example.invalid/book');
  assert.deepEqual(directory.select(['synthetic-center'], 'immediate'), []);
});
