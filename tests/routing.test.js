import test from 'node:test';
import assert from 'node:assert/strict';
import { routeForMessage, isAllowedMessage, parseIds, removeMention } from '../lib/routing.js';

const user = { id: 321 };
const privateMessage = (thread, chatId=321) => ({
  from:user,chat:{ id: chatId,type:'private' },text:'hello',
  ...(thread === undefined ? {} : {message_thread_id:thread}),
});
test('same private chat with distinct topic ids has distinct conversation keys', () => {
  assert.equal(routeForMessage(privateMessage(51)).key, '321:51');
  assert.equal(routeForMessage(privateMessage(52)).key, '321:52');
  assert.equal(routeForMessage(privateMessage()).key, '321:0');
});
test('forum General topic maps unthreaded updates to topic 1', () => {
  const msg={...privateMessage(),chat:{id:-10042,type:'supergroup',is_forum:true}};
  assert.equal(routeForMessage(msg).key, '-10042:1');
  assert.equal(routeForMessage({...msg,message_thread_id:77}).key,'-10042:77');
});
test('deny by default and require explicit group and author allowlists', () => {
  const base={allowedUserIds:new Set([321]),allowedGroupChatIds:new Set(),requireMention:true,botId:11,botUsername:'MyDemoBot'};
  assert.equal(isAllowedMessage(privateMessage(),base),true);
  assert.equal(isAllowedMessage({...privateMessage(),from:{id:222}},base),false);
  const msg={...privateMessage(6),chat:{id:-10042,type:'supergroup',is_forum:true},text:'@MyDemoBot help'};
  assert.equal(isAllowedMessage(msg,base),false);
  const allowed={...base,allowedGroupChatIds:new Set([-10042])};
  assert.equal(isAllowedMessage(msg,allowed),true);
  assert.equal(isAllowedMessage({...msg,text:'hello'},allowed),false);
  assert.equal(isAllowedMessage({...msg,text:'hello',reply_to_message:{from:{id:11}}},allowed),true);
  assert.equal(isAllowedMessage({...msg,from:{id:999}},allowed),false);
});
test('strip bot mention without changing remaining user text',()=>{
  assert.equal(removeMention('Please @MyDemoBot help','MyDemoBot'),'Please  help'.trim());
  assert.equal(removeMention('@MyDemoBot: hi','MyDemoBot'),': hi');
});
test('validate and normalize allowlists',()=>{
  assert.deepEqual(parseIds('1, 2; -10042\n2'),[1,2,-10042]);
  assert.throws(()=>parseIds('bob'),/numeric IDs/);
});
