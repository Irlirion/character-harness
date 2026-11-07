import {createInterface} from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const mode=process.argv[2]??'normal';
const turn={id:'turn',status:'completed'};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'){
  if(m.params.dynamicTools.length!==1||m.params.dynamicTools[0].name!=='activity_decide')process.exit(2);
  send({id:m.id,result:{thread:{id:'thread'}}});
 }
 if(m.method==='turn/start'){
  send({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
  send({id:m.id,result:{turn}});
  send({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{total:{totalTokens:222}}}});
  if(mode==='quota')send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}}});
  else send({id:100,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',tool:mode==='denied'?'shell':'activity_decide',arguments:{checkpoint:'Plan from fake Codex',decision:{action:'continue'}}}});
 }
 if(m.id===100){
  const ok=mode==='denied'?m.error?.code===-32601:m.result?.success===true;
  if(!ok)process.exit(3);
  send({method:'turn/completed',params:{threadId:'thread',turn:{...turn,status:mode==='denied'?'failed':'completed'}}});
 }
 if(m.method==='turn/interrupt')send({id:m.id,result:{}});
});
