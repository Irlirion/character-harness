import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize')send({id:m.id,result:{protocolVersion:'test'}});
  else if(m.method==='large-image'){send({method:'item/completed',params:{item:{type:'imageGeneration',result:'A'.repeat(2_100_000)}}});send({id:m.id,result:{ok:true}});}
  else if(m.method==='roundtrip'){
    send({id:41,method:'item/tool/call',params:{tool:'memory_search'}});
    lines.once('line',response=>{
      const r=JSON.parse(response);
      if(r.id!==41)process.exit(2);
      send({method:'turn/completed',params:{turn:{status:'completed'}}});
      send({id:m.id,result:{serverAccepted:r.result?.success===true}});
    });
  } else if(m.method==='denied'){
    send({id:42,method:'item/tool/call',params:{tool:'shell'}});
    lines.once('line',response=>{
      const r=JSON.parse(response);
      send({id:m.id,result:{serverDenied:r.error?.code===-32601}});
    });
  }
});
