// Offline current-app adapter. stdin/stdout JSON only; no server or model calls.
import fs from 'node:fs';
import {projectMemoryCase} from './project_memory_review_cases.mjs';
import {requestCombinedStateReview} from '../../app/src/relationship-turn.js';
import {validateSchema} from '../../app/src/relationship-agent.js';

const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(input.mode==='project') {
  const rows=[];
  for(const item of input.cases)rows.push(await projectMemoryCase(item));
  process.stdout.write(JSON.stringify(rows));
} else if(input.mode==='validate') {
  const results=[];
  for(const item of input.items) {
    try {
      validateSchema(item.value,item.payload.output_schema,'output',true);
      if(item.task==='memory_review')await requestCombinedStateReview({async agentComplete(stage,prompt,data,schema,operation,validate){
        // Validate raw output with current callback; discard normalized return.
        validate(structuredClone(item.value));return item.value;
      }},item.payload.data,{});
      results.push({valid:true});
    } catch(error){results.push({valid:false,reason:error.modelReason??error.code??'schema'});}
  }
  process.stdout.write(JSON.stringify(results));
} else throw new Error('Unknown offline mode');
