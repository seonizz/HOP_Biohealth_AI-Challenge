import { statSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';

export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), {code}); };

// Check both the path and the opened descriptor: a replaced file must not turn
// into a blocking FIFO between checks. Bound bytes actually read, not just stat.
export function readJson(path) {
  if (!statSync(path).isFile()) fail('INPUT_NOT_REGULAR_FILE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail('INPUT_NOT_REGULAR_FILE');
    if (info.size > MAX_INPUT_BYTES) fail('INPUT_TOO_LARGE');
    const chunks = [];
    let total = 0;
    while (total <= MAX_INPUT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_INPUT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_INPUT_BYTES) fail('INPUT_TOO_LARGE');
      chunks.push(chunk.subarray(0, count));
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { fail('INVALID_JSON'); }
  } finally { closeSync(fd); }
}
