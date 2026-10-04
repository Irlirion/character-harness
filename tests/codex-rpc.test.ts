import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../packages/codex/rpc.ts';

const fixture=fileURLToPath(new URL('./fixtures/codex-rpc-child.mjs',import.meta.url));
test('Codex RPC handles server tool requests and turn notifications',async()=>{
  const rpc=new CodexRpc(process.execPath,process.cwd(),'/tmp/harness-codex-rpc-test',['--input-type=module','--eval',`import(${JSON.stringify(fixture)})`]);
  try{
    await rpc.initialize();
    let notification:unknown;
    rpc.onNotification=(method,params)=>{if(method==='turn/completed')notification=params;};
    rpc.onRequest=async(method,params)=>({success:method==='item/tool/call'&&params.tool==='memory_search'});
    assert.deepEqual(await rpc.request('roundtrip'),{serverAccepted:true});
    assert.deepEqual(notification,{turn:{status:'completed'}});
    rpc.onRequest=async()=>{throw new Error('denied');};
    assert.deepEqual(await rpc.request('denied'),{serverDenied:true});
  }finally{rpc.close();}
  await assert.rejects(rpc.request('after-close'),/codex_disconnected/);
});
