import {directedDeliveryValid} from '../storage/telegram-directed.ts';
import {initiativeDeliveryValid,configureAutonomy,deskContext} from '../storage/workplace.ts';
import type pg from 'pg';
import {z} from 'zod';
import {DomainError} from '../domain/policy.ts';
import {fingerprint,secretDetected} from '../runtime/policy.ts';
import {assertCurrentProfile} from '../storage/runtime-authorization.ts';
import type {RuntimeStore} from '../storage/runtime.ts';
import type {TelegramMessage} from './domain.ts';

const help='Задачи: /task <что спланировать>\n/tasks — список\n/status [ID] — состояние и вопрос\n/result [ID] — результат\n/answer [ID] <ответ> — продолжить\n/cancel [ID] — отменить. Без ID выбирается последняя подходящая задача. Это планирование, без действий в игре.\n/autonomy on | off — самостоятельная работа в группе\n/desk — общий стол и отдельные заметки группы';
export function runtimeCommand(text:string,username:string){
 const match=/^\/(task|tasks|status|result|answer|cancel|help_tasks|autonomy|desk)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
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
  if(cmd.name==='autonomy'||cmd.name==='desk'){
   const group=(await db.query("SELECT b.*,a.enabled AS autonomous,a.next_wake_at FROM telegram_bindings b LEFT JOIN runtime_autonomy a ON a.binding_id=b.id WHERE b.character_id=$1 AND b.kind='group' AND b.enabled",[b.character_id])).rows[0];
   if(!group&&cmd.name==='autonomy')return {text:'Нет подключённой группы.'};
   if(cmd.name==='autonomy'){
    if(cmd.argument&&!['on','off'].includes(cmd.argument))return {text:'/autonomy on | off — управление; /autonomy — состояние; /desk — рабочий стол группы'};
    if(cmd.argument){await configureAutonomy(db,b.character_id,group.id,cmd.argument==='on');group.autonomous=cmd.argument==='on';}
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
