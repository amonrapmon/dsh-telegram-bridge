import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApi, splitText } from '../lib/telegram-api.js';

function makeClient() {
  const calls=[];
  const fetch=async (url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:calls.length}})};
  };
  return {calls,api:new TelegramApi('test-token',{fetch})};
}
test('outgoing message targets the exact topic',async()=>{
  const {calls,api}=makeClient();
  await api.send({chatId:321,threadId:55},'Reply from model');
  assert.deepEqual(calls[0].body,{chat_id:321,text:'Reply from model',message_thread_id:55});
});
test('General topic and root omit topic parameter',async()=>{
  const {calls,api}=makeClient();
  await api.send({chatId:-1001,threadId:1},'General');
  await api.send({chatId:321,threadId:0},'Private');
  assert.equal('message_thread_id' in calls[0].body,false);
  assert.equal('message_thread_id' in calls[1].body,false);
});
test('long Unicode text is split without cutting code points',async()=>{
  const message='🐕'.repeat(4100);
  const {calls,api}=makeClient();
  await api.send({chatId:321,threadId:22},message);
  assert.equal(calls.length,2);
  assert.equal(calls.map(c=>c.body.text).join(''),message);
  assert.equal(calls[1].body.message_thread_id,22);
  assert.deepEqual(splitText('🦊🍃',1),['🦊','🍃']);
});
