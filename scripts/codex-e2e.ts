import { coreBaseUrl, coreFetch } from '../packages/domain/core-http.ts';
import { randomUUID } from 'node:crypto';
import { secret } from '../packages/domain/secrets.ts';
import { pool } from '../packages/storage/db.ts';

const base=coreBaseUrl(process.env.CORE_URL??'http://127.0.0.1:3000');
const eventId=randomUUID();
const ownerToken=secret('OWNER_TOKEN');
const headers={Authorization:`Bearer ${ownerToken}`,'Content-Type':'application/json'};
async function api(path:string,body?:unknown){
 const response=await coreFetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error(`core_request_${response.status}`);
 return response.json();
}
const inserted=await api('/owner/events',{source_key:`codex-e2e:${eventId}`,author_id:'synthetic-test-player',text:'Север, скажи короткое приветствие для проверки голоса.'});
if(!inserted.inserted||!inserted.event_id)throw new Error('synthetic_event_not_inserted');
const until=Date.now()+120_000;
let reply=false;
let speechState='missing';
try{
 while(Date.now()<until){
  const rows=await api('/owner/replies') as Array<{id:string;reply:string|null}>;
  reply=rows.some(r=>r.id===inserted.event_id&&typeof r.reply==='string'&&r.reply.length>0);
  const jobs=await pool.query('SELECT state FROM speech_jobs WHERE character_id=$1 AND audience_id=$2 AND request_id=$3',[process.env.CHARACTER_ID??'sever',process.env.AUDIENCE_ID??'demo-public',`reply:${inserted.event_id}`]);
  speechState=jobs.rows[0]?.state??'missing';
  if(reply&&['completed','failed','cancelled','unknown'].includes(speechState))break;
  await new Promise(r=>setTimeout(r,1000));
 }
 console.log(JSON.stringify({event_inserted:true,reply_saved:reply,speech_state:speechState}));
 if(!reply||speechState!=='completed')process.exitCode=1;
}finally{await pool.end();}
