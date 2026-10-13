import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { TelegramBridge } from '../lib/bridge.js';

function fixture(file) {
  const agents=new Map(), inputs=[], output=[], listeners=new Map();
  let created=0;
  const ctx={
    logger:{warn(){},info(){},error(){}},
    workspaceRegistry:{list:()=>[{id:'workspace-one',path:'/tmp/workspace'}]},
    sessionController:{
      async create({workspaceId}) {
        assert.equal(workspaceId,'workspace-one');
        const id='session-'+(++created);
        agents.set(id,{status:'idle',followup:(message)=>inputs.push({id,message})});
        return {sessionId:id};
      },
      async resolveAgent(id) {
        return agents.has(id) ? {agent:agents.get(id)} : {error:new Error('missing session')};
      },
    },
    on(name,cb) {listeners.set(name,cb);return ()=>listeners.delete(name);},
  };
  const api={
    async send(route,text) {output.push({key:route.key,chatId:route.chatId,threadId:route.threadId,text});},
  };
  const newBridge=()=>new TelegramBridge(ctx,{
    allowedUserIds:[444],allowedGroupChatIds:[-100700],
    requireMention:false,workspaceId:'',
    stateFile:file,api,makeUserMessage:text=>({content:[{type:'text',text}],source:{kind:'user'}}),
  });
  return {ctx,api,agents,inputs,output,newBridge,created:()=>created};
}
const msg=(thread,text,chatId=444,chatType='private')=>({
  message:{ chat:{id:chatId,type:chatType,is_forum:chatType!=='private'},
    from:{id:444},message_thread_id:thread,text},
});
test('two Telegram topics are separate sessions and replies go to originating topic',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b=f.newBridge();
    await b.initialize();
    await b.handleUpdate(msg(11,'first'));
    await b.handleUpdate(msg(22,'second'));
    await b.handleUpdate(msg(11,'again'));
    assert.equal(f.created(),2);
    assert.deepEqual(f.inputs.map(x=>x.id),['session-1','session-2','session-1']);
    assert.deepEqual(f.inputs.map(x=>x.message.content[0].text),['first','second','again']);
    b.onSessionEvent({id:'session-2'},{type:'turn/start'});
    b.onSessionEvent({id:'session-2'},{
      type:'assistant/message',data:{message:{content:[{type:'text',text:'Reply B'}]}}});
    b.onSessionEvent({id:'session-2'},{type:'turn/end',data:{reason:{kind:'completed'}}});
    b.onSessionEvent({id:'session-1'},{type:'turn/start'});
    b.onSessionEvent({id:'session-1'},{
      type:'assistant/message',data:{message:{content:[{type:'text',text:'Reply A'}]}}});
    b.onSessionEvent({id:'session-1'},{type:'turn/end',data:{reason:{kind:'completed'}}});
    await b.drain();
    assert.deepEqual(f.output.map(x=>[x.threadId,x.text]),[[22,'Reply B'],[11,'Reply A']]);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('restart resumes original topic sessions; /new resets only its topic',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b1=f.newBridge();
    await b1.initialize();
    await b1.handleUpdate(msg(101,'one'));
    await b1.handleUpdate(msg(102,'two'));
    assert.equal(f.created(),2);
    const b2=f.newBridge();
    await b2.initialize();
    await b2.handleUpdate(msg(101,'after restart'));
    assert.equal(f.created(),2);
    assert.equal(f.inputs.at(-1).id,'session-1');
    await b2.handleUpdate(msg(101,'/new'));
    assert.equal(f.created(),3);
    await b2.handleUpdate(msg(102,'still previous'));
    assert.equal(f.inputs.at(-1).id,'session-2');
    assert.equal(b2.store.get('444:101').sessionId,'session-3');
    assert.equal(b2.store.get('444:102').sessionId,'session-2');
    const b3=f.newBridge();await b3.initialize();
    assert.equal(b3.store.get('444:101').sessionId,'session-3');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('group chats require allowed chat and user before any agent session',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b=f.newBridge();
    await b.initialize();
    await b.handleUpdate(msg(11,'group accepted',-100700,'supergroup'));
    await b.handleUpdate(msg(12,'group denied',-100701,'supergroup'));
    await b.handleUpdate({message:{...msg(13,'author denied',-100700,'supergroup').message,from:{id:999}}});
    assert.equal(f.created(),1);
    assert.equal(b.store.get('-100700:11').sessionId,'session-1');
    assert.equal(b.store.get('-100701:12'),undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('status command with explicit @botname replies without creating an agent session',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json'));
    const b=f.newBridge();
    await b.initialize();
    await b.handleUpdate(msg(0,'/status@Rapmon_bot'));
    assert.equal(f.created(),0);
    assert.equal(f.output.length,1);
    assert.match(f.output[0].text,/No conversation in this topic yet/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('diagnostic events never include private message text or identifiers',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json'));
    const captured=[];
    f.ctx.logger.warn = text=>captured.push(text);
    const b=f.newBridge();
    b.diagnostics=true;
    await b.initialize();
    await b.handleUpdate(msg(0,'SECRET_EXAMPLE_abcdef'));
    await b.handleUpdate({message:{...msg(0,'SECRET_EXAMPLE_abcdef').message,from:{id:999999}}});
    const combined=captured.join('\n');
    assert.match(combined,/message accepted/);
    assert.match(combined,/message ignored: sender not authorized/);
    assert.doesNotMatch(combined,/SECRET_EXAMPLE_abcdef/);
    assert.doesNotMatch(combined,/999999/);
    assert.doesNotMatch(combined,/session-1/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
