import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, MAX_INPUT_BYTES } from './model_test_io.mjs';

const temporary = action => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'hop-json-input-'));
  try { return action(directory); }
  finally { fs.rmSync(directory, {recursive:true, force:true}); }
};

test('regular JSON supports UTF-8 and exact byte limit; malformed and oversized input fails', () => temporary(directory => {
  const path = join(directory, 'input.json');
  fs.writeFileSync(path, JSON.stringify({text:'합성 입력'}));
  assert.deepEqual(readJson(path), {text:'합성 입력'});
  fs.writeFileSync(path, ' '.repeat(MAX_INPUT_BYTES - 2) + '{}');
  assert.deepEqual(readJson(path), {});
  fs.appendFileSync(path, ' ');
  assert.throws(() => readJson(path), {code:'INPUT_TOO_LARGE'});
  fs.writeFileSync(path, '{');
  assert.throws(() => readJson(path), {code:'INVALID_JSON'});
  assert.throws(() => readJson(directory), {code:'INPUT_NOT_REGULAR_FILE'});
}));

test('FIFO without a writer is rejected promptly in a bounded subprocess', () => temporary(directory => {
  const path = join(directory, 'input.fifo');
  execFileSync('mkfifo', [path]);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {readJson} from ${JSON.stringify(new URL('./model_test_io.mjs', import.meta.url).href)};
     try {readJson(process.argv[1]); process.exitCode=1;} catch(error) {console.log(error.code);}`,
    path], {encoding:'utf8', timeout:3000});
  assert.equal(output.trim(), 'INPUT_NOT_REGULAR_FILE');
}));

test('stale size metadata cannot bypass actual read bound and descriptors close on failure', t => temporary(directory => {
  const path = join(directory, 'growing.json');
  fs.writeFileSync(path, ' '.repeat(MAX_INPUT_BYTES + 100) + '{}');
  const originalFstat = fs.fstatSync, originalRead = fs.readSync, originalClose = fs.closeSync;
  let bytes = 0, closed = 0;
  t.mock.method(fs, 'fstatSync', fd => Object.assign(originalFstat(fd), {size:0}));
  t.mock.method(fs, 'readSync', (...args) => {const count=originalRead(...args); bytes+=count; return count;});
  t.mock.method(fs, 'closeSync', fd => {closed++; return originalClose(fd);});
  syncBuiltinESMExports();
  try {
    assert.throws(() => readJson(path), {code:'INPUT_TOO_LARGE'});
    assert.equal(bytes, MAX_INPUT_BYTES + 1);
    assert.equal(closed, 1);
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
}));

test('descriptor is rechecked if a regular path changes to a nonregular object', t => temporary(directory => {
  const path = join(directory, 'input.json');
  fs.writeFileSync(path, '{}');
  const originalClose = fs.closeSync;
  let closed = 0;
  t.mock.method(fs, 'fstatSync', () => ({isFile:()=>false, size:0}));
  t.mock.method(fs, 'closeSync', fd => {closed++; return originalClose(fd);});
  syncBuiltinESMExports();
  try {
    assert.throws(() => readJson(path), {code:'INPUT_NOT_REGULAR_FILE'});
    assert.equal(closed, 1);
  } finally {t.mock.restoreAll(); syncBuiltinESMExports();}
}));
