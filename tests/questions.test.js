import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramQuestions } from '../lib/questions.js';

function fixture() {
  const route = { key:'-100555:42',chatId:-100555,chatType:'supergroup',threadId:42 };
  const routes = new Map([['session-live',route]]);
  const allowed = new Set([444]);
  let bound = true, nextMessageId = 100;
  const prompts = [], edits = [], markup = [], notices = [], acks = [], send = [];
  const api = {
    async sendQuestion(r,text,keyboard) {
      const message_id = nextMessageId++;
      prompts.push({route:r,text,keyboard,message_id});
      return {message_id};
    },
    async editQuestionMarkup(r,id,keyboard){markup.push({route:r,id,keyboard});},
    async closeQuestion(r,id,text){edits.push({route:r,id,text});},
    async answerCallbackQuery(id,text){acks.push({id,text});},
    async send(r,text){send.push({route:r,text});},
  };
  const q = new TelegramQuestions({
    api,
    routeForSession:id=>routes.get(id),
    permitted:(state,user)=>bound && allowed.has(user) && routes.get(state.sessionId)?.key===state.route.key,
  });
  const request=(questions,signal)=>({
    agent:{session:{id:'session-live'}},questions,signal,
  });
  const choice=(token,choice,user=444,chatId=route.chatId,messageId=prompts.at(-1).message_id)=>({
    id:'cb-1',from:{id:user},data:'q:'+token+':'+choice,
    message:{message_id:messageId,chat:{id:chatId,type:'supergroup'}},
  });
  const active=()=>[...q.pending.values()].at(-1);
  return {q,route,routes,allowed,request,choice,active,
    prompts,edits,markup,notices,acks,send,setBound:b=>{bound=b;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const question={id:'time',question:'Когда поставить встречу?',header:'Время встречи',
  options:[{label:'08:00',description:'Свободное окно'},
    {label:'09:00',description:'Перед работой'},
    {label:'Другое время'}]};

test('inline button resolves original pending tool call with exact selected label',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([question]),()=>{throw new Error('should not delegate');});
  await tick();
  assert.match(f.prompts[0].text,/Когда поставить встречу/);
  assert.match(f.prompts[0].text,/Перед работой/);
  assert.equal(f.prompts[0].route.threadId,42);
  assert.equal(f.prompts[0].keyboard.inline_keyboard.length,5);
  await f.q.callback(f.choice(f.active().token,'1'));
  assert.deepEqual(await pending,{answers:[{id:'time',selected:['09:00']}]});
  assert.equal(f.edits.length,1);
  assert.equal(f.q.pending.size,0);
});

test('stale or unauthorized callback never resolves pending question',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([question]),()=>{throw Error('unexpected fallback');});
  await tick();
  const token=f.active().token;
  await f.q.callback(f.choice(token,'0',999));
  await f.q.callback(f.choice(token,'0',444,-100556));
  await f.q.callback(f.choice(token,'0',444,f.route.chatId,5555));
  assert.equal(f.q.pending.size,1);
  assert.equal(f.edits.length,0);
  f.setBound(false);
  await f.q.callback(f.choice(token,'0'));
  assert.equal(f.edits.length,0);
  f.setBound(true);
  await f.q.callback(f.choice(token,'2'));
  assert.deepEqual(await pending,{answers:[{id:'time',selected:['Другое время']}]});
  await f.q.callback(f.choice(token,'2'));
  assert.match(f.acks.at(-1).text,/уже закрыт/i);
});

test('multiple questions in one tool call are answered sequentially in one batch',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([
    question,{id:'confirm',question:'Подтвердить?',options:[{label:'Да'},{label:'Нет'}]},
  ]),()=>{throw Error('no fallback');});
  await tick();
  const first=f.active().token;
  await f.q.callback(f.choice(first,'0'));
  await tick();
  assert.equal(f.prompts.length,2);
  assert.notEqual(first,f.active().token);
  await f.q.callback(f.choice(f.active().token,'1'));
  assert.deepEqual(await pending,{
    answers:[{id:'time',selected:['08:00']},{id:'confirm',selected:['Нет']}],
  });
});

