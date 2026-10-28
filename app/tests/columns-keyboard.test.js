import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=name=>readFileSync(new URL(`../public/js/${name}`,import.meta.url),'utf8');
// A small DOM for real reader handlers; native keyboard traversal is also checked in the browser.
class Element{
  constructor(tag,document){this.tagName=tag;this.ownerDocument=document;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.inert=false;this.style={setProperty(){}};
    const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)};}
  appendChild(child){child.parentElement=this;this.children.push(child);return child;}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  get isConnected(){return this===this.ownerDocument.body||!!this.parentElement?.isConnected;}
  focus(){for(let node=this;node;node=node.parentElement)if(node.hidden||node.inert)return;this.ownerDocument.activeElement=this;}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);if(name==='hidden')this.hidden=true;if(name.startsWith('data-'))this.dataset[name.slice(5)]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  matches(selector){if(selector.startsWith('.'))return (this.getAttribute('class')||'').split(/\s+/).includes(selector.slice(1));if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('['))return this.getAttribute(selector.slice(1,-1))!==null;return this.tagName===selector;}
  querySelectorAll(selector){const selectors=selector.split(','),found=[];for(const child of this.children){if(selectors.some(part=>child.matches(part)))found.push(child);found.push(...child.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  set innerHTML(value){
    if(this.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body;
    this.children.forEach(child=>child.parentElement=null);this.children=[];const stack=[this];
    for(const token of String(value).match(/<[^>]+>|[^<]+/g)||[]){
      if(token.startsWith('</')){stack.pop();continue;}
      const match=token.match(/^<([\w-]+)([^>]*)>/);if(!match)continue;
      const child=new Element(match[1],this.ownerDocument);
      for(const attr of match[2].matchAll(/([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g))child.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??'');
      stack.at(-1).appendChild(child);if(!['img','br','hr','input'].includes(child.tagName))stack.push(child);
    }
  }
}
function harness(){
  const document={title:''};document.body=new Element('body',document);document.activeElement=document.body;
  document.getElementById=id=>document.body.querySelector('#'+id);
  document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
  const articles=[0,1].map(i=>({art:'synthetic-'+i,url:'https://example.invalid/article-'+i,title:'Synthetic '+i,artLabel:'Synthetic',cat:'마음',src:'Synthetic',lead:'Synthetic introduction',points:['Synthetic paragraph']}));
  let release;const reply=new Promise(resolve=>release=resolve),calls=[];
  const context=vm.createContext({document,window:{scrollTo(){}},NavBar:()=>'<nav><button id="columnHome">Home</button></nav>',M:{hear:'hear.png',listen:'listen.png',cheer:'cheer.png'},COLUMNS:articles,COLUMN_CATS:[['마음']],
    API:{data:{column_state:{read:[],saved:[]}},request:(...args)=>{calls.push(args);return reply;}},setTimeout:()=>0,clearTimeout(){},StartScreen:{updRecN(){}},ChatScreen:{title(){}}});
  vm.runInContext(source('core/utils.js')+source('components/ColumnsScreen.js')+'\nglobalThis.screen=ColumnsScreen;globalThis.showScreen=show;',context);
  document.body.innerHTML=context.screen.render()+['start','chat','result','records','about'].map(id=>`<section id="${id}" hidden></section>`).join('');
  document.getElementById('columns').hidden=false;context.screen.mount();
  const opener=document.getElementById('colGrid').querySelector('.cc-open');opener.focus();
  const key=(key,shiftKey=false)=>{const event={key,shiftKey,prevented:false,preventDefault(){this.prevented=true;}};document.getElementById('colReader').onkeydown(event);return event;};
  return {document,screen:context.screen,context,opener,key,calls,release};
}

test('reader traps both Tab boundaries and restores the original focus on Escape',()=>{
  const h=harness();h.screen.read(0);const r=h.document.getElementById('colReader'),stops=r.querySelectorAll('button,a');
  assert.equal(h.document.activeElement.id,'crClose');
  for(const sibling of h.document.getElementById('columns').children)if(sibling!==r&&sibling.id!=='colToast')assert.equal(sibling.inert,true);
  stops[0].focus();assert.equal(h.key('Tab',true).prevented,true);assert.equal(h.document.activeElement,stops.at(-1));
  assert.equal(h.key('Tab').prevented,true);assert.equal(h.document.activeElement,stops[0]);
  stops[1].focus();assert.equal(h.key('Tab').prevented,false);
  h.opener.focus();assert.equal(h.document.activeElement,stops[1],'inert background cannot take focus');
  h.key('Escape');assert.equal(r.hidden,true);assert.equal(h.document.activeElement,h.opener);
  assert.equal(h.document.body.classList.contains('noscroll'),false);
  for(const sibling of h.document.getElementById('columns').children)assert.equal(sibling.inert,false);
});

test('saving keeps focus inside the refreshed footer and returns to the replacement article button',async()=>{
  const h=harness();h.screen.read(0);h.document.getElementById('crSave').focus();
  const pending=h.document.activeElement.onclick();await Promise.resolve();assert.equal(h.calls.length,1);
  h.release({state:{read:[],saved:['synthetic-0']}});await pending;
  assert.equal(h.document.activeElement.id,'crSave');assert.equal(h.opener.isConnected,false);
  h.key('Escape');assert.equal(h.document.activeElement.dataset.i,'0');assert.equal(h.document.activeElement.isConnected,true);
});

test('marking read moves focus from the removed action to a remaining reader action',async()=>{
  const h=harness();h.screen.read(0);h.document.getElementById('crDone').focus();
  const pending=h.screen.markRead({art:'synthetic-0'});await Promise.resolve();
  h.release({state:{read:['synthetic-0'],saved:[]}});await pending;
  assert.equal(h.document.getElementById('crDone'),null);assert.equal(h.document.activeElement.id,'crSave');
  assert.equal(h.document.getElementById('colReader').contains(h.document.activeElement),true);
});

test('moving between articles and leaving the route restores prior inert states without leaking the lock',()=>{
  const h=harness(),nav=h.document.getElementById('columns').children[0];nav.inert=true;
  h.screen.read(0);h.document.getElementById('crNext').onclick();assert.equal(h.screen.cur,1);
  h.context.showScreen('about');assert.equal(h.screen.cur,null);assert.equal(h.document.getElementById('colReader').hidden,true);
  assert.equal(nav.inert,true);assert.equal(h.document.getElementById('colGrid').parentElement.inert,false);
  h.context.showScreen('columns');h.screen.read(1);h.key('Escape');
  assert.equal(h.document.activeElement,h.opener,'article changes preserve the original return target');
  assert.equal(nav.inert,true);assert.equal(h.document.getElementById('colGrid').parentElement.inert,false);
});

test('closing a filtered-out article restores focus to an available filter control',async()=>{
  const h=harness();h.screen.only='unread';h.screen.draw();h.document.getElementById('colGrid').querySelector('.cc-open').focus();h.screen.read(0);
  const pending=h.screen.markRead({art:'synthetic-0'});await Promise.resolve();h.release({state:{read:['synthetic-0'],saved:[]}});await pending;
  h.key('Escape');assert.equal(h.document.activeElement,h.document.getElementById('colFilter').querySelector('button'));
});
