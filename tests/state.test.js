import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../lib/state.js';

test('topic bindings and update checkpoint survive restart',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-tg-test-'));
  try {
    const file=path.join(dir,'bindings.json');
    const store=new StateStore(file);
    await store.load();
    await store.bind({key:'111:24',chatId:111,threadId:24},'session-alpha');
    await store.bind({key:'111:25',chatId:111,threadId:25},'session-beta');
    await store.checkpoint(101);
    const restarted=new StateStore(file);
    await restarted.load();
    assert.equal(restarted.get('111:24').sessionId,'session-alpha');
    assert.equal(restarted.get('111:25').sessionId,'session-beta');
    assert.equal(restarted.offset(),102);
    assert.equal(restarted.seen(101),true);
    assert.equal(restarted.seen(102),false);
    assert.equal(JSON.parse(await readFile(file,'utf8')).version,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('corrupt state fails closed and is not overwritten',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-tg-test-'));
  try {
    const file=path.join(dir,'bindings.json');
    await writeFile(file,'not json');
    const state=new StateStore(file);
    await assert.rejects(()=>state.load());
    assert.equal(await readFile(file,'utf8'),'not json');
  } finally {await rm(dir,{recursive:true,force:true});}
});
