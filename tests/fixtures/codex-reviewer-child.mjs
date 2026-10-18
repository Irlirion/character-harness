import {createInterface} from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let thread;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='model/list')send({id:m.id,result:{data:['model','deny','needs_review','tool','native','invalid','fail','foreign','oversize','missing','duplicate','hang'].map(model=>({model}))}});
 if(m.method==='thread/start'){
  if(p.dynamicTools.length||p.config.default_permissions!=='runtime-review'||p.config['permissions.runtime-review.filesystem'][':root']!=='deny'||p.config['permissions.runtime-review.network.enabled']!==false||p.approvalPolicy!=='never'||p.environments.length||p.runtimeWorkspaceRoots.length)process.exit(2);
  thread=p;send({id:m.id,result:{thread:{id:'review-thread'},activePermissionProfile:{id:p.model==='wrongprofile'?'other':'runtime-review',extends:null},sandbox:{type:'readOnly',networkAccess:false},instructionSources:p.model==='instructions'?['unexpected']:[]}});
 }
 if(m.method==='experimentalFeature/list')send({id:m.id,result:{data:[{name:'unified_exec',enabled:true},...Object.keys(thread.config).filter(key=>key.startsWith('features.')).map(key=>({name:key.slice(9),enabled:thread.model==='unsafe'&&key==='features.shell_tool'}))],nextCursor:null}});
 if(m.method==='turn/start'){if(['unsafe','wrongprofile','instructions'].includes(thread.model))process.exit(9);
  if(!p.outputSchema||p.sandboxPolicy!==undefined||p.approvalPolicy!=='never')process.exit(3);
  const mode=p.model;
  send({id:m.id,result:{turn:{id:'review-turn'}}});
  send({method:'turn/started',params:{threadId:'review-thread',turn:{id:'review-turn'}}});
  if(mode==='hang')return;
  const params={threadId:'review-thread',turnId:'review-turn'};
  if(mode==='tool')send({id:999,method:'item/tool/call',params:{...params,tool:'shell'}});
  else{
   if(mode==='native')send({method:'item/started',params:{...params,item:{type:'commandExecution'}}});
   if(mode!=='missing'){
    const text=mode==='invalid'?'no json':mode==='oversize'?'x'.repeat(5000):JSON.stringify({verdict:['deny','needs_review'].includes(mode)?mode:'allow',rule_id:'synthetic_test_only'});
    const notification={method:'item/completed',params:{...params,threadId:mode==='foreign'?'foreign':'review-thread',item:{type:'agentMessage',text}}};
    send(notification);if(mode==='duplicate')send(notification);
   }
   send({method:'turn/completed',params:{threadId:'review-thread',turn:{id:'review-turn',status:mode==='fail'?'failed':'completed'}}});
  }
 }
 if(m.id===999){if(!m.error)process.exit(4);send({method:'turn/completed',params:{threadId:'review-thread',turn:{id:'review-turn',status:'completed'}}});}
 if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
