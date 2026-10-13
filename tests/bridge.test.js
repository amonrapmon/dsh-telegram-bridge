import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { TelegramBridge } from '../lib/bridge.js';

function fixture(file, workspaces=[{id:'workspace-one',path:'/tmp/workspace'}]) {
  const agents=new Map(), inputs=[], output=[], listeners=new Map();
  let created=0;
  const ctx={
    logger:{warn(){},info(){},error(){}},
    workspaceRegistry:{list:()=>workspaces},
    sessionController:{
      async create({workspaceId,cwd}) {
        if (workspaces.length === 0) {
          assert.equal(workspaceId,undefined);
          assert.equal(cwd,process.cwd());
        } else {
          assert.equal(workspaceId,workspaces[0].id);
          assert.equal(cwd,undefined);
        }
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
  const approvals=[], callbacks=[], edited=[], refreshed=[];
  const api={
    async send(route,text) {output.push({key:route.key,chatId:route.chatId,threadId:route.threadId,text});},
    async requestGroupApproval(adminId,group,approval) {
      const message_id=approvals.length+1000;
      approvals.push({adminId,group,approval:structuredClone(approval),message_id});
      return {message_id};
    },
    async answerCallbackQuery(id,text) {callbacks.push({id,text});},
    async editApprovalCard(adminId,messageId,group,allowed) {
      edited.push({adminId,messageId,group,allowed});
    },
    async refreshGroupApprovalCard(adminId,messageId,group,approval) {
      refreshed.push({adminId,messageId,group,approval});
    },
  };
  const newBridge=()=>new TelegramBridge(ctx,{
    allowedUserIds:[444],allowedGroupChatIds:[-100700],
    requireMention:false,workspaceId:'',
    stateFile:file,api,makeUserMessage:text=>({content:[{type:'text',text}],source:{kind:'user'}}),
  });
  return {ctx,api,agents,inputs,output,approvals,callbacks,edited,refreshed,newBridge,created:()=>created};
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
    const b=f.newBridge();
    b.diagnostics=true;
    b.diagnosticSink = text => captured.push(text);
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

test('a new session is created using cwd when no Harness workspace exists',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json'),[]),b=f.newBridge();
    await b.initialize();
    await b.handleUpdate(msg(0,'/new'));
    assert.equal(f.created(),1);
    assert.match(f.output[0].text,/Started a new conversation/);
    await b.handleUpdate(msg(0,'hello'));
    assert.equal(f.inputs[0].id,'session-1');
    assert.equal(f.inputs[0].message.content[0].text,'hello');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('a failing /new replies with a configuration error and cannot block later updates',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-integration-'));
  try {
    const f=fixture(path.join(dir,'state.json'),[{id:'one'},{id:'two'}]),b=f.newBridge();
    await b.initialize();
    await b.handleUpdate(msg(0,'/new'));
    assert.equal(f.created(),0);
    assert.match(f.output[0].text,/Could not create a Harness conversation/);
    await b.handleUpdate(msg(0,'/status'));
    assert.equal(f.output.length,2);
    assert.match(f.output[1].text,/No conversation in this topic yet/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('bot added to group triggers one private superadmin approval card; no env group ID',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-approval-'));
  try {
    const f=fixture(path.join(dir,'state.json'));
    const b=f.newBridge();
    b.allowedGroupChatIds.clear();
    b.botId=123456;
    await b.initialize();
    const chat={id:-100900,type:'supergroup',title:'My Project',is_forum:true};
    const update={my_chat_member:{chat,
      old_chat_member:{status:'left'},new_chat_member:{status:'member',user:{id:123456}}}};
    await b.handleUpdate(update);
    await b.handleUpdate(update);
    await b.handleUpdate({message:{...msg(11,'hello',-100900,'supergroup').message,chat,from:{id:444}}});
    assert.equal(f.approvals.length,1);
    assert.equal(f.approvals[0].adminId,444);
    assert.equal(f.approvals[0].group.title,'My Project');
    assert.equal(f.created(),0);
    const token=f.approvals[0].approval.token;
    const adminMessageId=f.approvals[0].message_id;
    const callback={id:'cb1',from:{id:444},data:'group:allow:'+token,
      message:{message_id:adminMessageId,chat:{id:444,type:'private'}}};
    await b.handleUpdate({callback_query:callback});
    assert.equal(b.store.groupApproval(-100900).status,'allowed');
    assert.equal(f.edited[0].allowed,true);
    await b.handleUpdate({message:{...msg(11,'@HarnessSmokeBot hello',-100900,'supergroup').message,chat,from:{id:444}}});
    assert.equal(f.created(),1);
    assert.equal(f.inputs.length,1);
    // An authorized group may have different topic sessions.
    await b.handleUpdate({message:{...msg(12,'hello in topic 2',-100900,'supergroup').message,chat,from:{id:444}}});
    assert.equal(f.created(),2);
    const b2=f.newBridge();b2.allowedGroupChatIds.clear();
    await b2.initialize();
    assert.equal(b2.isGroupAuthorized(-100900),true);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('reject button blocks group, non-superadmin buttons cannot change access',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-approval-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b=f.newBridge();
    b.allowedGroupChatIds.clear();b.botId=123456;
    await b.initialize();
    const chat={id:-100901,type:'supergroup',title:'Rejected Group'};
    await b.handleUpdate({my_chat_member:{chat,old_chat_member:{status:'left'},
      new_chat_member:{status:'administrator',user:{id:123456}}}});
    const card=f.approvals[0];
    const cb={id:'cb2',data:'group:deny:'+card.approval.token,
      message:{message_id:card.message_id,chat:{id:444,type:'private'}}};
    await b.handleUpdate({callback_query:{...cb,from:{id:9999}}});
    assert.equal(b.store.groupApproval(chat.id).status,'pending');
    assert.equal(f.callbacks.at(-1).text,'Доступ запрещён');
    await b.handleUpdate({callback_query:{...cb,from:{id:444}}});
    assert.equal(b.store.groupApproval(chat.id).status,'denied');
    await b.handleUpdate({callback_query:{...cb,from:{id:444}}});
    assert.equal(f.callbacks.at(-1).text,'Решение уже принято');
    await b.handleUpdate({message:{...msg(0,'anything',chat.id,'supergroup').message,chat}});
    assert.equal(f.approvals.length,1);
    assert.equal(f.created(),0);
    const restart=f.newBridge();restart.allowedGroupChatIds.clear();
    await restart.initialize();
    assert.equal(restart.isGroupAuthorized(chat.id),false);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('callback for old request cannot approve a later request after rejoin',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-approval-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b=f.newBridge();
    b.allowedGroupChatIds.clear();b.botId=123456;
    await b.initialize();
    const chat={id:-100902,type:'supergroup',title:'Rejoined'};
    const event={chat,old_chat_member:{status:'left'},
      new_chat_member:{status:'member',user:{id:123456}}};
    await b.handleUpdate({my_chat_member:event});
    const old=f.approvals[0];
    const cb=(card,action)=>({id:'cb-'+action,from:{id:444},data:'group:'+action+':'+card.approval.token,
      message:{message_id:card.message_id,chat:{id:444,type:'private'}}});
    await b.handleUpdate({callback_query:cb(old,'deny')});
    await b.handleUpdate({my_chat_member:event});
    assert.equal(f.approvals.length,2);
    assert.notEqual(f.approvals[0].approval.token,f.approvals[1].approval.token);
    await b.handleUpdate({callback_query:cb(old,'allow')});
    assert.equal(b.store.groupApproval(chat.id).status,'pending');
    await b.handleUpdate({callback_query:cb(f.approvals[1],'allow')});
    assert.equal(b.store.groupApproval(chat.id).status,'allowed');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('an old pending group approval card is upgraded in place once after restart',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bridge-approval-'));
  try {
    const f=fixture(path.join(dir,'state.json')),b=f.newBridge();
    b.allowedGroupChatIds.clear();b.botId=123456;
    await b.initialize();
    const chat={id:-1003456,type:'supergroup',title:'Old approval card'};
    await b.handleUpdate({my_chat_member:{chat,old_chat_member:{status:'left'},
      new_chat_member:{status:'member',user:{id:123456}}}});
    assert.equal(f.approvals.length,1);
    const oldToken=b.store.groupApproval(chat.id).token;
    const oldMsg=b.store.groupApproval(chat.id).notificationMessageId;
    assert.equal(b.store.groupApproval(chat.id).formatVersion,2);
    // Simulate a state file generated before HTML/newline support.
    delete b.store.state.groupApprovals[String(chat.id)].formatVersion;
    await b.store.flush();
    const b2=f.newBridge();
    await b2.initialize();
    await b2.refreshPendingApprovalCards();
    assert.equal(f.refreshed.length,1);
    assert.equal(f.refreshed[0].messageId,oldMsg);
    assert.equal(f.refreshed[0].approval.token,oldToken);
    assert.equal(b2.store.groupApproval(chat.id).formatVersion,2);
    await b2.refreshPendingApprovalCards();
    assert.equal(f.refreshed.length,1);
    assert.equal(f.approvals.length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
