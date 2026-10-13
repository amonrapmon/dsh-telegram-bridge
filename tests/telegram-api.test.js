import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApi, splitText, escapeTelegramHtml } from '../lib/telegram-api.js';

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

test('approval card contains real newlines, bold HTML and safe group title',async()=>{
  const {calls,api}=makeClient();
  const title='Домашка <очень> & "важно"';
  await api.requestGroupApproval(444,{id:-1004350969810,title},{token:'0123456789abcdef'});
  const req=calls[0].body;
  assert.equal(req.chat_id,444);
  assert.equal(req.parse_mode,'HTML');
  assert.equal(req.text,'🛡️ <b>Запрос на подключение группы</b>\n\n'
    + '<b>Группа:</b> Домашка &lt;очень&gt; &amp; &quot;важно&quot;'
    + '\n<b>ID:</b> <code>-1004350969810</code>'
    + '\n\nРазрешить боту работать в этой группе?');
  assert.equal(req.text.includes('\\n'),false);
  assert.deepEqual(req.reply_markup.inline_keyboard[0].map(b=>b.callback_data),
    ['group:allow:0123456789abcdef','group:deny:0123456789abcdef']);
  await api.editApprovalCard(444,1000,{id:-1004350969810,title},true);
  const confirmed=calls[1].body;
  assert.equal(confirmed.parse_mode,'HTML');
  assert.match(confirmed.text,/✅ <b>Доступ разрешён<\/b>\n\n<b>Группа:<\/b>/);
  assert.ok(confirmed.text.includes('Домашка &lt;очень&gt; &amp; &quot;важно&quot;'));
  assert.equal(confirmed.text.includes('\\n'),false);
  await api.editApprovalCard(444,1000,{id:-1004350969810,title},false);
  assert.match(calls[2].body.text,/❌ <b>Доступ отклонён<\/b>/);
  assert.equal(escapeTelegramHtml('<b>unsafe</b>'),'&lt;b&gt;unsafe&lt;/b&gt;');
});


test('streaming API supports private topic drafts and editable supergroup topic preview', async()=>{
  const {calls,api}=makeClient();
  const privateTopic={chatId:444,threadId:29,chatType:'private'};
  const groupTopic={chatId:-100222,threadId:52,chatType:'supergroup'};
  await api.sendDraft(privateTopic,928,'Частичный ответ');
  assert.equal(calls[0].url.endsWith('/sendMessageDraft'),true);
  assert.deepEqual(calls[0].body,{
    chat_id:444,draft_id:928,text:'Частичный ответ',message_thread_id:29,
  });
  await api.sendPreview(groupTopic,'Готовлю ответ');
  assert.equal(calls[1].url.endsWith('/sendMessage'),true);
  assert.deepEqual(calls[1].body,{
    chat_id:-100222,text:'Готовлю ответ',message_thread_id:52,
  });
  await api.editPreview(groupTopic,901,'Ответ готов');
  assert.equal(calls[2].url.endsWith('/editMessageText'),true);
  assert.deepEqual(calls[2].body,{
    chat_id:-100222,message_id:901,text:'Ответ готов',
  });
  await api.deletePreview(groupTopic,901);
  assert.equal(calls[3].url.endsWith('/deleteMessage'),true);
});
