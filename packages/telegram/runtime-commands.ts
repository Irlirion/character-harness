import {directedDeliveryValid} from '../storage/telegram-directed.ts';
import {initiativeDeliveryValid,configureAutonomy,deskContext} from '../storage/workplace.ts';
import type pg from 'pg';
import {z} from 'zod';
import {DomainError} from '../domain/policy.ts';
import {fingerprint,secretDetected} from '../runtime/policy.ts';
import {assertCurrentProfile} from '../storage/runtime-authorization.ts';
import type {RuntimeStore} from '../storage/runtime.ts';
import type {TelegramMessage} from './domain.ts';

const help='/groups — группы и коды\n/approve_group <код> — одобрить\n/revoke_group <код> — отключить\n'+'Задачи: /task <что спланировать>\n/tasks — список\n/status [ID] — состояние и вопрос\n/result [ID] — результат\n/answer [ID] <ответ> — продолжить\n/cancel [ID] — отменить. Без ID выбирается последняя подходящая задача. Это планирование, без действий в игре.\n/autonomy on | off — самостоятельная работа в группе\n/desk — общий стол и отдельные заметки группы';
export function runtimeCommand(text:string,username:string){
 const match=/^\/(task|tasks|status|result|answer|cancel|help_tasks|autonomy|desk|groups|approve_group|revoke_group)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
 if(!match||match[2]&&match[2].toLowerCase()!==username.toLowerCase())return null;
 return {name:match[1],argument:(match[3]??'').trim()};
}
const uuid=(s:string)=>z.uuid().safeParse(s).success;
export type RuntimeReply={text:string;delivery?:{activity_id:string;activity_version:number;turn_id:string;policy_version:string;profile_hash:string}};

