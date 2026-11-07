import {z} from 'zod';
import type {BotApi} from './api.ts';
import {BotApiError} from './api.ts';
const Person=z.object({display_name:z.string().min(1).max(128),username:z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),status:z.enum(['creator','administrator','member','restricted'])}).strict();
const Code=z.enum(['unauthorized','forbidden','rate_limited','rejected','unknown']);
export const GroupDirectorySchema=z.object({member_count:z.number().int().min(0).max(1000000000).nullable(),administrators:z.array(Person).max(50),known_members:z.array(Person).max(20),count_error:Code.nullable(),administrators_error:Code.nullable(),member_lookup_errors:z.number().int().min(0).max(20)}).strict();
export type GroupDirectory=z.infer<typeof GroupDirectorySchema>;
export type GroupReader=(chatId:string,knownIds:string[])=>Promise<GroupDirectory>;
function person(raw:any){
 const u=raw?.user;if(!u||typeof u.first_name!=='string'||!['creator','administrator','member','restricted'].includes(raw.status)||raw.status==='restricted'&&raw.is_member!==true)return null;
 const p=Person.safeParse({display_name:[u.first_name,u.last_name].filter(v=>typeof v==='string'&&v.trim()).join(' ').slice(0,128)||'Участник',username:typeof u.username==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(u.username)?u.username:null,status:raw.status});return p.success?p.data:null;
}
/** On-demand read only. Results are returned in memory, never stored or indexed. */
export async function fetchGroupDirectory(bot:Pick<BotApi,'call'>,chatId:string,knownIds:string[]):Promise<GroupDirectory>{
 const ids=[...new Set(knownIds.filter(s=>/^\d{1,16}$/.test(s)&&Number.isSafeInteger(Number(s))))].slice(0,20);
 const [count,admins,...lookups]=await Promise.allSettled([bot.call('getChatMemberCount',{chat_id:chatId}),bot.call('getChatAdministrators',{chat_id:chatId}),...ids.map(id=>bot.call('getChatMember',{chat_id:chatId,user_id:Number(id)}))]);
 const error=(r:PromiseSettledResult<any>)=>r.status==='rejected'?(r.reason instanceof BotApiError?r.reason.code:'unknown'):null;
 const list=(rows:any[])=>rows.map(person).filter((p):p is NonNullable<typeof p>=>!!p);
 return GroupDirectorySchema.parse({member_count:count.status==='fulfilled'&&Number.isSafeInteger(count.value)&&count.value>=0?count.value:null,administrators:admins.status==='fulfilled'&&Array.isArray(admins.value)?list(admins.value.slice(0,50)):[],known_members:list(lookups.filter(r=>r.status==='fulfilled').map(r=>r.value)),count_error:error(count),administrators_error:error(admins),member_lookup_errors:lookups.filter(r=>r.status==='rejected').length});
}
