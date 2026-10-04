import { CodexRpc } from '../packages/codex/rpc.ts';
import { configureCodex } from '../packages/codex/config.ts';
import { selectConfiguredModel } from '../packages/codex/model.ts';
const home=process.env.HARNESS_CODEX_HOME??'/data/codex';
const cwd=process.env.HARNESS_CODEX_WORKSPACE??'/data/workspace';
await configureCodex(home,cwd);
const rpc=new CodexRpc(process.env.CODEX_BIN??'/app/node_modules/.bin/codex',cwd,home);
try{
 await rpc.initialize();
 const auth=await rpc.request('account/read',{refreshToken:false});
 if(auth.account?.type!=='chatgpt')throw new Error('isolated_chatgpt_login_required');
 const models=await rpc.request('model/list',{});
 const selected=selectConfiguredModel(models.data,process.env.CODEX_MODEL??'gpt-6-luna');
 console.log(JSON.stringify({authenticated:true,configured_model:selected.model??selected.id}));
 const t=await rpc.request('thread/start',{ephemeral:true,environments:[],runtimeWorkspaceRoots:[],cwd,sandbox:'read-only',approvalPolicy:'never',dynamicTools:[{type:'function',name:'harness_probe',description:'Test tool',inputSchema:{type:'object',properties:{}}}]});
 if(!t.thread.id)throw new Error('Thread not created');
 console.log('Codex handshake and isolated thread configuration accepted. No inference.');
}finally{rpc.close();}