export async function handleRuntimeCommand(db:pg.PoolClient,store:RuntimeStore,b:any,m:TelegramMessage,username:string):Promise<RuntimeReply|null>{
 const cmd=runtimeCommand(m.text,username);if(!cmd)return null;
 // Private numeric Telegram IDs are checked, never usernames, forwarded text or model intent.
 if(!b.runtime_control||b.kind!=='private'||m.kind!=='private'||m.authorId!=='telegram:'+b.chat_id)return {text:''};
 const p={characterId:b.character_id,audienceId:b.audience_id},runtime=store.withTransaction(db);
 try{
  if(['groups','approve_group','revoke_group'].includes(cmd.name)){
   const page=cmd.name==='groups'&&/^\d{1,5}$/.test(cmd.argument)?Math.max(1,Number(cmd.argument)):1;
   const groups=(await db.query(`SELECT d.*,b.id AS binding_id,b.enabled FROM telegram_discovered_chats d
    LEFT JOIN telegram_bindings b ON b.bot_id=d.bot_id AND b.chat_id=d.chat_id
    WHERE d.bot_id=$1 AND d.kind='group' AND ($2::uuid IS NULL OR d.approval_ref=$2) ORDER BY d.observed_at DESC,d.approval_ref LIMIT 9 OFFSET $3`,[b.bot_id,cmd.name==='groups'?null:uuid(cmd.argument)?cmd.argument:'00000000-0000-0000-0000-000000000000',cmd.name==='groups'?(page-1)*8:0])).rows;
   if(cmd.name==='groups')return {text:groups.length?groups.slice(0,8).map(g=>
    (g.title||g.username||'Группа').replace(/[\r\n]/g,' ').slice(0,120)+' · '+(g.enabled?'одобрена':'не одобрена')+' · '+g.membership_status+'\n'+g.approval_ref).join('\n\n')+(groups.length>8?'\nЕщё: /groups '+(page+1):''):'Пока нет обнаруженных групп. Добавь бота в группу, затем открой /groups.'};
   const g=groups.find(g=>g.approval_ref===cmd.argument);
   if(!g)return {text:'Укажи точный код группы из /groups.'};
   const enabled=cmd.name==='approve_group';
   if(enabled&&!['member','administrator','creator'].includes(g.membership_status))return {text:'Сначала добавь бота в эту группу заново. Нужен подтверждённый Telegram вход; затем /groups.'};
   if(g.enabled===enabled)return {text:enabled?'Группа уже одобрена.':'Группа уже отключена.'};
   const target=(await db.query(`INSERT INTO telegram_bindings(id,bot_id,character_id,chat_id,audience_id,kind,enabled)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,'group',$5) ON CONFLICT(bot_id,chat_id) DO UPDATE SET enabled=$5,revision=telegram_bindings.revision+1 RETURNING id`,
    [b.bot_id,b.character_id,g.chat_id,`telegram:${b.bot_id}:${g.chat_id}`,enabled])).rows[0];
   await db.query("UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND state IN ('pending','retry_wait')",[target.id]);
   await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1',[target.id]);
   await db.query('UPDATE social_events SET processed=true WHERE NOT processed AND id IN (SELECT event_id FROM telegram_decisions WHERE binding_id=$1)',[target.id]);
   // Fence old work. The command is handled before creating its own reply event.
   await db.query('UPDATE runtime_autonomy SET enabled=false,revision=revision+1,updated_at=now() WHERE binding_id=$1',[target.id]);
   await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND event_id=(SELECT active_event_id FROM characters WHERE id=$1)',[b.character_id]);
   await db.query('UPDATE characters SET epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id=$1',[b.character_id]);
   return {text:enabled?'Группа одобрена. Можно поручать сообщения и обращаться к боту в группе. Самостоятельные первые сообщения выключены.':'Группа отключена. Ожидающие сообщения отменены.'};
  }
  if(cmd.name==='autonomy'||cmd.name==='desk'){
   const parts=cmd.argument.split(/\s+/).filter(Boolean);
   const action=cmd.name==='autonomy'&&['on','off'].includes(parts[0])?parts.shift():undefined;
   const selector=parts.join(' ');
   const groups=(await db.query("SELECT b.*,a.enabled AS autonomous,a.next_wake_at,d.approval_ref FROM telegram_bindings b LEFT JOIN runtime_autonomy a ON a.binding_id=b.id LEFT JOIN telegram_discovered_chats d ON d.bot_id=b.bot_id AND d.chat_id=b.chat_id WHERE b.character_id=$1 AND b.kind='group' AND b.enabled",[b.character_id])).rows;
   const group=selector?groups.find(g=>g.approval_ref===selector):groups.length===1?groups[0]:undefined;
   if((selector&&!group)||(!group&&groups.length>1&&cmd.name==='autonomy'))return {text:'Выбери код из /groups: /autonomy on <код>, /autonomy off <код> или /desk <код>.'};
   if(!group&&cmd.name==='autonomy')return {text:'Нет подключённой группы.'};
   if(cmd.name==='autonomy'){
    if(cmd.argument&&!action&&!selector)return {text:'/autonomy on | off — управление; /autonomy — состояние; /desk — рабочий стол группы'};
    if(action){await configureAutonomy(db,b.character_id,group.id,action==='on');group.autonomous=action==='on';}
    return {text:'Автономность группы: '+(group.autonomous?'включена':'выключена')+'\nПробуждения раз в 2 часа; 09–21 по Германии; до 2 первых сообщений за сутки. Молчание — допустимое решение. /desk'};
   }
   const ctx=await deskContext(db,{characterId:b.character_id,audienceId:group?.audience_id??b.audience_id});
   const text='Общий рабочий стол · версия '+ctx.shared_desk.revision+'\nПлан: '+(ctx.shared_desk.plan||'пока пуст').slice(0,600)+'\nЗаметки: '+(ctx.shared_desk.notes||'пока пуст').slice(0,800)+'\nОтдельные заметки '+(group?'группы':'этой лички')+' · версия '+ctx.desk.revision+'\n'+(ctx.desk.plan||ctx.desk.notes||'пока пуст').slice(0,350);
   return {text:secretDetected(text)?'Выдача заметок заблокирована.':text.slice(0,2000)};
  }
  if(cmd.name==='help_tasks')return {text:help};
  if(cmd.name==='task'){
   if(!cmd.argument)return {text:help};
   const a=await runtime.assign(p,{invocation_id:'telegram-task:'+b.id+':'+m.messageId,objective:cmd.argument,max_turns:5});
   return {text:'Задача создана: '+a.id+'\nПланирование начнётся при наличии допуска и бюджета. Проверить: /status'};
  }
  const rows=await runtime.list(p,20,0);
  if(cmd.name==='tasks')return {text:rows.length?rows.slice(0,10).map(a=>a.id+' — '+label(a.status)+(a.blocked_reason?' (проверка/лимит)':'')).join('\n'): 'Задач пока нет. /task <что спланировать>'};
  let id:string|undefined,answer=cmd.argument;
  if(cmd.name==='answer'){
   const first=cmd.argument.split(/\s+/,1)[0];if(uuid(first)){id=first;answer=cmd.argument.slice(first.length).trim();}
   if(!answer)return {text:'Используй /answer [ID] <ответ на вопрос>'};
   id??=rows.find(a=>a.status==='needs_input')?.id;
  }else{
   if(cmd.argument&&!uuid(cmd.argument))return {text:help};
   id=cmd.argument||rows.find(a=>cmd.name!=='cancel'||!['completed','cancelled','failed'].includes(a.status))?.id;
  }
  if(!id)return {text:'Подходящей задачи нет. /tasks'};
  const {activity:a,checkpoint}=await runtime.inspect(p,id);
  if(cmd.name==='cancel'){await runtime.cancel(p,id,a.version);return {text:'Задача отменена: '+id};}
  if(cmd.name==='answer'){await runtime.provideInput(p,id,{expected_version:a.version,text:answer});return {text:'Ответ принят. Задача продолжит планирование. /status'};}
  const blocked=rows.find(row=>row.id===id)?.blocked_reason;
  const prefix='Задача '+id+'\n'+label(a.status)+'; ходы '+a.turns_used+'/'+a.max_turns+(blocked?'\nЗапуск заблокирован: '+blocked:'');
  const content=cmd.name==='result'?(a.summary||checkpoint?.state):(a.status==='needs_input'?a.question:null);
  if(!content)return {text:prefix+(cmd.name==='result'?'\nПроверенного результата пока нет.':'')};
  // Only already-reviewed durable content may leave the private activity scope.
  const g=checkpoint?(await db.query(`SELECT g.* FROM runtime_model_grants g JOIN runtime_checkpoints c ON c.turn_id=g.turn_id
   WHERE c.id=$1 AND g.activity_id=$2 AND g.character_id=$3 AND g.audience_id=$4 AND g.state='finished'`,[checkpoint.id,id,p.characterId,p.audienceId])).rows[0]:null;
  if(!g||secretDetected(content))return {text:prefix+'\nВыдача результата заблокирована проверкой.'};
  await assertCurrentProfile(db,p,g.policy_version,g.profile_hash);
  return {text:(prefix+'\n'+content).slice(0,2000),delivery:{activity_id:id,activity_version:a.version,turn_id:g.turn_id,policy_version:g.policy_version,profile_hash:g.profile_hash}};
 }catch(e){
  if(e instanceof DomainError)return {text:({'activity_not_found':'Задача не найдена в этом чате.','activity_not_waiting_input':'Задача сейчас не ждёт ответа.','paused':'Агент приостановлен владельцем.','runtime_policy_stale':'Политика изменилась или истекла. Результат пока недоступен.','activity_queue_full':'Очередь задач заполнена.'} as Record<string,string>)[e.code]??'Команда сейчас недоступна. Проверь /status или /tasks'};
  throw e;
 }
}
function label(s:string){return ({ready:'в очереди',running:'планирует',waiting_time:'ожидает времени',needs_input:'нужен твой ответ',completed:'завершена',failed:'остановлена',cancelled:'отменена'} as Record<string,string>)[s]??s;}

