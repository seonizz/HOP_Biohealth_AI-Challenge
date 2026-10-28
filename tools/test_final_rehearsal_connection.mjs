import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {finalRehearsalConnection} from './final_rehearsal_connection.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const {parse} = require('pg-connection-string');
const uri = 'postgresql://finals_test@127.0.0.1:54325/finals_test';
const container = 'hop-finals-remediation-20261027';

test('canonical URI resolves to exactly the approved disposable database', () => {
  for (const prefix of ['postgresql:', 'postgres:']) {
    const parsed = parse(finalRehearsalConnection(uri.replace('postgresql:', prefix), container));
    assert.equal(parsed.host, '127.0.0.1');
    assert.equal(parsed.port, '54325');
    assert.equal(parsed.user, 'finals_test');
    assert.equal(parsed.database, 'finals_test');
    assert.equal(parsed.password, '');
  }
});

for (const suffix of [
  '?host=192.0.2.1&port=5432&user=other', '?host=/tmp',
  '?host=%2Ftmp', '?port=5432', '?user=other', '?database=postgres',
  '?', '#ignored'
]) {
  test(`rejects connection option override ${suffix}`, () => {
    assert.throws(() => finalRehearsalConnection(uri + suffix, container));
  });
}

for (const [name, candidate] of [
  ['remote host', uri.replace('127.0.0.1', '192.0.2.1')],
  ['local socket', 'postgresql:///finals_test?host=/tmp'],
  ['wrong protocol', uri.replace('postgresql:', 'https:')],
  ['wrong user', uri.replace('finals_test@', 'other@')],
  ['wrong database', uri.replace('/finals_test', '/postgres')],
  ['missing port', uri.replace(':54325', '')],
  ['credentials', uri.replace('finals_test@', 'finals_test:secret@')]
]) {
  test(`rejects ${name}`, () => assert.throws(() => finalRehearsalConnection(candidate, container)));
}

test('rejects an unrelated container before Docker or database access', () => {
  assert.throws(() => finalRehearsalConnection(uri, 'hop-v11-live-db-20261017-r1'));
});
