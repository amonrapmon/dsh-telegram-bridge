import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingDelivery } from '../lib/streaming.js';

function setup(route) {
  const calls=[];
  let nextId=100;
  const api={
    async sendDraft(r,id,text) { calls.push(['draft',id,text,r.threadId]); },
    async sendPreview(r,text) { calls.push(['preview',text,r.threadId]); return {message_id:nextId++}; },
    async editPreview(r,id,text) { calls.push(['edit',id,text,r.threadId]); },
    async deletePreview(r,id) { calls.push(['delete',id]); },
    async send(r,text) { calls.push(['send',text,r.threadId]); },
  };
  const streaming=new StreamingDelivery(api,{initialDelayMs:1,intervalMs:1});
  const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
  return {streaming,calls,tick,route};
}
const frame=(type, extra={})=>({type,attemptId:'attempt-1',...extra});
test('private stream uses draft updates and commits exactly one final message', async()=>{
  const {streaming,calls,tick,route}=setup({chatId:4,chatType:'private',threadId:0,key:'4:0'});
  streaming.begin('s1',route);
  streaming.frame('s1',route,frame('start'));
  streaming.frame('s1',route,frame('chunk',{chunk:{type:'text-delta',text:'Привет'}}));
  await tick();
  streaming.committed('s1',route,'Привет!');
  const state=streaming.detach('s1');
  assert.equal(await streaming.finish(state,route,'Привет!'),true);
  assert.ok(calls.some(c=>c[0]==='draft'));
  assert.deepEqual(calls.filter(c=>c[0]==='send').map(c=>c[1]),['Привет!']);
  assert.equal(calls.filter(c=>c[0]==='preview').length,0);
});
test('supergroup streams by editing one bubble, without duplicate final send',async()=>{
  const {streaming,calls,tick,route}=setup({chatId:-1004,chatType:'supergroup',threadId:17,key:'-1004:17'});
  streaming.begin('s2',route);
  streaming.frame('s2',route,frame('start'));
  streaming.frame('s2',route,frame('chunk',{chunk:{type:'text-delta',text:'Проверка'}}));
  await tick();
  const state=streaming.detach('s2');
  assert.equal(await streaming.finish(state,route,'Проверка окончена'),true);
  assert.equal(calls.filter(c=>c[0]==='preview').length,1);
  assert.ok(calls.some(c=>c[0]==='edit'&&c[2]==='Проверка окончена'&&c[3]===17));
  assert.equal(calls.filter(c=>c[0]==='send').length,0);
});
test('failed streaming draft falls back to full committed answer',async()=>{
  const route={chatId:6,chatType:'private',threadId:0,key:'6:0'};
  const calls=[];
  const api={async sendDraft(){throw Error('unsupported')},async send(r,text){calls.push(text)}};
  const streaming=new StreamingDelivery(api,{initialDelayMs:1,intervalMs:1});
  streaming.begin('s3',route);
  streaming.frame('s3',route,frame('start'));
  streaming.frame('s3',route,frame('chunk',{chunk:{type:'text-delta',text:'Part'}}));
  await new Promise(resolve=>setTimeout(resolve,20));
  const state=streaming.detach('s3');
  assert.equal(await streaming.finish(state,route,'Full answer'),true);
  assert.deepEqual(calls,['Full answer']);
});
test('abandoned attempt cannot be delivered as final text',async()=>{
  const {streaming,calls,tick,route}=setup({chatId:-1007,chatType:'supergroup',threadId:11,key:'-1007:11'});
  streaming.begin('s4',route);
  streaming.frame('s4',route,frame('start'));
  streaming.frame('s4',route,frame('chunk',{chunk:{type:'text-delta',text:'Wrong guess'}}));
  await tick();
  streaming.frame('s4',route,frame('end',{outcome:{kind:'abandoned'}}));
  const state=streaming.detach('s4');
  await streaming.finish(state,route,'Corrected reply');
  assert.ok(calls.some(c=>c[0]==='edit'&&c[2]==='Corrected reply'));
});
