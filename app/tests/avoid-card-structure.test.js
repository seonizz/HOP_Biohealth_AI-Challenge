import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {avoidCardDraftSchema,canonicalAvoidCard,knownSpeechIssues} from '../src/relationship-agent.js';
import {avoidCardStructureIssue,parseAvoidCardItem} from '../src/avoid-card-structure.js';

const schema={type:'object',properties:{avoid:{type:'array',minItems:1,maxItems:4,
  items:{type:'string',minLength:1,maxLength:2000}}},required:['avoid'],additionalProperties:false};
const parts={avoid_phrase:'바로 답하라고 재촉하기.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편할 때 답해 달라고 말하세요.'};
const canonical='피할 말·행동: 바로 답하라고 재촉하기. 이유: 대답할 여유를 남겨야 합니다. 대신 편할 때 답해 달라고 말하세요.';
const guide=avoid=>({script:'',doList:[],avoid,next:'',care:{feel:'',tips:[]}});
const envelope=payload=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));

test('equivalent stored headings retain atomic roles and still reject nested bundles',()=>{
  for(const heading of ['피할 말·행동:','피할 말:','피할 행동:']) {
    const text=canonical.replace('피할 말·행동:',heading);
    assert.deepEqual(parseAvoidCardItem(text),parts);
    assert.equal(avoidCardStructureIssue([text],{requireBundle:true}),null);
    const nested=canonical.replace(parts.alternative,text);
    assert.equal(parseAvoidCardItem(nested),null);
    assert.equal(avoidCardStructureIssue([nested],{requireBundle:true}).field,'avoid');
    assert.throws(()=>canonicalAvoidCard({avoid:[{...parts,alternative:text}]},schema),{modelReason:'agent_avoid_structure'});
  }
});

test('an already serialized avoid bundle cannot be embedded in any wire role or silently deduplicated',()=>{
  for(const field of Object.keys(parts)) {
    const value={avoid:[{...parts,[field]:canonical}]},before=structuredClone(value);
    assert.throws(()=>canonicalAvoidCard(value,schema),error=>{
      assert.equal(error.modelReason,'agent_avoid_structure');
      const feedback=JSON.parse(error.modelFeedback);
      assert.equal(feedback.path,`output.avoid[0].${field}`);
      assert.match(feedback.repair,/원문의 의미와 근거는 보존/u);
      return true;
    });
    assert.deepEqual(value,before);
  }
});

test('role labels, repeated role text and duplicate items trigger rewriting at the wire boundary',()=>{
  for(const value of [
    {avoid:[{...parts,reason:'이유: '+parts.reason}]},
    {avoid:[{...parts,alternative:'대신: '+parts.alternative}]},
    {avoid:[{...parts,avoid_phrase:parts.avoid_phrase+' 이유: '+parts.reason}]},
    {avoid:[{...parts,alternative:parts.reason}]},
    {avoid:[parts,{...parts}]},
  ])assert.throws(()=>canonicalAvoidCard(value,schema),{modelReason:'agent_avoid_structure'});
});

test('clean components and natural uses of reason or instead preserve exact text and existing storage format',()=>{
  assert.deepEqual(canonicalAvoidCard({avoid:[parts]},schema),{avoid:[canonical]});
  const natural={avoid_phrase:'“이유: 뭐야?”라고 다그치기.',reason:'상대의 이유가 아직 확인되지 않았습니다.',
    alternative:'재촉하는 대신 편한 때 이야기해 달라고 말하세요.'};
  const value={avoid:[natural]},before=structuredClone(value),result=canonicalAvoidCard(value,schema);
  assert.deepEqual(value,before);
  for(const text of Object.values(natural))assert.ok(result.avoid[0].includes(text));
  assert.equal(avoidCardStructureIssue(result.avoid),null);
  assert.deepEqual(knownSpeechIssues(guide(['재촉하지 마세요.'])),[]);
  assert.equal(avoidCardStructureIssue(['재촉하지 마세요.'],{requireBundle:true}).field,'avoid');
});

test('a nested bundle introduced by flat quality or final rewrites remains a local review defect',()=>{
  const nested=`피할 말·행동: ${canonical} 이유: ${parts.reason} 대신 ${parts.alternative}`;
  for(const text of [nested,'첫째, '+nested,`피할 말·행동: ${parts.avoid_phrase} 이유: ${parts.reason} 대신 ${canonical}`]) {
    const before=guide([text]);
    const issues=knownSpeechIssues(before);
    assert.equal(issues.length,1);assert.equal(issues[0].field,'avoid');
    assert.match(issues[0].repair,/중복 설명을 다시 작성/u);
    assert.equal(before.avoid[0],text);
  }
  assert.equal(knownSpeechIssues(guide([canonical])).length,0);
});

test('production gateway retries the exact malformed candidate with source-preserving repair feedback',async()=>{
  const malformed={avoid:[{...parts,avoid_phrase:canonical}]},fixed={avoid:[parts]};
  const data={answers:{source:'SYNTHETIC_CURRENT_REPORT'},current:{avoid:[canonical]}},requests=[];
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic',protocol:'relationship_agent',diagnosticLogger:null,
    fetchImpl:async(_url,request)=>{
      const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);requests.push(input);
      if(requests.length===2) {
        assert.deepEqual(input.rejected_output,malformed);assert.deepEqual(input.data,data);
        assert.match(input.validation_feedback,/avoid_phrase/u);assert.match(input.validation_feedback,/표시 라벨/u);
      }
      return envelope(requests.length===1?malformed:fixed);
    }});
  const result=await gateway.operation({},operation=>gateway.agentComplete('card_avoid','역할별 원문 근거를 보존하세요.',data,
    avoidCardDraftSchema(schema),operation,value=>canonicalAvoidCard(value,schema)));
  assert.equal(requests.length,2);assert.deepEqual(result,{avoid:[canonical]});
});

test('exhausted structural rewrites stop after three attempts even when operation recovery is enabled',async()=>{
  const controller=new AbortController();let attempts=0;
  const gateway=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic',protocol:'relationship_agent',diagnosticLogger:null,
    retryFailures:true,retryDelayMs:1,fetchImpl:async()=>{
      if(++attempts>3)controller.abort();
      return envelope({avoid:[{...parts,avoid_phrase:canonical}]});
    }});
  await assert.rejects(gateway.operation({signal:controller.signal},operation=>gateway.agentComplete('card_avoid','역할별 내용을 작성하세요.',{},
    avoidCardDraftSchema(schema),operation,value=>canonicalAvoidCard(value,schema))),{modelReason:'agent_avoid_structure'});
  assert.equal(attempts,3);
});
