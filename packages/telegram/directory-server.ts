import {createServer} from 'node:http';
import {z} from 'zod';
import {matchesToken} from '../domain/policy.ts';
import type {BotApi} from './api.ts';
import {fetchGroupDirectory} from './group-directory.ts';
const Request=z.object({chat_id:z.string().regex(/^-?\d{1,30}$/),known_user_ids:z.array(z.string().regex(/^\d{1,16}$/)).max(20)}).strict();
/** Internal core-to-worker read endpoint. No host port, cache, database writes or background reads. */
export function groupDirectoryServer(bot:Pick<BotApi,'call'>,token:string){
 return createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const finish=(status:number,data:unknown)=>{res.writeHead(status);res.end(JSON.stringify(data));};
  if(req.method!=='POST'||req.url!=='/group-participants'){finish(404,{error:'not_found'});return;}
  if(!matchesToken(req.headers.authorization,token)){finish(401,{error:'unauthorized'});return;}
  try{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){finish(413,{error:'request_too_large'});return;}}
   const parsed=Request.safeParse(JSON.parse(body));if(!parsed.success){finish(400,{error:'invalid_request'});return;}
   finish(200,await fetchGroupDirectory(bot,parsed.data.chat_id,parsed.data.known_user_ids));
  }catch{if(!res.headersSent)finish(502,{error:'group_directory_unavailable'});else res.end();}
 });
}