export async function runtimeDeliveryValid(db:pg.PoolClient,job:any){
 if(job.directed_source_event)return directedDeliveryValid(db,job);
 if(!job.runtime_activity_id)return true;
 if(job.autonomy_revision&&!await initiativeDeliveryValid(db,job))return false;
 if(secretDetected(job.text)||fingerprint(job.text)!==job.runtime_text_hash)return false;
 const r=(await db.query(`SELECT 1 FROM runtime_activities a JOIN runtime_checkpoints c ON c.id=a.checkpoint_id
  JOIN runtime_model_grants g ON g.turn_id=c.turn_id AND g.activity_id=a.id
  JOIN runtime_policy_current pc ON pc.character_id=a.character_id AND pc.version=g.policy_version
  JOIN runtime_policy_profiles pp ON pp.character_id=pc.character_id AND pp.version=pc.version
  JOIN telegram_bindings b ON b.id=$1 AND b.character_id=a.character_id AND b.audience_id=a.audience_id
  WHERE a.id=$2 AND a.version=$3 AND c.turn_id=$4 AND g.policy_version=$5 AND g.profile_hash=$6 AND pp.profile_hash=$6
   AND g.state='finished' AND ((b.kind='private' AND b.runtime_control AND $8::integer IS NULL) OR (b.kind='group' AND $8::integer IS NOT NULL AND a.origin='self')) AND b.enabled AND b.revision=$7
   AND (pp.bundle->>'enabled')::boolean AND (pp.bundle->>'provider_eligible')::boolean
   AND (pp.bundle->>'reviewed_at')::timestamptz<=clock_timestamp() AND (pp.bundle->>'expires_at')::timestamptz>clock_timestamp()`,
  [job.binding_id,job.runtime_activity_id,job.runtime_activity_version,job.runtime_turn_id,job.runtime_policy_version,job.runtime_profile_hash,job.revision,job.autonomy_revision??null])).rowCount;
 return !!r;
}
