import { CodexRpc } from '../packages/codex/rpc.ts';
import { configureCodex } from '../packages/codex/config.ts';
const home=process.env.HARNESS_CODEX_HOME??'/data/codex';
const cwd=process.env.HARNESS_CODEX_WORKSPACE??'/data/workspace';
await configureCodex(home,cwd);
const rpc=new CodexRpc(process.env.CODEX_BIN??'/app/node_modules/.bin/codex',cwd,home);
try{
 await rpc.initialize();
 const auth=await rpc.request('account/read',{refreshToken:false});
 if(auth.account?.type==='chatgpt'){console.log('ChatGPT login already configured.');}
 else{
  let complete:(v:boolean)=>void=()=>{};
  const done=new Promise<boolean>(r=>{complete=r;});
  rpc.onNotification=(method,p)=>{if(method==='account/login/completed')complete(p.success===true);};
  const login=await rpc.request('account/login/start',{type:'chatgptDeviceCode'},30000);
  console.log(JSON.stringify({verification_url:login.verificationUrl,user_code:login.userCode}));
  const timeout=setTimeout(()=>complete(false),600000);
  try{if(!(await done))throw new Error('Login not completed');console.log('Isolated ChatGPT login completed.');}finally{clearTimeout(timeout);}
 }
}finally{rpc.close();}
