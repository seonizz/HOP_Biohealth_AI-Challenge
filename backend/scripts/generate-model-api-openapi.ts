import {writeFileSync} from 'node:fs';
import {MODEL_API_OPENAPI} from '../src/model-api/contract.ts';
writeFileSync(new URL('../openapi-model.json',import.meta.url),JSON.stringify(MODEL_API_OPENAPI,null,2)+'\n');
console.log('Model I/O OpenAPI generated.');
