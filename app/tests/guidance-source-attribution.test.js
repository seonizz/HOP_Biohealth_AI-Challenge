import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceAttributionIssues} from '../src/guidance-source-attribution.js';
import {sourceDocuments} from '../src/relationship-retrieval.js';

// Synthetic people and answers only. This guard intentionally recognizes
// bounded attribution forms; independent model reviews remain responsible for
// other wording and the semantic quality of an otherwise valid suggestion.
const question='현재 지민에게 가장 필요하다고 생각하는 도움은 무엇인가요?';
const needs='학교 상담센터 상담, 그리고 혼자 있는 시간을 줄이는 것';
const field=(id,text,q='어떤 말을 들었나요?')=>({id,question:q,status:'answered',rawText:text,text,custom:''});
const context=()=>({patient:{alias:'지민',fields:{need:field('need',needs,question)}},supporter:{fields:{}},user_goal:{}});
const counsel='지민이가 학교 상담센터를 필요로 한다고 했으니, 위치를 알아보세요.';
const alone='함께하기: 혼자 있는 시간을 줄이고 싶어 하는 지민이에게 동행을 제안해 보세요.';
const guide=(doList=[counsel,alone])=>({script:'',doList,avoid:[],next:'',care:{feel:'',tips:[]}});
const counselReport='지민이가 “학교 상담센터 상담을 받고 싶어요”라고 말했어요.';
const aloneReport='지민이가 “혼자 있는 시간을 줄이고 싶어”라고 말했어요.';
const directQuestion='지민이가 직접 원한다고 말한 도움은 무엇인가요?';

test('the informant help estimate cannot become two reports of the patient wishes',()=>{
  const issues=sourceAttributionIssues(guide(),context());
  assert.equal(issues.length,1);assert.equal(issues[0].field,'doList');
  assert.match(issues[0].reason,/이용자가 필요하다고 생각한 도움/u);
  assert.match(issues[0].repair,/필요로 한다고 했/u);assert.match(issues[0].repair,/줄이고 싶어 하는/u);
});

test('source meaning follows the saved question instead of a need identifier',()=>{
  const custom=context();custom.patient.fields.arbitrary=field('arbitrary',needs,question);delete custom.patient.fields.need;
  assert.equal(sourceAttributionIssues(guide(),custom).length,1);
  const changed=context();changed.patient.fields.need.question=directQuestion;
  assert.deepEqual(sourceAttributionIssues(guide(),changed),[]);
  const unrelated=context();unrelated.patient.fields.need.question='어제 방문한 곳은 어디인가요?';
  assert.deepEqual(sourceAttributionIssues(guide(),unrelated),[],'an unrecognized question has no inferred estimate role');
});

for(const suggestion of [
  '이용자는 학교 상담센터 상담이 필요하다고 생각하셨군요. 이용 방법을 알아보세요.',
  '학교 상담센터 상담을 원하는지 물어보고 혼자 있는 시간을 줄이는 방법도 함께 살펴보세요.',
  '지민이가 학교 상담센터를 원한다고 했다면, 어떤 도움이 좋을지 물어보세요.',
  '지민이가 학교 상담센터를 원한다고 했는지 물어보세요.',
  '지민이가 학교 상담센터를 원한다고 말한 적은 없으니, 지금 원하는지 물어보세요.',
  '지민이가 학교 상담센터를 원한다고 했다고 단정하지 마세요.',
  '혼자 있는 시간을 줄이고 싶어 하는 지민이라면 어떤 도움이 좋을지 물어보세요.',
])test('a user opinion, open question or conditional proposal stays intact: '+suggestion,()=>{
  assert.deepEqual(sourceAttributionIssues(guide([suggestion]),context()),[]);
});

