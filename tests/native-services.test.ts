import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const labels=['org.characterharness.qwen-tts','org.characterharness.audio-worker'];
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'harness-lifecycle-')),agents=join(dir,'agents');await mkdir(agents);
 for(const l of labels)await writeFile(join(agents,l+'.plist'),'fixture');
 const ctl=join(dir,'launchctl'),probe=join(dir,'probe'),sleeper=join(dir,'sleep'),compose=join(dir,'compose');
 await writeFile(ctl,String.raw`#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
root=Path(os.environ['FIXTURE_DIR']);file=root/'state.json';state=json.loads(file.read_text()) if file.exists() else {}
a=sys.argv[1:];label=a[-1].split('/')[-1].removesuffix('.plist');entry=state.setdefault(label,{})
with (root/'calls').open('a') as f:f.write(' '.join(a)+'\n')
if a[0]=='print':
 if entry.get('unload_polls',0)>0:
  entry['unload_polls']-=1
  if entry['unload_polls']==0:entry['loaded']=False
  file.write_text(json.dumps(state))
 if not entry.get('loaded'):sys.exit(1)
 print('state = running\npid = 123')
elif a[0]=='disable':entry['disabled']=True
elif a[0]=='enable':entry['disabled']=False
elif a[0]=='bootstrap':
 if entry.get('disabled'):sys.exit(1)
 entry['loaded']=True
elif a[0]=='bootout':
 if os.environ.get('FAIL_BOOTOUT')==label:sys.exit(5)
 if os.environ.get('DELAY_BOOTOUT'):entry['unload_polls']=3
 else:entry['loaded']=False
file.write_text(json.dumps(state))
`,{mode:0o700});
 await writeFile(probe,'#!/bin/sh\necho ready >> "$FIXTURE_DIR/calls"\n',{mode:0o700});
 await writeFile(sleeper,'#!/bin/sh\nexit 0\n',{mode:0o700});
 await writeFile(compose,'#!/bin/sh\necho compose >> "$FIXTURE_DIR/calls"\n',{mode:0o700});
 const env={...process.env,FIXTURE_DIR:dir,NATIVE_AGENT_DIR:agents,LAUNCHCTL:ctl,NATIVE_CURL:probe,NATIVE_SLEEP:sleeper};
 return {dir,agents,env,compose,run:(mode:string,extra={})=>execFileSync('sh',['scripts/native-services.sh',mode],{env:{...env,...extra},stdio:'pipe'}),state:async()=>JSON.parse(await readFile(join(dir,'state.json'),'utf8')),calls:async()=>await readFile(join(dir,'calls'),'utf8')};
}
test('manual start enables services, waits for TTS before audio and stop disables/unloads both',async()=>{
 const f=await fixture();try{
  f.run('start');let state=await f.state();for(const l of labels){assert.equal(state[l].loaded,true);assert.equal(state[l].disabled,false);}
  const calls=await f.calls();assert.ok(calls.indexOf('ready')<calls.indexOf('kickstart gui/'+process.getuid!()+'/'+labels[1]));
  f.run('stop');state=await f.state();for(const l of labels){assert.equal(state[l].loaded,false);assert.equal(state[l].disabled,true);}
  f.run('start');state=await f.state();for(const l of labels)assert.equal(state[l].loaded,true);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('stop works after plist removal and reports failed unload while still stopping other service and Compose',async()=>{
 const f=await fixture();try{
  f.run('start');await rm(f.agents,{recursive:true});
  assert.throws(()=>execFileSync('make',['stop','COMPOSE='+f.compose],{env:{...f.env,FAIL_BOOTOUT:labels[1]},stdio:'pipe'}));
  const state=await f.state();assert.equal(state[labels[0]].loaded,false);assert.equal(state[labels[1]].loaded,true);assert.equal(state[labels[1]].disabled,true);
  assert.match(await f.calls(),/compose/);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('missing configuration fails preflight and bare make does not start services',async()=>{
 const f=await fixture();try{
  await rm(join(f.agents,labels[1]+'.plist'));assert.throws(()=>f.run('check'));
  execFileSync('make',[],{env:f.env,stdio:'pipe'});
  await assert.rejects(readFile(join(f.dir,'calls'),'utf8'),{code:'ENOENT'});
 }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('stop waits for asynchronous launchctl unloading without reporting a false failure',async()=>{
 const f=await fixture();try{
  f.run('start');f.run('stop',{DELAY_BOOTOUT:'1'});
  const state=await f.state();for(const l of labels)assert.equal(state[l].loaded,false);
 }finally{await rm(f.dir,{recursive:true,force:true});}
});
