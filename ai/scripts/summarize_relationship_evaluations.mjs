import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeRuns } from './evaluation_evidence.mjs';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('usage: node summarize_relationship_evaluations.mjs RUN_DIRECTORY');
const reports = readdirSync(directory).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(resolve(directory,name), 'utf8')));
console.log(JSON.stringify({ schema_version:'1.0', groups:summarizeRuns(reports) }, null, 2));
