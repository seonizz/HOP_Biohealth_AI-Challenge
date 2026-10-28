import assert from 'node:assert/strict';

// Build a canonical URI after validation: pg must not reinterpret untrusted URI
// query options as a different host, port, user, database or socket path.
export function finalRehearsalConnection(connectionString, container) {
  assert.ok(connectionString && container, 'Set FINALS_TEST_DATABASE_URL and FINALS_TEST_CONTAINER');
  const url = new URL(connectionString);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Only PostgreSQL URIs are allowed');
  assert.ok(!connectionString.includes('?') && !connectionString.includes('#'), 'Query options and fragments are forbidden');
  assert.equal(url.hostname, '127.0.0.1', 'Only the explicit loopback address is allowed');
  assert.equal(url.pathname, '/finals_test', 'Only the dedicated finals_test database is allowed');
  assert.equal(url.username, 'finals_test', 'Only the dedicated finals_test user is allowed');
  assert.equal(url.password, '', 'Use only the disposable container without credentials');
  assert.match(url.port, /^[1-9][0-9]{0,4}$/, 'An explicit port is required');
  assert.ok(Number(url.port) <= 65535, 'Invalid port');
  assert.match(container, /^hop-finals-remediation-\d{8}(?:-[a-z0-9]+)?$/);
  return `postgresql://finals_test@127.0.0.1:${Number(url.port)}/finals_test`;
}
