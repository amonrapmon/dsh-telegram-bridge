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


test('separate topics keep independent previews, draft/message IDs and final texts',async()=>{
  const route1={chatId:-10021,chatType:'supergroup',threadId:15,key:'-10021:15'};
  const route2={chatId:-10021,chatType:'supergroup',threadId:16,key:'-10021:16'};
  const {streaming,calls,tick}=setup(route1);
  const next=(id,route,text,attemptId)=>{
    streaming.begin(id,route);
    streaming.frame(id,route,{type:'start',attemptId});
    streaming.frame(id,route,{type:'chunk',attemptId,chunk:{type:'text-delta',text}});
  };
  next('a',route1,'А','attempt-a');
  next('b',route2,'Б','attempt-b');
  await tick();
  const stateA=streaming.detach('a');
  const stateB=streaming.detach('b');
  await streaming.finish(stateA,route1,'А');
  await streaming.finish(stateB,route2,'Б');
  const previews=calls.filter(c=>c[0]==='preview');
  const edits=calls.filter(c=>c[0]==='edit');
  assert.equal(previews.length,2);
  assert.equal(edits.length,2);
  assert.deepEqual(new Set(previews.map(c=>c[2])),new Set([15,16]));
  assert.deepEqual(new Set(edits.map(c=>c[3])),new Set([15,16]));
  assert.notEqual(edits[0][1],edits[1][1]);
  assert.equal(calls.filter(c=>c[0]==='send').length,0);
});

test('long group responses edit one bounded preview and then send the remaining text',async()=>{
  const route={chatId:-10030,chatType:'supergroup',threadId:55,key:'-10030:55'};
  const {streaming,calls,tick}=setup(route);
  streaming.begin('long',route);
  streaming.frame('long',route,frame('start'));
  streaming.frame('long',route,frame('chunk',{chunk:{type:'text-delta',text:'Начало'}}));
  await tick();
  const answer='🐱'.repeat(4100);
  await streaming.finish(streaming.detach('long'),route,answer);
  const edits=calls.filter(c=>c[0]==='edit');
  const remainder=calls.filter(c=>c[0]==='send');
  assert.equal(edits.length,1);
  assert.equal(remainder.length,1);
  assert.equal(Array.from(edits[0][2]).length,3900);
  assert.equal(edits[0][2]+remainder[0][1],answer);
});

test('if group final edit fails the stale streaming preview is deleted and full text is sent',async()=>{
  const route={chatId:-10041,chatType:'supergroup',threadId:10,key:'-10041:10'};
  const calls=[];
  const api={
    async sendPreview(r,text) {calls.push(['preview',text]);return {message_id:51};},
    async editPreview() {calls.push(['edit']);throw new Error('Telegram edit failed');},
    async deletePreview(r,id) {calls.push(['delete',id]);},
    async send(r,text) {calls.push(['send',text]);},
  };
  const streaming=new StreamingDelivery(api,{initialDelayMs:1,intervalMs:1});
  streaming.begin('failed',route);
  streaming.frame('failed',route,frame('start'));
  streaming.frame('failed',route,frame('chunk',{chunk:{type:'text-delta',text:'Часть'}}));
  await new Promise(resolve=>setTimeout(resolve,20));
  await streaming.finish(streaming.detach('failed'),route,'Полный ответ');
  assert.deepEqual(calls.map(c=>c[0]),['preview','edit','delete','send']);
  assert.equal(calls.at(-1)[1],'Полный ответ');
});
