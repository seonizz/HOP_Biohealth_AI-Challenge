import test from 'node:test';
import assert from 'node:assert/strict';
import {inferenceSchema,ModelGateway} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const prefix='가능한 해석: ';
const tentative=(maxLength=40,certainty={enum:['tentative']})=>object({
  interpretation:{type:'string',minLength:1,...(maxLength===null?{}:{maxLength})},
  certainty:{type:'string',...certainty},
});
const response=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),{status:200});

test('legacy inference schema still removes string maxima without changing the original schema or source enums',()=>{
  const schema=object({name:{type:'string',minLength:1,maxLength:20},rows:{type:'array',maxItems:2,items:{anyOf:[tentative(),object({quote:{type:'string',maxLength:1000,enum:['정확한 원문 그대로']}})]}}});
  const original=structuredClone(schema),actual=inferenceSchema(schema);
  assert.equal(actual.properties.name.maxLength,undefined);assert.equal(actual.properties.name.minLength,1);assert.equal(actual.properties.rows.maxItems,2);
  const [finding,citation]=actual.properties.rows.items.anyOf;
  assert.equal(finding.properties.interpretation.maxLength,undefined);assert.equal(finding.properties.interpretation.pattern,'^가능한 해석: .+$');
  assert.deepEqual(citation.properties.quote.enum,['정확한 원문 그대로']);assert.deepEqual(schema,original);
});

test('opt-in inference schema preserves bounded strings, nested arrays, source enums, and original limits',()=>{
  const schema=object({summary:{type:'string',minLength:1,maxLength:120},rows:{type:'array',maxItems:3,items:object({
    quote:{type:'string',minLength:1,maxLength:1000,enum:['앞뒤를 줄이지 않은 원문']},
  })}}),original=structuredClone(schema);
  assert.deepEqual(inferenceSchema(schema,{preserveStringLimits:true}),schema);assert.deepEqual(schema,original);
});

for(const certainty of [{enum:['tentative']},{const:'tentative'}]){
  test(`opt-in ${Object.keys(certainty)[0]} tentative pattern bounds the suffix after its Unicode prefix`,()=>{
    const schema=tentative(20,certainty),actual=inferenceSchema(schema,{preserveStringLimits:true});
    const interpretation=actual.properties.interpretation,remaining=20-Array.from(prefix).length;
    assert.equal(interpretation.maxLength,20);assert.equal(interpretation.pattern,`^${prefix}.{1,${remaining}}$`);
    const pattern=new RegExp(interpretation.pattern,'u');
    assert.equal(pattern.test(prefix+'가'.repeat(remaining)),true);assert.equal(pattern.test(prefix+'가'.repeat(remaining+1)),false);
    assert.equal(pattern.test(prefix),false);assert.equal(pattern.test('해석을 확정한 문장'),false);
    assert.equal(schema.properties.interpretation.pattern,undefined);
  });
}

test('opt-in does not add a maximum to an originally unbounded tentative interpretation',()=>{
  const actual=inferenceSchema(tentative(null),{preserveStringLimits:true}).properties.interpretation;
  assert.equal(actual.maxLength,undefined);assert.equal(actual.pattern,'^가능한 해석: .+$');
});

test('a tentative maximum too short for its required prefix stays unsatisfiable instead of generating an invalid quantifier',()=>{
  const schema=tentative(Array.from(prefix).length),actual=inferenceSchema(schema,{preserveStringLimits:true});
  assert.equal(actual.properties.interpretation,false);assert.equal(schema.properties.interpretation.maxLength,Array.from(prefix).length);
  const shortest=inferenceSchema(tentative(Array.from(prefix).length+1),{preserveStringLimits:true});
  assert.equal(shortest.properties.interpretation.pattern,`^${prefix}.{1,1}$`);
});

test('reported or mixed-certainty interpretations keep their original patterns and limits',()=>{
  for(const certainty of [{enum:['reported']},{enum:['reported','tentative']}]){
    const schema=tentative(100,certainty);schema.properties.interpretation.pattern='^원문 보고: .+$';
    assert.deepEqual(inferenceSchema(schema,{preserveStringLimits:true}),schema);
  }
});

for(const preserveStringLimits of [false,true]){
  test(`agentComplete sends preserveStringLimits=${preserveStringLimits} only to its runner schema and keeps the original validator`,async()=>{
    const requests=[],schema=tentative(40),original=structuredClone(schema),output={interpretation:prefix+'부담이 있을 수 있어요.',certainty:'tentative'};
    const gateway=new ModelGateway({baseUrl:'http://example.test/v1',apiKey:'test-only',preserveStringLimits,
      diagnosticLogger:()=>{},fetchImpl:async (_url,request)=>{requests.push(JSON.parse(request.body));return response(output);}});
    assert.equal(gateway.configured,true);
    const result=await gateway.operation({},operation=>gateway.agentComplete('synthetic_analysis','원문을 확인하세요.',{source:'원문 유지'},schema,operation,
      value=>validateSchema(value,schema)));
    assert.deepEqual(result,output);assert.equal(requests.length,1);
    const body=requests[0],runner=body.response_format.json_schema.schema.properties.interpretation;
    assert.equal(runner.maxLength,preserveStringLimits?40:undefined);
    assert.equal(runner.pattern,preserveStringLimits?`^${prefix}.{1,${40-Array.from(prefix).length}}$`:'^가능한 해석: .+$');
    assert.deepEqual(JSON.parse(body.messages[1].content).output_schema,original);
    assert.equal(body.reasoning_effort,'none');assert.equal(Object.hasOwn(body,'max_tokens'),false);assert.deepEqual(schema,original);
  });
}

test('the option defaults to legacy compatibility and requires a boolean when provided',()=>{
  const settings={baseUrl:'http://example.test/v1',apiKey:'test-only'};
  assert.equal(new ModelGateway(settings).preserveStringLimits,false);
  for(const value of ['true',1,null])assert.equal(new ModelGateway({...settings,preserveStringLimits:value}).configured,false);
});

test('an opt-in runner response still has to pass unchanged original length validation on every repair attempt',async()=>{
  const schema=object({text:{type:'string',minLength:1,maxLength:3}}),requests=[];
  const gateway=new ModelGateway({baseUrl:'http://example.test/v1',apiKey:'test-only',preserveStringLimits:true,diagnosticLogger:()=>{},
    fetchImpl:async (_url,request)=>{requests.push(JSON.parse(request.body));return response({text:'너무 긴 응답'});}});
  await assert.rejects(gateway.operation({},operation=>gateway.agentComplete('synthetic','합성 검증',{},schema,operation,value=>validateSchema(value,schema))),
    {code:'MODEL_INVALID_RESPONSE'});
  assert.equal(requests.length,3);
  for(const request of requests){assert.equal(request.response_format.json_schema.schema.properties.text.maxLength,3);assert.equal(Object.hasOwn(request,'max_tokens'),false);}
});
