import test from 'node:test';
import assert from 'node:assert/strict';
import { knownSpeechIssues } from '../src/relationship-agent.js';

const guide = overrides => ({script:'지금 잠깐 이야기해도 괜찮아?', doList:[], avoid:[], next:'', care:{feel:'', tips:[]}, ...overrides});
const restIssue = output => knownSpeechIssues(output).filter(issue => issue.reason.includes('대화 거절만으로'));

test('self-care wording about the speaker’s own rest is not another person’s inferred motive', () => {
  for (const owner of ['내', '나의', '제', '저의']) {
    const output = guide({next:`쉬고 싶다는 ${owner} 마음을 표현해 보고, 연락 답변은 잠시 미룰지 정하세요.`});
    assert.deepEqual(restIssue(output), []);
  }
});

test('a self-care span does not exempt another unsupported rest inference in the same card', () => {
  const output = guide({next:'쉬고 싶다는 내 마음을 이야기하세요. 상대도 쉬고 싶구나 하고 받아들이세요.'});
  assert.equal(restIssue(output).length, 1);
});

test('another person’s desire is still checked in every actionable card', () => {
  const claim = '대화를 거절한 것은 쉬고 싶다는 뜻으로 받아들이세요.';
  for (const output of [guide({script:claim}), guide({doList:[claim]}), guide({next:claim}),
    guide({care:{feel:'', tips:[claim]}})]) {
    assert.equal(restIssue(output).length, 1);
  }
});

test('a quoted first-person example does not hide an inference elsewhere', () => {
  const output = guide({next:'“쉬고 싶다는 제 생각을 전할게요”라고 말해 보세요. 대답이 없으면 쉬고 싶은 거구나 하고 여기세요.'});
  assert.equal(restIssue(output).length, 1);
});