test('multi-select toggles labels, submit preserves exact sorted selected labels',async()=>{
  const f=fixture(), multi={...question,multiSelect:true};
  const pending=f.q.ask(f.request([multi]),()=>{throw Error('no fallback');});
  await tick();
  const token=f.active().token;
  await f.q.callback(f.choice(token,'2'));
  await f.q.callback(f.choice(token,'0'));
  await f.q.callback(f.choice(token,'ok'));
  assert.deepEqual(await pending,{answers:[{id:'time',selected:['08:00','Другое время']}]});
  assert.equal(f.markup.length,2);
});

test('custom typed text is captured only when explicitly selected or replying to question',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([question]),()=>{throw Error('no fallback');});
  await tick();
  assert.equal(await f.q.message({text:'unrelated',from:{id:444}},f.route),false);
  await f.q.callback(f.choice(f.active().token,'custom'));
  assert.equal(await f.q.message({text:'13:00',from:{id:999}},f.route),false);
  assert.equal(await f.q.message({text:'13:00',from:{id:444}}, {...f.route,key:'different'}),false);
  assert.equal(await f.q.message({text:'13:00',from:{id:444}},f.route),true);
  assert.deepEqual(await pending,{answers:[{id:'time',selected:[],custom:'13:00'}]});
  const second=f.q.ask(f.request([question]),()=>{throw Error('no fallback');});
  await tick();
  const msgId=f.prompts.at(-1).message_id;
  assert.equal(await f.q.message({text:'10:30',from:{id:444},reply_to_message:{message_id:msgId}},f.route),true);
  assert.deepEqual(await second,{answers:[{id:'time',selected:[],custom:'10:30'}]});
});

test('skip and abortion settle without injecting an unauthorized answer',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([question]),()=>{throw Error('no fallback');});
  await tick();
  await f.q.callback(f.choice(f.active().token,'skip'));
  assert.deepEqual(await pending,{answers:[{id:'time',selected:[]}]});
  const abort=new AbortController();
  const aborted=f.q.ask(f.request([question],abort.signal),()=>{throw Error('no fallback');});
  await tick();
  abort.abort();
  await assert.rejects(aborted,/aborted/);
  assert.equal(f.q.pending.size,0);
});

test('non-Telegram sessions and failed Telegram sends delegate to existing Web answerer',async()=>{
  const f=fixture();
  const noAgent = f.q.ask({questions:[question]},async()=>({answers:[]}));
  assert.deepEqual(await noAgent,{answers:[]});
  f.q.api.sendQuestion=async()=>{throw new Error('Telegram offline');};
  let delegated=0;
  const result=await f.q.ask(f.request([question]),async()=>{
    delegated++;
    return {answers:[{id:'time',selected:['Web']}]};
  });
  assert.equal(delegated,1);
  assert.deepEqual(result,{answers:[{id:'time',selected:['Web']}]});
});

test('long detail is not truncated and shutdown releases pending tool question',async()=>{
  const f=fixture();
  const long={id:'plan',question:'Утвердить?',detail:'x'.repeat(7800),options:[{label:'Да'}]};
  const pending=f.q.ask(f.request([long]),()=>{throw Error('no fallback');});
  await tick();
  assert.equal(f.send.length,1);
  assert.ok(f.send[0].text.includes(long.detail));
  f.q.close();
  await assert.rejects(pending,/aborted/);
  assert.equal(f.q.pending.size,0);
});


test('switching a topic Session cancels its unanswered tool and disables old buttons',async()=>{
  const f=fixture();
  const pending=f.q.ask(f.request([question]),()=>{throw Error('no fallback');});
  await tick();
  const token=f.active().token;
  f.q.cancelForRoute(f.route.key);
  await assert.rejects(pending,/aborted/);
  assert.equal(f.q.pending.size,0);
  await f.q.callback(f.choice(token,'0'));
  assert.match(f.acks.at(-1).text,/закрыт/);
});
