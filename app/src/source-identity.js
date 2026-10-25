import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Identify the checked-out application, never credentials or counselling text.
export function sourceFingerprint(backend) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes:true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(js|json|sql|html|css)$/.test(entry.name)) {
        files.push({ path:relative(backend, path), sha256:sha256(readFileSync(path)) });
      }
    }
  }
  for (const name of ['src', 'seeds', 'public', 'migrations']) visit(join(backend, name));
  for (const name of ['package.json', 'package-lock.json']) {
    files.push({ path:name, sha256:sha256(readFileSync(join(backend, name))) });
  }
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { sha256:sha256(JSON.stringify(files)), files };
}
