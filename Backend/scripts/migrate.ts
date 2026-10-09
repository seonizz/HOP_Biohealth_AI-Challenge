import { Store } from '../src/storage.ts';
const url=process.env.HOP_MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if(!url) throw new Error('Migration database URL is required');
const store=await Store.connect(url,{schema:process.env.HOP_DATABASE_SCHEMA || 'public',migrate:true});
await store.close();
console.log('PostgreSQL migration verified.');
