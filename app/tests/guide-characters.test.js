import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterRegistry } from '../src/guide-characters.js';
import { readFileSync } from 'node:fs';

const config = () => ({schema_version:'1.0', default_character_id:'bulssi', characters:[
  {id:'bulssi', display_name:'불씨', avatar_path:null, state_assets:{}},
  {id:'other', display_name:'다른 안내자', avatar_path:'/characters/other/avatar.png',
    state_assets:{attention:'/characters/other/attention.webp', speaking:'/characters/other/speaking.gif'}},
]});

test('default Bulssi uses the supplied transparent artwork and never requires animation', () => {
  const result = createCharacterRegistry().present();
  assert.equal(result.id, 'bulssi');
  assert.equal(result.display_name, '불씨');
  assert.equal(result.asset_path, '/characters/bulssi/speaking.png');
  assert.equal(result.fallback, 'text');
  assert.equal(result.animation_optional, true);
});

test('all five supplied character states resolve to real PNG assets', () => {
  const registry=createCharacterRegistry();
  for(const [state,file] of Object.entries({idle:'greeting',listening:'listening',speaking:'speaking',empathy:'empathy',attention:'attention'})){
    const path=registry.present('bulssi',state).asset_path;
    assert.equal(path,`/characters/bulssi/${file}.png`);
    const bytes=readFileSync(new URL(`../public${path}`,import.meta.url));
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.ok(bytes.length<10*1024*1024);
  }
  assert.equal(createCharacterRegistry(config()).present().asset_path,null);
});

test('characters and semantic states can be replaced using configuration alone', () => {
  const registry = createCharacterRegistry(config());
  assert.equal(registry.present('other', 'attention').asset_path, '/characters/other/attention.webp');
  assert.equal(registry.present('other', 'listening').asset_path, '/characters/other/avatar.png');
  assert.equal(registry.present('removed').id, 'bulssi');
  assert.throws(() => registry.present('other', 'invented'));
});

test('caller mutations cannot alter registered character metadata', () => {
  const input = config(), registry = createCharacterRegistry(input);
  input.characters[0].display_name = 'changed';
  registry.list().characters[0].display_name = 'changed';
  registry.present('other').state_assets.attention = '/characters/changed.png';
  assert.equal(registry.present().display_name, '불씨');
  assert.equal(registry.present('other', 'attention').asset_path, '/characters/other/attention.webp');
});

test('character config cannot carry routing logic, model prompts or external URLs', () => {
  for (const key of ['risk_level','prompt','booking_url','introduction','script','rules']) {
    const input = config(); input.characters[0][key] = 'untrusted';
    assert.throws(() => createCharacterRegistry(input));
  }
  for (const path of ['https://example.org/a.png','//example.org/a.png','/characters/../a.png',
    '/characters/%2e%2e/a.png','/characters/a.svg','/characters/a.png?case=private','/characters/a.html']) {
    const input = config(); input.characters[0].avatar_path = path;
    assert.throws(() => createCharacterRegistry(input));
  }
});

test('invalid, duplicate and missing default characters fail startup validation', () => {
  for (const mutate of [c => c.characters.push(c.characters[0]), c => c.default_character_id = 'missing',
    c => c.characters[0].display_name = '<script>', c => c.characters[0].state_assets = {custom:'/characters/a.png'},
    c => c.characters[0].id = null, c => c.characters = []]) {
    const input = config(); mutate(input); assert.throws(() => createCharacterRegistry(input));
  }
});
