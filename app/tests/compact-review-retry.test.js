import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {compactReviewTransport} from '../src/compact-review-transport.js';
import {auditSchema,validateAudits} from '../src/grounding-audit.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});

test('a compact state-review format retry keeps the compact schema and rejected wire contract',async()=>{
  const claims=['patient.0','supporter.0'].map(id=>({id,claim:'합성 원문을 보고했어요.',certainty:'reported'}));
  const stateSchema=object({audits:auditSchema(claims),issues:{type:'array',maxItems:3,items:object({
    reason:{type:'string',minLength:1,maxLength:500},repair:{type:'string',minLength:1,maxLength:600},
  })},approved:{type:'boolean'}});
  const schema=object({state:stateSchema,questions:{type:'null'},safety:{type:'null'}}),payload={review_target:{claims}};
  const logical={state:{audits:claims.map(claim=>({id:claim.id,verdict:'supported',reason:'현재 인용이 해당 보고를 뒷받침해요.'})),issues:[],approved:true},questions:null,safety:null};
  const codec=compactReviewTransport({stage:'turn_review',schema,payload});assert.ok(codec);
  const good=codec.encode(logical),bad=structuredClone(good);bad.o.state.a.a1.v=bad.o.state.a.a0.v;
  const bodies=[];
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'synthetic-key',model:'synthetic-only',
    protocol:'relationship_agent',agentFormat:'prompt',compactReviewOutput:true,timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    fetchImpl:async(_url,request)=>{
      bodies.push(JSON.parse(JSON.parse(request.body).messages.at(-1).content));
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bodies.length===1?bad:good)}}]}));
    }});
  const result=await gateway.operation({},operation=>gateway.agentComplete('turn_review','검토만 하세요.',payload,schema,operation,value=>{
    validateSchema(value,schema);validateAudits(value.state.audits,claims,value.state.approved);return value;
  }));
  assert.deepEqual(result,logical);assert.equal(bodies.length,2);
  assert.ok(bodies[1].output_schema.properties.b&&bodies[1].output_schema.properties.o);
  assert.deepEqual(bodies[1].rejected_output,bad);
  assert.equal(Object.hasOwn(bodies[1],'required_audit_ids'),false);
  assert.doesNotMatch(bodies[1].repair_task,/state,questions,safety/u);
});
