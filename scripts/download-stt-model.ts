import {createHash} from 'node:crypto';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const revision='322c3b29492673eb7d0b434bfa9dfb8653e34d02';
const files=[
  {name:'config.json',sha256:'0641fcf73f4af791c73f05083e38a658ff5dcbee3534a0c61396c10f4b97f0fe',maxBytes:64_000},
  {name:'v3_ctc.int8.onnx',sha256:'ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd',maxBytes:250_000_000},
  {name:'v3_vocab.txt',sha256:'a9143c30844d3c0bee3e9e927e4084774eb1b9eeaafc473b2c4521e4911a7c07',maxBytes:64_000},
  {name:'LICENSE.txt',sha256:'f00de6715714c7a63d08639cdbfaa40224eefc407302614bd19f1a8b98c875aa',maxBytes:32_000}
];
const directory=resolve(import.meta.dirname,'../work/stt-models');
await mkdir(directory,{recursive:true});
for(const file of files){
  const target=join(directory,file.name),temp=target+'.verified-new';
  const handle=await open(temp,'w',0o600);const hash=createHash('sha256');let size=0;
  try{
    const response=await fetch(`https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/${revision}/${file.name}`,{signal:AbortSignal.timeout(180_000)});
    if(!response.ok||!response.body)throw new Error(`model_download_failed:${file.name}:${response.status}`);
    const reader=response.body.getReader();
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>file.maxBytes)throw new Error(`model_file_too_large:${file.name}`);hash.update(value);await handle.write(value);}}
    finally{reader.releaseLock();}
    if(hash.digest('hex')!==file.sha256)throw new Error(`model_sha256_mismatch:${file.name}`);
    await handle.sync();await handle.close();await rename(temp,target);
  }catch(error){await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});throw error;}
}
console.log(`Verified pinned GigaAM v3 model files in ${directory}`);
