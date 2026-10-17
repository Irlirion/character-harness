import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
type Message={id?:number|string;method?:string;params?:any;result?:any;error?:unknown};
export class CodexRpc {
 private sequence=0;
 private closed=false;
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 readonly child;
 onNotification:(method:string,params:any)=>void=()=>{};
 onRequest:(method:string,params:any)=>Promise<unknown>=async()=>{throw new Error('unsupported_request');};
 constructor(binary:string,cwd:string,home:string,args=['app-server','--stdio','--strict-config']){
  // Separate CODEX_HOME and explicit environment: never inherit user API keys/config.
  this.child=spawn(binary,args,{cwd,env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
  this.child.stderr.resume(); // Do not log provider/auth payloads.
  const lines=createInterface({input:this.child.stdout});
  lines.on('line',line=>{
   if(line.length>20_000_000){this.close();return;}
   try{this.receive(JSON.parse(line));}catch{this.close();}
  });
  this.child.stdin.on('error',()=>this.fail());this.child.stdout.on('error',()=>this.fail());
  this.child.on('error',()=>this.fail());this.child.on('exit',()=>this.fail());
 }
 private fail(){
  if(this.closed)return;
  this.closed=true;
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('codex_disconnected'));}
  this.pending.clear();
 }
 private send(m:Message){
  if(this.closed || this.child.stdin.destroyed)return false;
  try{return this.child.stdin.write(JSON.stringify(m)+'\n',error=>{if(error)this.fail();});}
  catch{this.fail();return false;}
 }
 private receive(m:Message){
  if(this.closed)return;
  if(m.method && m.id!==undefined){
   void this.onRequest(m.method,m.params).then(result=>this.send({id:m.id,result})).catch(()=>this.send({id:m.id,error:{code:-32601,message:'Request denied by harness'}}));
  }else if(m.id!==undefined){
   const p=this.pending.get(Number(m.id));if(!p)return;clearTimeout(p.timer);this.pending.delete(Number(m.id));
   if(m.error)p.reject(new Error('codex_rpc_error'));else p.resolve(m.result);
  }else if(m.method)this.onNotification(m.method,m.params);
 }
 request(method:string,params:unknown={},timeout=15000):Promise<any>{
  if(this.closed)return Promise.reject(new Error('codex_disconnected'));
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('codex_rpc_timeout'));},timeout);
   this.pending.set(id,{resolve,reject,timer});
   if(!this.send({id,method,params})){clearTimeout(timer);this.pending.delete(id);reject(new Error('codex_disconnected'));}
  });
 }
 async initialize(){await this.request('initialize',{clientInfo:{name:'character_harness',title:'Character Harness',version:'0.1.0'},capabilities:{experimentalApi:true}});this.send({method:'initialized',params:{}});}
 close(){this.fail();this.child.kill('SIGTERM');}
}
