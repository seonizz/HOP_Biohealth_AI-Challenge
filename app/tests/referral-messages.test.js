import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createReferralMessages} from '../src/referral-messages.js';
import {configuredReferralProvider} from '../src/referral-runtime.js';
const seed=()=>JSON.parse(readFileSync(new URL('../seeds/referral-messages.json',import.meta.url),'utf8'));
test('nonurgent guidance consistently offers gentle counseling while emergencies retain immediate action',()=>{
 const messages=createReferralMessages();
 const offer='혼자 감당하지 않아도 괜찮아요. 가까운 시일 안에 도움을 받을 수 있도록, 상담할 곳을 함께 살펴볼까요?';
 for(const urgency of ['soon','planned','undetermined'])assert.equal(messages.get(urgency).text,offer);
 assert.match(messages.get('immediate').text,/지금 안전을 확보하고 긴급 도움/);
});
test('developer text is preserved exactly and isolated from later mutation',()=>{
 const config=seed();config.messages.immediate.text='개발자가 등록한 안내입니다.\n지금 도움을 확인해 주세요.';
 const registry=createReferralMessages(config),expected=config.messages.immediate.text;
 config.messages.immediate.text='변경';const value=registry.get('immediate');value.text='변조';
 assert.equal(registry.get('immediate').text,expected);
 assert.equal(registry.get('immediate').id,'immediate_help');
});
test('missing, empty, duplicate, executable configuration fields fail closed',()=>{
 for(const mutate of [c=>delete c.messages.soon,c=>c.messages.soon.text='',c=>c.messages.soon.id=c.messages.immediate.id,c=>c.messages.soon.prompt='generate',c=>c.messages.extra={},c=>c.messages.soon.text='\u0000']){
 const c=seed();mutate(c);assert.throws(()=>createReferralMessages(c),TypeError);}
 assert.throws(()=>createReferralMessages().get('low'),TypeError);
});
test('referral uses an available model by default, respects opt-out, and does not infer eligibility',()=>{
 assert.equal(configuredReferralProvider({env:{}}),null);
 assert.equal(configuredReferralProvider({env:{REFERRAL_GUIDANCE_ENABLED:'true'}}),null);
 const gateway={operation(){},agentComplete(){}};
 assert.equal(typeof configuredReferralProvider({gateway,env:{}}),'function');
 assert.equal(configuredReferralProvider({gateway,env:{REFERRAL_GUIDANCE_ENABLED:'false'}}),null);
 const env={REFERRAL_GUIDANCE_ENABLED:'true',REFERRAL_MODEL_BASE_URL:'http://127.0.0.1:11434/v1',REFERRAL_MODEL_NAME:'gemma4:12b'};
 assert.equal(typeof configuredReferralProvider({env}),'function');
 for(const extra of [{REFERRAL_MODEL_BASE_URL:'http://remote.invalid/v1'},{REFERRAL_COUNTRY:'한국'},{REFERRAL_MODEL_NAME:''},{REFERRAL_MODEL_BASE_URL:'http://user:secret@localhost/v1'}])assert.throws(()=>configuredReferralProvider({env:{...env,...extra}}));
});
