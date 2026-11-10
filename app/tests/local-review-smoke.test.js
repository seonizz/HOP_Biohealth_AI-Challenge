import test from 'node:test';
import assert from 'node:assert/strict';
import {localReviewSmoke} from '../scripts/local-review-smoke.js';

test('the local-only smoke rejects GPU/remote destinations before sending any request',async()=>{
  for(const baseUrl of ['http://165.194.161.61:20522/v1','http://192.168.123.175:11434/v1','http://127.0.0.1.remote.invalid/v1','http://user:secret@localhost:11434/v1','http://localhost:11434/v1?remote=1'])
    await assert.rejects(localReviewSmoke({baseUrl,fetchImpl:()=>assert.fail('Remote request prohibited')}),/only the local/);
  await assert.rejects(localReviewSmoke({model:'malssi-gemma4-31b-cards-final-step4723',fetchImpl:()=>assert.fail('Production model prohibited')}),/only the local/);
});
