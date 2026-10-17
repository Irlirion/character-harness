import { coreBaseUrl,coreFetch } from '../packages/domain/core-http.ts';
import { readFile } from 'node:fs/promises';
const [command,...args]=process.argv.slice(2);
const base=coreBaseUrl(process.env.CORE_URL??'http://127.0.0.1:3000');
const token=(await readFile(process.env.OWNER_TOKEN_FILE??'secrets/owner_token','utf8')).trim();
let path='/owner/telegram';let body:unknown;
if(command==='bind' && args.length>=3 && ['private','group'].includes(args[2])) {
 body={bot_id:args[0],chat_id:args[1],kind:args[2],enabled:args[3]!=='disabled'};path+='/bindings';
} else if(command==='resolve' && args.length>=2 && ['sent','retry','cancelled'].includes(args[1])) {
 path+=`/deliveries/${encodeURIComponent(args[0])}/resolve`;body={action:args[1],...(args[2]?{message_id:args[2]}:{})};
} else if(command!=='status') {
 throw new Error('Usage: telegram.ts status | bind BOT_ID CHAT_ID private|group [disabled] | resolve DELIVERY_ID sent|retry|cancelled [MESSAGE_ID]');
}
const r=await coreFetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
if(!r.ok)throw new Error(`telegram_control_http_${r.status}`);
console.log(JSON.stringify(await r.json(),null,2));
