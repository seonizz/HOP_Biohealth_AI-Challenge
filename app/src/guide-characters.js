import { readFileSync } from 'node:fs';

// Presentation metadata only. Characters cannot supply clinical text, routing
// rules, model prompts, links, scripts, or executable animation components.
const STATES = ['idle', 'listening', 'speaking', 'empathy', 'attention'];
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const ASSET = /^\/characters\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|webp|jpg|jpeg|gif|avif)$/;
const fail = () => { throw new Error('Invalid guide character configuration'); };
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) fail();
};

export function createCharacterRegistry(config = JSON.parse(readFileSync(new URL('../seeds/guide-characters.json', import.meta.url), 'utf8'))) {
  keys(config, ['schema_version', 'default_character_id', 'characters']);
  if (config.schema_version !== '1.0' || !Array.isArray(config.characters) ||
      !config.characters.length || config.characters.length > 50) fail();
  const characters = new Map();
  for (const item of config.characters) {
    keys(item, ['id', 'display_name', 'avatar_path', 'state_assets']);
    if (typeof item.id !== 'string' || !ID.test(item.id) || characters.has(item.id) ||
        typeof item.display_name !== 'string' || !item.display_name.trim() || item.display_name.length > 40 ||
        /[<>\u0000-\u001f\u007f]/u.test(item.display_name) ||
        !(item.avatar_path === null || typeof item.avatar_path === 'string' && ASSET.test(item.avatar_path))) fail();
    keys(item.state_assets, STATES);
    for (const asset of Object.values(item.state_assets)) if (typeof asset !== 'string' || !ASSET.test(asset)) fail();
    characters.set(item.id, structuredClone(item));
  }
  if (!characters.has(config.default_character_id)) fail();
  const defaultId = config.default_character_id;
  return Object.freeze({
    list: () => ({schema_version:'1.0', default_character_id:defaultId, characters:structuredClone([...characters.values()])}),
    // A removed saved preference degrades to the default and never blocks help.
    present: (id = defaultId, state = 'speaking') => {
      if (!STATES.includes(state)) throw new TypeError('Unknown guide presentation state');
      const character = characters.get(id) || characters.get(defaultId);
      return {...structuredClone(character), state,
        asset_path:character.state_assets[state] || character.avatar_path,
        fallback:'text', animation_optional:true};
    },
  });
}