for(const location of ['original','custom','other patient','supporter','follow_up'])
test('an explicit patient request for the same help permits that attribution: '+location,()=>{
  const ctx=context();
  if(location==='original')Object.assign(ctx.patient.fields.need,{rawText:needs+'. '+counselReport,text:needs+'. '+counselReport});
  if(location==='custom')ctx.patient.fields.need.custom=counselReport;
  if(location==='other patient')ctx.patient.fields.story=field('story',counselReport);
  if(location==='supporter')ctx.supporter.fields.story=field('story',counselReport);
  if(location==='follow_up')ctx.patient.fields.need.followUp={question:'대상자가 직접 한 말도 있나요?',answer:{rawText:counselReport,text:counselReport}};
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);
  const issues=sourceAttributionIssues(guide([alone]),ctx);
  assert.equal(issues.length,1,'one actual request cannot excuse a different desired help');
});

test('selected unknown with meaningful custom report uses the existing normalized answer contract',()=>{
  const ctx=context();ctx.patient.fields.need.status='unknown';ctx.patient.fields.need.selected=[{label:'잘 모르겠어요'}];
  ctx.patient.fields.need.custom=counselReport;
  const before=structuredClone(ctx);
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);assert.deepEqual(ctx,before);
});

test('an actual request for less solitude permits the wish without excusing an unrelated recommendation',()=>{
  const ctx=context();ctx.patient.fields.story=field('story',aloneReport);
  assert.deepEqual(sourceAttributionIssues(guide([alone]),ctx),[]);
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('a quoted patient request with its speaker after the quote is still attributed correctly',()=>{
  const ctx=context();ctx.patient.fields.story=field('story','“학교 상담센터 상담을 받고 싶어요”라고 지민이가 말했어요.');
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);
});

test('the actual follow-up question can establish the speaker of a short answer',()=>{
  const ctx=context();ctx.patient.fields.need.followUp={question:directQuestion,answer:{rawText:'학교 상담센터 상담',text:'학교 상담센터 상담'}};
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);
  assert.equal(sourceAttributionIssues(guide([alone]),ctx).length,1);
});

