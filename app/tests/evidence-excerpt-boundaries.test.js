import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceQuotes} from '../src/model-schema.js';

const field=text=>({id:'mood',status:'answered',text,rawText:text,custom:''});

test('long comma-separated observations use existing clause boundaries instead of cutting a later statement',()=>{
  const clauses=Array.from({length:12},(_,index)=>`합성 관찰 ${index+1}번의 상황을 보고했어요`),source=clauses.join(', ');
  assert.ok(source.length>160);
  const quotes=evidenceQuotes(field(source));
  assert.ok(quotes.length>1);
  for(const quote of quotes){
    assert.ok(source.includes(quote));assert.ok(quote.length<=160);assert.ok(quote.isWellFormed());
    const clean=quote.replace(/,$/u,'');
    assert.ok(clauses.some(clause=>clean.endsWith(clause)));
    assert.ok(clauses.some(clause=>clean.startsWith(clause)));
  }
  assert.ok(quotes.at(-1).endsWith(clauses.at(-1)));
});

test('word boundaries retain exact long source text and never add or rewrite a claim',()=>{
  const words=Array.from({length:50},(_,index)=>'상황'+index),source=words.join(' '),quotes=evidenceQuotes(field(source));
  assert.ok(quotes.length>1);
  assert.equal(quotes.join(' '),source);
  for(const quote of quotes){
    assert.ok(source.includes(quote));assert.ok(quote.length<=160);
    assert.ok(words.includes(quote.split(' ')[0]));assert.ok(words.includes(quote.split(' ').at(-1)));
  }
});

test('unbroken passages and emoji still produce finite well-formed exact excerpts within the existing limit',()=>{
  for(const source of ['가'.repeat(501),'가'.repeat(159)+'🙂'+'나'.repeat(170)]){
    const quotes=evidenceQuotes(field(source));
    assert.ok(quotes.length>1);assert.ok(source.startsWith(quotes[0]));assert.ok(source.endsWith(quotes.at(-1)));
    assert.ok(quotes.every(quote=>quote.length<=160&&quote.isWellFormed()&&source.includes(quote)));
  }
});
