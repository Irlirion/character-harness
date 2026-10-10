import { coreBaseUrl, coreFetch } from '../packages/domain/core-http.ts';
import { readFile } from 'node:fs/promises';

const base=coreBaseUrl(process.env.CORE_URL??'http://127.0.0.1:3000');
const bridge=(await readFile(process.env.BRIDGE_TOKEN_FILE??'secrets/bridge_token','utf8')).trim();
const engine=(await readFile(process.env.ENGINE_TOKEN_FILE??'secrets/engine_token','utf8')).trim();
async function call(token:string,path:string,method='GET',body?:unknown){
 return coreFetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
}
const denied=await call(engine,'/bridge/replies');
const allowed=await call(bridge,'/bridge/replies');
const invalid=await call(bridge,'/bridge/events','POST',{source_key:'minecraft:invalid',author_id:'not-a-uuid',author_provenance:'fabric_profile_context',text:'test'});
if(denied.status!==401||allowed.status!==200||invalid.status!==400){
 console.error(JSON.stringify({denied:denied.status,allowed:allowed.status,invalid:invalid.status}));
 throw new Error('bridge_auth_or_validation_failed');
}
console.log(JSON.stringify({bridge_token_isolated:true,bridge_route_available:true,uuid_validation:true}));
