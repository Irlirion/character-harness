import {createServer} from 'node:http';
import {z} from 'zod';
import {matchesToken} from '../domain/policy.ts';
import type {BotApi} from './api.ts';
import {fetchMemberProfile} from './member-profile.ts';
import {fetchGroupDirectory} from './group-directory.ts';
const Request=z.object({chat_id:z.string().regex(/^-?\d{1,30}$/),known_user_ids:z.array(z.string().regex(/^\d{1,16}$/)).max(20)}).strict();
/** Internal core-to-worker read endpoint. No host port, cache, database writes or background reads. */
export function groupDirectoryServer(bot:Pick<BotApi,'call'|'downloadProfilePhoto'>,token:string){
 return createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const finish=(status:number,data:unknown)=>{res.writeHead(status);res.end(JSON.stringify(data));};
  if(req.method!=='POST'||!['/group-participants','/member-profile'].includes(req.url??'')){finish(404,{error:'not_found'});return;}
  if(!matchesToken(req.headers.authorization,token)){finish(401,{error:'unauthorized'});return;}
  try{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){finish(413,{error:'request_too_large'});return;}}
   const schema=req.url==='/member-profile'?Request.extend({selector:z.string().trim().min(1).max(128)}):Request;const parsed=schema.safeParse(JSON.parse(body));if(!parsed.success){finish(400,{error:'invalid_request'});return;}
   finish(200,req.url==='/member-profile'?await fetchMemberProfile(bot,parsed.data.chat_id,parsed.data.known_user_ids,(parsed.data as z.infer<typeof Request>&{selector:string}).selector):await fetchGroupDirectory(bot,parsed.data.chat_id,parsed.data.known_user_ids));
  }catch{if(!res.headersSent)finish(502,{error:'group_directory_unavailable'});else res.end();}
 });
}
