import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {finalReviewBundle} from '../src/final-review-bundle.js';
import {validateSchema} from '../src/relationship-agent.js';

const schema={type:'object',properties:{approved:{type:'boolean'},issues:{type:'array',items:{type:'string'},maxItems:4}},required:['approved','issues'],additionalProperties:false};
schema.properties.audits={type:'array',minItems:1,maxItems:1,items:{type:'object',properties:{id:{type:'string',enum:['claim0']},verdict:{type:'string',enum:['supported','plausible','unsupported']},reason:{type:'string',minLength:1,maxLength:100}},required:['id','verdict','reason'],additionalProperties:false}};
schema.required.push('audits');
const bundle=()=>finalReviewBundle([{key:'state',stage:'state_review',prompt:'Review independently.',payload:{claims:[{id:'claim0'}]},schema,validate:value=>value}],validateSchema);
const gateway=options=>new ModelGateway({baseUrl:'http://127.0.0.1:1/v1',apiKey:'test-only',protocol:'relationship_agent',diagnosticLogger:null,...options});

test('turn-only compact output preserves final and standalone review contracts',async()=>{
  const g=gateway({compactTurnReviewOutput:true}),b=bundle();
  for(const stage of ['turn_review_bundle','turn_review_bundle_after_review','final_review_bundle_initial','card_review_bundle','state_review']){
    let input;
    g.request=async build=>{input=JSON.parse(build({repairs:0}).messages.at(-1).content);return null;};
    await g.operation({},operation=>g.agentComplete(stage,b.prompt,b.payload,b.schema,operation,value=>value));
    assert.equal(Object.hasOwn(input.output_schema.properties,'b'),stage.startsWith('turn_review_bundle'),stage);
  }
});

test('turn compact decision follows the delegated reviewer while explicit false overrides it',async()=>{
  const review=gateway(),g=gateway({compactTurnReviewOutput:true,reviewGateway:review}),b=bundle();
  for(const options of [{},{compactReviewOutput:false}]){
    let input;
    review.request=async build=>{input=JSON.parse(build({repairs:0}).messages.at(-1).content);return null;};
    await g.operation({},operation=>g.agentComplete('turn_review_bundle',b.prompt,b.payload,b.schema,operation,value=>value,options));
    assert.equal(Object.hasOwn(input.output_schema.properties,'b'),options.compactReviewOutput!==false);
  }
});