for(const report of [
  '민수가 “학교 상담센터 상담을 받고 싶어요”라고 말했어요.',
  '지민이에게 제가 학교 상담센터 상담을 원한다고 말했어요.',
  '지민이가 “민수가 학교 상담센터 상담을 원한다고 했어”라고 말했어요.',
  '지민이가 음악을 듣고 싶다고 말했어요.',
  '지민이가 상담을 받고 싶다고 말했어요.',
  '지민이가 학교 상담센터를 원한다고 말한 적은 없어요.',
  '지민이가 학교 상담센터 상담을 원하지 않는다고 말했어요.',
  '지민이가 학교 상담센터 상담을 원하지는 않는다고 말했어요.',
  '만약 지민이가 학교 상담센터 상담을 원한다고 했다고 가정해 보세요.',
  '예전 지민이가 학교 상담센터 상담을 원한다고 말했어요.',
])test('another speaker, different help, denied or hypothetical request cannot waive the guard: '+report,()=>{
  const ctx=context();ctx.patient.fields.story=field('story',report);
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('a request for more time alone does not prove a wish to reduce it',()=>{
  const ctx=context();ctx.patient.fields.story=field('story','혼자 있는 시간을 늘리는 것',directQuestion);
  assert.equal(sourceAttributionIssues(guide([alone]),ctx).length,1);
});

for(const correction of [
  '그건 제 생각일 뿐이에요.',
  '지민이가 지금은 학교 상담센터 상담을 원하지 않는다고 말했어요.',
  '학교 상담센터 상담 요청은 취소했어요.',
])test('a later same-field correction defeats an old request: '+correction,()=>{
  const ctx=context();ctx.patient.fields.need.custom=counselReport;
  ctx.patient.fields.need.followUp={question:'그 도움에 대해 현재 알려진 내용은 무엇인가요?',answer:{rawText:correction,text:correction}};
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('a short negative reply to the direct-request follow-up is not overridden by old text',()=>{
  const ctx=context();ctx.patient.fields.need.custom=counselReport;
  ctx.patient.fields.need.followUp={question:directQuestion,answer:{rawText:'아니요.',text:'아니요.'}};
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('a new affirmative follow-up can supersede the earlier denial for that same help',()=>{
  const ctx=context();ctx.patient.fields.need.custom='지민이가 학교 상담센터 상담을 원한다고 말한 적은 없어요.';
  ctx.patient.fields.need.followUp={question:directQuestion,answer:{rawText:'학교 상담센터 상담',text:'학교 상담센터 상담'}};
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);
});

test('a refusal concerning another help does not erase a real matching request',()=>{
  const ctx=context();ctx.patient.fields.story=field('story',counselReport+' 하지만 음악을 듣고 싶지는 않다고 말했어요.');
  assert.deepEqual(sourceAttributionIssues(guide([counsel]),ctx),[]);
});

test('a request question does not turn an explicitly contrary informant opinion into a patient request',()=>{
  const ctx=context();ctx.patient.fields.story=field('story','제가 학교 상담센터 상담이 필요하다고 생각해요.',directQuestion);
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('line boundaries cannot combine one person mention with another speaker request',()=>{
  const ctx=context();ctx.patient.fields.story=field('story','지민이가 학교 상담센터 위치를 찾아봤어요\n민수는 학교 상담센터 상담을 원한다고 말했어요');
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('a selected label without saved answered text cannot become a request source',()=>{
  const ctx=context();ctx.patient.fields.story={id:'story',question:directQuestion,status:'answered',rawText:'',text:'',custom:'',selected:[{label:'학교 상담센터 상담'}]};
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

for(const status of ['unknown','refused','skipped','not_asked'])test('unconfirmed reports do not become request evidence: '+status,()=>{
  const ctx=context();ctx.patient.fields.story={...field('story',counselReport),status};
  assert.equal(sourceAttributionIssues(guide([counsel]),ctx).length,1);
});

test('discouraged example text is separate from a genuinely recommended false premise',()=>{
  const ctx=context(),safe=guide([]);
  safe.avoid=['피할 말: '+counsel+' 이유: 요청을 단정하지 마세요. 대신 원하는 도움이 무엇인지 물어보세요.'];
  assert.deepEqual(sourceAttributionIssues(safe,ctx),[]);
  safe.doList=['“'+counsel+'”라는 말은 하지 마세요.'];
  assert.deepEqual(sourceAttributionIssues(safe,ctx),[]);
  safe.avoid=['피할 말: 재촉하기. 이유: 선택을 존중해야 합니다. 대신 '+counsel];
  assert.deepEqual(sourceAttributionIssues(safe,ctx).map(issue=>issue.field),['avoid']);
});

for(const target of ['script','next','care'])test('the same attribution boundary follows the factual premise in '+target,()=>{
  const value=guide([]);if(target==='care')value.care.feel=counsel;else value[target]=counsel;
  assert.deepEqual(sourceAttributionIssues(value,context()).map(issue=>issue.field),[target]);
});

test('source component identities, question roles and all input/output content remain immutable',()=>{
  const ctx=context();ctx.patient.fields.need.followUp={question:directQuestion,answer:{rawText:counselReport,text:counselReport}};
  const value=guide(),before=structuredClone({ctx,value}),documents=sourceDocuments(ctx);
  assert.ok(documents.some(row=>row.origin==='follow_up'&&row.question===directQuestion));
  assert.equal(new Set(documents.map(row=>row.source_id)).size,documents.length);
  sourceAttributionIssues(value,ctx);
  assert.deepEqual({ctx,value},before);assert.deepEqual(sourceDocuments(ctx),documents);
});

const artContext=()=>({patient:{alias:'다온',fields:{need:field('need','미술 수업','현재 다온에게 가장 필요하다고 생각하는 도움은 무엇인가요?')}},supporter:{fields:{}},user_goal:{}});
const artGuide=()=>guide(['다온이가 미술 수업을 원한다고 했으니, 시간을 물어보세요.']);
const artRequest='다온이가 미술 수업을 원한다고 말했어요.';

test('a same-report anaphoric withdrawal cancels the identified patient request',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story',artRequest+' 하지만 그 요청은 철회했어요.');
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

test('a request-maintenance follow-up can withdraw it without repeating the help noun',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story',artRequest);
  ctx.patient.fields.story.followUp={question:'그 요청은 지금도 유지되나요?',answer:{rawText:'지금은 원하지 않아요.',text:'지금은 원하지 않아요.'}};
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

test('a direct-request question cannot override an explicitly different speaker in its answer',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story','민수가 미술 수업을 원해요.','다온이가 직접 원한다고 말한 도움은 무엇인가요?');
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

test('a patient can report someone else request without becoming its speaker',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story','다온이가 미술 수업은 민수가 원한다고 말했어요.');
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

for(const where of ['same answer','another answer','follow_up'])
test('another person explicit refusal cannot revoke the patient request: '+where,()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story',artRequest);
  const refusal='나는 미술 수업을 원하지 않아요.';
  if(where==='same answer')Object.assign(ctx.patient.fields.story,{rawText:artRequest+' 하지만 '+refusal,text:artRequest+' 하지만 '+refusal});
  if(where==='another answer')ctx.supporter.fields.note=field('note',refusal,'당신은 어떤 도움을 원하나요?');
  if(where==='follow_up')ctx.patient.fields.story.followUp={question:'당신도 같은 도움을 원하나요?',answer:{rawText:refusal,text:refusal}};
  assert.deepEqual(sourceAttributionIssues(artGuide(),ctx),[]);
});

test('an anaphoric withdrawal after a different request does not cancel the earlier patient request',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story',artRequest+' 민수는 음악 레슨을 요청했어요. 그 요청은 철회했어요.');
  assert.deepEqual(sourceAttributionIssues(artGuide(),ctx),[]);
});

test('a spaced alias matches the current estimate question and the raw guide assertion',()=>{
  const ctx=artContext();ctx.patient.alias='합성 친구';ctx.patient.fields.need.question='현재 합성 친구에게 가장 필요하다고 생각하는 도움은 무엇인가요?';
  const value=guide(['합성 친구가 미술 수업을 원한다고 했으니, 일정을 알아보세요.']);
  assert.equal(sourceAttributionIssues(value,ctx).length,1);
});

test('a spaced alias report can support the request when the estimate question uses a generic target',()=>{
  const ctx=artContext();ctx.patient.alias='합성 친구';ctx.patient.fields.need.question='현재 대상자에게 가장 필요하다고 생각하는 도움은 무엇인가요?';
  ctx.patient.fields.story=field('story','합성 친구가 미술 수업을 원한다고 말했어요.');
  const value=guide(['합성 친구가 미술 수업을 원한다고 했으니, 일정을 알아보세요.']);
  assert.deepEqual(sourceAttributionIssues(value,ctx),[]);
});

test('alias normalization is consistent across NFKC source, question and output representations without mutations',()=>{
  const ctx=artContext();ctx.patient.alias='Ａｎｎ 친구';ctx.patient.fields.need.question='현재 Ann 친구에게 가장 필요하다고 생각하는 도움은 무엇인가요?';
  const value=guide(['Ａｎｎ 친구가 미술 수업을 원한다고 했으니, 일정을 알아보세요.']);
  const before=structuredClone({ctx,value});assert.equal(sourceAttributionIssues(value,ctx).length,1);
  assert.deepEqual({ctx,value},before);
  ctx.patient.fields.story=field('story','Ann 친구가 미술 수업을 원한다고 말했어요.');
  assert.deepEqual(sourceAttributionIssues(value,ctx),[]);
});

test('the subject particle 이 still identifies another speaker in a direct-request answer',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story','민석이 미술 수업을 원해요.','다온이가 직접 원한다고 말한 도움은 무엇인가요?');
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

test('the subject particle 이 cannot hide another person inside the patient reported speech',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story','다온이가 미술 수업은 민석이 원한다고 말했어요.');
  assert.equal(sourceAttributionIssues(artGuide(),ctx).length,1);
});

test('another subject marked 이 does not revoke the existing patient request',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story',artRequest+' 민석이 미술 수업을 원하지 않는다고 말했어요.');
  assert.deepEqual(sourceAttributionIssues(artGuide(),ctx),[]);
});

test('ordinary adverbs ending 이 are not treated as another speaker',()=>{
  const ctx=artContext();ctx.patient.fields.story=field('story','다온이가 미술 수업을 많이 원한다고 말했어요.');
  assert.deepEqual(sourceAttributionIssues(artGuide(),ctx),[]);
});
