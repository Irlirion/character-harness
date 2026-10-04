import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('secrets',{recursive:true,mode:0o700});
try{await access('secrets/bridge_token');console.log('Bridge token already exists; left unchanged.');}
catch(error){
 if(!(error instanceof Error)||!('code'in error)||error.code!=='ENOENT')throw error;
 await writeFile('secrets/bridge_token',randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
 console.log('Bridge token created in secrets/bridge_token; value is not logged.');
}
