import {z} from 'zod';
import {BotApiError,type BotApi} from './api.ts';
const Code=z.enum(['unauthorized','forbidden','rate_limited','rejected','unknown']);
const Label=z.object({display_name:z.string().min(1).max(128),username:z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable()}).strict();
export const MemberProfileSchema=z.object({status:z.enum(['found','not_found','ambiguous','membership_unavailable']),candidates:z.array(Label).max(20),
 display_name:z.string().max(128).optional(),username:z.string().nullable().optional(),group_status:z.string().optional(),bio:z.string().max(1024).nullable().optional(),bio_error:Code.nullable().optional(),
 photo_count:z.number().int().nonnegative().nullable().optional(),photo:z.object({mime:z.enum(['image/jpeg','image/png']),data:z.string().max(350000)}).strict().nullable().optional(),photo_error:Code.nullable().optional()}).strict();
export type MemberProfile=z.infer<typeof MemberProfileSchema>;
export type ProfileReader=(chatId:string,knownIds:string[],selector:string)=>Promise<MemberProfile>;
const present=(m:any)=>['creator','administrator','member'].includes(m?.status)||m?.status==='restricted'&&m.is_member===true;
const label=(m:any)=>({display_name:[m.user.first_name,m.user.last_name].filter(v=>typeof v==='string').join(' ').trim().slice(0,128)||'Участник',username:typeof m.user.username==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(m.user.username)?m.user.username:null});
const error=(e:unknown)=>e instanceof BotApiError?e.code:'unknown';
/** Only a named, confirmed participant already observed in this group or its admins. No global lookup. */
export async function fetchMemberProfile(bot:Pick<BotApi,'call'|'downloadProfilePhoto'>,chatId:string,knownIds:string[],selector:string):Promise<MemberProfile>{
 const signal=AbortSignal.timeout(20000),query=selector.trim().replace(/^@/,'').toLocaleLowerCase('ru');
 const ids=[...new Set(knownIds.filter(s=>/^\d{1,16}$/.test(s)&&Number.isSafeInteger(Number(s))))].slice(0,20);
 const replies=await Promise.allSettled([bot.call('getChatAdministrators',{chat_id:chatId},signal),...ids.map(id=>bot.call('getChatMember',{chat_id:chatId,user_id:Number(id)},signal))]);
 const all=[...(replies[0].status==='fulfilled'&&Array.isArray(replies[0].value)?replies[0].value:[]),...replies.slice(1).flatMap(r=>r.status==='fulfilled'?[r.value]:[])];
 const people=[...new Map(all.filter(m=>present(m)&&Number.isSafeInteger(m.user?.id)&&m.user.id>0&&typeof m.user.first_name==='string').map(m=>[m.user.id,m])).values()];
 const exact=people.filter(m=>[label(m).display_name,label(m).username].some(s=>s?.toLocaleLowerCase('ru')===query));
 const matches=exact.length?exact:people.filter(m=>m.user.first_name.toLocaleLowerCase('ru')===query);
 if(matches.length!==1)return {status:matches.length?'ambiguous':people.length?'not_found':'membership_unavailable',candidates:matches.slice(0,20).map(label)};
 const userId=matches[0].user.id;
 // Verify current membership before requesting private-profile fields; never accept a guessed numeric ID.
 let membership;try{membership=await bot.call('getChatMember',{chat_id:chatId,user_id:userId},signal);}catch{return {status:'membership_unavailable',candidates:[]};}
 if(!present(membership)||membership.user?.id!==userId)return {status:'not_found',candidates:[]};
 const [chat,photos]=await Promise.allSettled([bot.call('getChat',{chat_id:userId},signal),bot.call('getUserProfilePhotos',{user_id:userId,offset:0,limit:1},signal)]);
 let photo:MemberProfile['photo']=null,photoError:MemberProfile['photo_error']=photos.status==='rejected'?error(photos.reason):null;
 const sizes=photos.status==='fulfilled'&&Array.isArray(photos.value?.photos?.[0])?photos.value.photos[0]:[];
 const chosen=sizes.filter((s:any)=>typeof s.file_id==='string'&&s.width<=1024&&s.height<=1024&&(!s.file_size||s.file_size<=256*1024)).sort((a:any,b:any)=>b.width*b.height-a.width*a.height)[0];
 if(chosen){try{photo=await bot.downloadProfilePhoto(chosen.file_id,signal);}catch(e){photoError=error(e);}}
 else if(sizes.length)photoError='rejected';
 const validChat=chat.status==='fulfilled'&&chat.value?.id===userId&&chat.value?.type==='private';
 return MemberProfileSchema.parse({status:'found',candidates:[],...label(membership),group_status:membership.status,
 bio:validChat&&typeof chat.value.bio==='string'?chat.value.bio.slice(0,1024):null,bio_error:chat.status==='rejected'?error(chat.reason):validChat?null:'rejected',
 photo_count:photos.status==='fulfilled'&&Number.isSafeInteger(photos.value?.total_count)&&photos.value.total_count>=0?photos.value.total_count:null,photo,photo_error:photoError});
}
