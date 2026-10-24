import {approvedGroups,selectGroup} from './telegram-groups.ts';
import {MemberProfileSchema,type ProfileReader} from '../telegram/member-profile.ts';
import {GroupDirectorySchema,type GroupReader} from '../telegram/group-directory.ts';
import {DirectedTelegram,type DirectedReviewer} from './telegram-directed.ts';
import {configureAutonomy} from './workplace.ts';
import {handleRuntimeCommand,runtimeCommand,runtimeDeliveryValid} from '../telegram/runtime-commands.ts';
import type {RuntimeStore} from './runtime.ts';
import {fingerprint} from '../runtime/policy.ts';
import { loadStagedSocialMemory, applySocialMemoryDelta } from './social-memory.ts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError, assertActive } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import { normalizeUpdate } from '../telegram/domain.ts';

type DB = pg.PoolClient;
export class TelegramStore {
  private pool:pg.Pool;
  readonly characterId:string;
  private runtime?:RuntimeStore;
  constructor(pool:pg.Pool, characterId:string,runtime?:RuntimeStore,review?:DirectedReviewer,groupReader?:GroupReader,profileReader?:ProfileReader) {this.profileReader=profileReader;this.groupReader=groupReader;this.pool=pool;this.characterId=characterId;this.runtime=runtime;this.directed=new DirectedTelegram(pool,characterId,review);}
  private directed:DirectedTelegram;
  private groupReader?:GroupReader;
  private profileReader?:ProfileReader;
  async canSendGroup(p:Principal,eventId:string,epoch:number){return this.directed.available(p,eventId,epoch);}
  async sendGroup(p:Principal,eventId:string,epoch:number,text:string,group?:string){return this.directed.send(p,eventId,epoch,text,group);}
  async approvedGroups(p:Principal,eventId:string,epoch:number){return this.directed.groups(p,eventId,epoch);}
  async groupDelivery(p:Principal,eventId:string,epoch:number,id:string){return this.directed.status(p,eventId,epoch,id);}
  private async tx<T>(fn:(db:DB, character:any)=>Promise<T>):Promise<T> {
    const db=await this.pool.connect();
    try {
      await db.query('BEGIN');
      const c=(await db.query('SELECT * FROM characters WHERE id=$1 FOR UPDATE',[this.characterId])).rows[0];
      if (!c) throw new DomainError('character_not_found');
      const result=await fn(db,c); await db.query('COMMIT'); return result;
    } catch(e) { await db.query('ROLLBACK'); throw e; } finally {db.release();}
  }
  private async directoryContext(p:Principal,eventId:string,epoch:number,group?:string){
    return this.tx(async(db,c)=>{
      assertActive(c,epoch);if(c.active_event_id!==eventId||!c.lease_until||new Date(c.lease_until)<=new Date())throw new DomainError('turn_not_current');
      const source=(await db.query(`SELECT b.*,e.author_id FROM social_events e JOIN telegram_decisions d ON d.event_id=e.id JOIN telegram_bindings b ON b.id=d.binding_id
        WHERE e.id=$1 AND e.character_id=$2 AND e.audience_id=$3 AND NOT e.processed AND b.enabled`,[eventId,this.characterId,p.audienceId])).rows[0];
      if(p.characterId!==this.characterId||!source)throw new DomainError('directory_scope_denied');
      let b=source;
      if(source.kind==='private'){
        if(!source.runtime_control||source.author_id!=='telegram:'+source.chat_id)throw new DomainError('directory_owner_required');
        b=selectGroup(await approvedGroups(db,this.characterId),group);
      }
      if(source.kind==='group'&&group&&group!==source.id)throw new DomainError('directory_scope_denied');
      if(!b||b.kind!=='group')throw new DomainError('group_binding_required');
      const ids=(await db.query(`SELECT substring(author_id from 10) AS id FROM telegram_messages
        WHERE binding_id=$1 AND incoming AND author_id ~ '^telegram:[0-9]+$' AND observed_at>now()-interval '30 days'
        GROUP BY author_id ORDER BY max(observed_at) DESC LIMIT 20`,[b.id])).rows.map(r=>r.id);
      return {source_id:source.id,source_revision:source.revision,target_id:b.id,target_revision:b.revision,chat_id:b.chat_id,known_ids:ids};
    });
  }
  async canReadGroup(p:Principal,eventId:string,epoch:number){
    if(!this.groupReader)return false;try{await this.directoryContext(p,eventId,epoch);return true;}catch(e){if(e instanceof DomainError)return e.code==='group_selection_required';throw e;}
  }
  async groupParticipants(p:Principal,eventId:string,epoch:number,group?:string){
    const before=await this.directoryContext(p,eventId,epoch,group);if(!this.groupReader)throw new DomainError('group_directory_unavailable');
    let data;try{data=GroupDirectorySchema.parse(await this.groupReader(before.chat_id,before.known_ids));}catch{throw new DomainError('group_directory_unavailable');}
    const after=await this.directoryContext(p,eventId,epoch,group);
    if(before.source_id!==after.source_id||before.source_revision!==after.source_revision||before.target_id!==after.target_id||before.target_revision!==after.target_revision)throw new DomainError('directory_authority_stale');
    return {...data,source:'telegram_bot_api',target:before.source_id===before.target_id?'current_group':'configured_group',observed_at:new Date().toISOString(),complete:false,
      limitation:'Bot API has no complete member-list method. Administrators and checked known message authors are partial evidence, not all members. Display names are unverified identities.'};
  }
  async memberProfile(p:Principal,eventId:string,epoch:number,selector:string,group?:string){
    if(!this.profileReader||!selector.trim()||selector.length>128)throw new DomainError('member_profile_unavailable');
    const before=await this.directoryContext(p,eventId,epoch,group);let data;
    try{data=MemberProfileSchema.parse(await this.profileReader(before.chat_id,before.known_ids,selector));}catch{throw new DomainError('member_profile_unavailable');}
    const after=await this.directoryContext(p,eventId,epoch,group);
    if(before.source_id!==after.source_id||before.source_revision!==after.source_revision||before.target_id!==after.target_id||before.target_revision!==after.target_revision)throw new DomainError('directory_authority_stale');
    return {...data,observed_at:new Date().toISOString(),source:'telegram_bot_api'};
  }
  async register(botId:string, username:string) {
    return this.tx(async db=>{
      const old=(await db.query('SELECT bot_id FROM telegram_accounts WHERE character_id=$1',[this.characterId])).rows[0];
      if (old && old.bot_id!==botId) throw new DomainError('bot_identity_changed');
      await db.query(`INSERT INTO telegram_accounts(bot_id,character_id,username) VALUES($1,$2,$3)
        ON CONFLICT(bot_id) DO UPDATE SET username=excluded.username WHERE telegram_accounts.character_id=excluded.character_id`,[botId,this.characterId,username]);
      return {registered:true};
    });
  }
  async polling(botId:string, owner:string) {
    return this.tx(async db=>{
      const r=await db.query(`UPDATE telegram_accounts SET poll_owner=$3,poll_until=now()+interval '60 seconds',
        observation_gap=observation_gap OR COALESCE(last_poll_at<now()-interval '24 hours',false)
        WHERE bot_id=$1 AND character_id=$2 AND (poll_owner=$3 OR poll_until IS NULL OR poll_until<now())
        RETURNING next_offset::text`,[botId,this.characterId,owner]);
      if (!r.rowCount) throw new DomainError('poller_busy');
      return {offset:r.rows[0].next_offset};
    });
  }
  async accountState(botId:string,state:string,owner:string) {
    await this.pool.query('UPDATE telegram_accounts SET status=$3 WHERE bot_id=$1 AND character_id=$2 AND poll_owner=$4 AND poll_until>now()',[botId,this.characterId,state,owner]);
    return {saved:true};
  }
  async bind(botId:string,chatId:string,kind:'private'|'group',enabled:boolean) {
    return this.tx(async db=>{
      const account=await db.query('SELECT 1 FROM telegram_accounts WHERE bot_id=$1 AND character_id=$2',[botId,this.characterId]);
      if (!account.rowCount) throw new DomainError('bot_not_registered');
      const current=(await db.query('SELECT * FROM telegram_bindings WHERE bot_id=$1 AND chat_id=$2',[botId,chatId])).rows[0];
      if (current && current.kind!==kind) throw new DomainError('binding_kind_conflict');
      if (current && current.enabled===enabled) return current;
      const counts=(await db.query('SELECT count(*)::int AS n FROM telegram_bindings WHERE character_id=$1 AND kind=$2 AND enabled AND id<>$3',[this.characterId,kind,current?.id??randomUUID()])).rows[0];
      if (enabled && kind==='private' && counts.n>=1) throw new DomainError('mvp_binding_limit');
      const binding=(await db.query(`INSERT INTO telegram_bindings(id,bot_id,character_id,chat_id,audience_id,kind,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bot_id,chat_id) DO UPDATE SET enabled=$7,revision=telegram_bindings.revision+1 RETURNING *`,
        [randomUUID(),botId,this.characterId,chatId,`telegram:${botId}:${chatId}`,kind,enabled])).rows[0];
      await db.query(`UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND state IN ('pending','retry_wait')`,[binding.id]);
      await db.query(`UPDATE social_events SET processed=true WHERE id IN (SELECT event_id FROM telegram_decisions WHERE binding_id=$1) AND NOT processed`,[binding.id]);
      await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1',[binding.id]);
      // Reconfiguration fences an in-flight turn, including disable followed by re-enable.
      await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND event_id=(SELECT active_event_id FROM characters WHERE id=$1)',[this.characterId]);
      await db.query('UPDATE characters SET epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id=$1',[this.characterId]);
      return binding;
    });
  }
  async autonomy(bindingId:string,enabled:boolean){return this.tx(db=>configureAutonomy(db,this.characterId,bindingId,enabled));}
  async runtimeControl(bindingId:string,enabled:boolean){
    return this.tx(async db=>{
      const b=(await db.query("SELECT * FROM telegram_bindings WHERE id=$1 AND character_id=$2 AND kind='private' FOR UPDATE",[bindingId,this.characterId])).rows[0];
      if(!b)throw new DomainError('private_binding_required');
      if(b.runtime_control===enabled)return {enabled};
      await db.query('UPDATE telegram_bindings SET runtime_control=$2,revision=revision+1 WHERE id=$1',[bindingId,enabled]);
      await db.query("UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND state IN ('pending','retry_wait')",[bindingId]);
      await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND event_id=(SELECT active_event_id FROM characters WHERE id=$1)',[this.characterId]);
      await db.query('UPDATE characters SET epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id=$1',[this.characterId]);
      return {enabled};
    });
  }
  async ingest(botId:string,owner:string,updates:any[]) {
    return this.tx(async(db,c)=>{
      const a=(await db.query(`SELECT * FROM telegram_accounts WHERE bot_id=$1 AND character_id=$2 AND poll_owner=$3 AND poll_until>now()`,[botId,this.characterId,owner])).rows[0];
      if (!a) throw new DomainError('poller_lease_expired');
      let offset=BigInt(a.next_offset);
      if(updates.some((u,i)=>!Number.isSafeInteger(u?.update_id) || u.update_id<0 || (i>0 && u.update_id<=updates[i-1].update_id))) throw new DomainError('invalid_update_order');
      for (const u of updates) {
        if (!Number.isSafeInteger(u?.update_id) || u.update_id<0) throw new DomainError('invalid_update_id');
        const uid=BigInt(u.update_id);
        if (uid<offset) continue;
        const inserted=await db.query(`INSERT INTO telegram_updates(bot_id,update_id,disposition) VALUES($1,$2,'ignored') ON CONFLICT DO NOTHING RETURNING update_id`,[botId,String(uid)]);
        if (inserted.rowCount) {
          const membership=u.my_chat_member;
          const chat=membership?.chat??u.message?.chat;
          if(chat&&Number.isSafeInteger(chat.id)&&['group','supergroup'].includes(chat.type)){
            const status=membership?.new_chat_member?.status??'unknown';
            await db.query(`INSERT INTO telegram_discovered_chats(bot_id,chat_id,kind,title,username,membership_status)
             VALUES($1,$2,'group',$3,$4,$5) ON CONFLICT(bot_id,chat_id) DO UPDATE SET
             title=excluded.title,username=excluded.username,observed_at=now(),
             membership_status=CASE WHEN $5='unknown' THEN telegram_discovered_chats.membership_status ELSE $5 END`,
             [botId,String(chat.id),String(chat.title??'').slice(0,256),typeof chat.username==='string'?chat.username.slice(0,64):null,status]);
          }
          if (membership && ['left','kicked'].includes(membership.new_chat_member?.status)) {
            const b=(await db.query(`UPDATE telegram_bindings SET enabled=false,revision=revision+1 WHERE bot_id=$1 AND chat_id=$2 RETURNING id`,[botId,String(membership.chat?.id)])).rows[0];
            if(b) {
              await db.query(`UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND state IN ('pending','retry_wait')`,[b.id]);
              await db.query('DELETE FROM social_memory_staging WHERE character_id=$1 AND event_id=(SELECT active_event_id FROM characters WHERE id=$1)',[this.characterId]);
      await db.query('UPDATE characters SET epoch=epoch+1,lease_until=NULL,active_event_id=NULL WHERE id=$1',[this.characterId]);
            }
          }
          const m=normalizeUpdate(u,botId,a.username);
          if(m) {
            await db.query(`INSERT INTO telegram_discovered_chats(bot_id,chat_id,kind) VALUES($1,$2,$3)
              ON CONFLICT(bot_id,chat_id) DO UPDATE SET observed_at=now()`,[botId,m.chatId,m.kind]);
            const b=(await db.query('SELECT * FROM telegram_bindings WHERE bot_id=$1 AND chat_id=$2 AND enabled',[botId,m.chatId])).rows[0];
            if(b && b.kind===m.kind) {
              const fresh=m.date*1000>=Date.now()-300000 && m.date*1000<=Date.now()+60000 && !c.paused;
              const added=await db.query(`INSERT INTO telegram_messages(binding_id,message_id,author_id,text,reply_to,direct,consumed)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING seq`,[b.id,m.messageId,m.authorId,m.text,m.replyTo??null,m.direct,!fresh]);
              await db.query("UPDATE telegram_updates SET disposition=$3 WHERE bot_id=$1 AND update_id=$2",[botId,String(uid),fresh?'stored':'historical']);
              const recent=(await db.query(`SELECT count(*)::int AS n FROM social_events WHERE character_id=$1 AND audience_id=$2 AND author_id=$3 AND created_at>now()-interval '1 minute'`,[this.characterId,b.audience_id,m.authorId])).rows[0].n;
              if (added.rowCount && fresh && m.kind==='private' && recent>=10) await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1 AND message_id=$2',[b.id,m.messageId]);
              if(added.rowCount&&fresh&&this.runtime&&runtimeCommand(m.text,a.username)){
                await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1 AND message_id=$2',[b.id,m.messageId]);
                if(recent<10){
                 const response=await handleRuntimeCommand(db,this.runtime,b,m,a.username);
                 if(response?.text){
                  await this.createDecision(db,b,[{...m,seq:added.rows[0].seq,message_id:m.messageId,author_id:m.authorId}],true);
                  const d=(await db.query('SELECT event_id FROM telegram_decisions WHERE binding_id=$1 AND last_seq=$2',[b.id,added.rows[0].seq])).rows[0];
                  await db.query('UPDATE social_events SET processed=true WHERE id=$1',[d.event_id]);
                  await db.query("UPDATE telegram_decisions SET outcome='runtime_command' WHERE event_id=$1",[d.event_id]);
                  const meta=response.delivery;
                  await db.query(`INSERT INTO telegram_outbox(id,event_id,binding_id,revision,text,reply_to,direct,state,expires_at,runtime_activity_id,runtime_activity_version,runtime_turn_id,runtime_policy_version,runtime_profile_hash,runtime_text_hash)
                   VALUES($1,$2,$3,$4,$5,$6,true,'pending',now()+interval '5 minutes',$7,$8,$9,$10,$11,$12)`,[randomUUID(),d.event_id,b.id,b.revision,response.text,m.messageId,meta?.activity_id??null,meta?.activity_version??null,meta?.turn_id??null,meta?.policy_version??null,meta?.profile_hash??null,meta?fingerprint(response.text):null]);
                 }
                }
              }else if (added.rowCount && fresh && m.kind==='private' && recent<10) await this.createDecision(db,b,[{...m,seq:added.rows[0].seq,message_id:m.messageId,author_id:m.authorId}],true);
            }
          }
        }
        offset=uid+1n;
      }
      await db.query('UPDATE telegram_accounts SET next_offset=$2,last_poll_at=now() WHERE bot_id=$1',[botId,String(offset)]);
      return {offset:String(offset)};
    });
  }
  private async createDecision(db:DB,b:any,messages:any[],direct:boolean) {
    const pending=(await db.query('SELECT count(*)::int AS n FROM social_events WHERE character_id=$1 AND NOT processed',[this.characterId])).rows[0].n;
    // Backpressure leaves the polling batch unacknowledged, or the group buffer intact.
    if(pending>=100) throw new DomainError('event_queue_full');
    const first=messages[0],last=messages.at(-1),eid=randomUUID();
    const text=messages.map(m=>`${m.author_id}: ${m.text}`).join('\n').slice(-12000);
    await db.query(`INSERT INTO social_events(id,character_id,audience_id,source_key,author_id,text,author_provenance,author_trust,author_metadata,channel,turn_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'telegram','unverified',$7,'telegram',now()+interval '5 minutes')`,
      [eid,this.characterId,b.audience_id,`telegram:${b.id}:${last.seq}`,last.author_id,text,{binding_id:b.id,kind:b.kind,direct,first_seq:String(first.seq),last_seq:String(last.seq)}]);
    await db.query('INSERT INTO telegram_decisions(event_id,binding_id,first_seq,last_seq,reply_to,direct) VALUES($1,$2,$3,$4,$5,$6)',[eid,b.id,first.seq,last.seq,last.message_id,direct]);
    await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1 AND seq BETWEEN $2 AND $3',[b.id,first.seq,last.seq]);
  }
  async prepare() {
    return this.tx(async(db,c)=>{
      if(c.paused) return;
      await db.query(`UPDATE social_events SET processed=true WHERE character_id=$1 AND channel='telegram' AND NOT processed
        AND (turn_expires_at<=now() OR NOT EXISTS(SELECT 1 FROM telegram_bindings WHERE audience_id=social_events.audience_id AND enabled))`,[this.characterId]);
      const groups=(await db.query(`SELECT b.* FROM telegram_bindings b WHERE character_id=$1 AND enabled AND kind='group'`,[this.characterId])).rows;
      for(const b of groups) {
        const times=(await db.query(`SELECT min(observed_at) AS first,max(observed_at) AS last FROM telegram_messages WHERE binding_id=$1 AND NOT consumed`,[b.id])).rows[0];
        if (!times.first || (Date.now()-new Date(times.last).getTime()<10000 && Date.now()-new Date(times.first).getTime()<30000)) continue;
        const budget=(await db.query(`SELECT count(*)::int AS n,max(created_at) AS last FROM telegram_decisions WHERE binding_id=$1 AND created_at>now()-interval '1 hour'`,[b.id])).rows[0];
        if (budget.n>=20 || (budget.last && Date.now()-new Date(budget.last).getTime()<30000)) continue;
        const pending=(await db.query('SELECT count(*)::int AS n FROM social_events WHERE character_id=$1 AND NOT processed',[this.characterId])).rows[0].n;
        if(pending>=100) continue;
        const rows=(await db.query(`SELECT * FROM telegram_messages WHERE binding_id=$1 AND NOT consumed ORDER BY seq LIMIT 20`,[b.id])).rows;
        // Latest bounded range supersedes old chatter rather than generating stale turns.
        const fresh=rows.filter(m=>Date.now()-new Date(m.observed_at).getTime()<300000);
        if(fresh.length) await this.createDecision(db,b,fresh,fresh.some(m=>m.direct));
        else await db.query('UPDATE telegram_messages SET consumed=true WHERE binding_id=$1 AND seq<=$2',[b.id,rows.at(-1).seq]);
      }
    });
  }
  async scope(eventId:string,epoch:number):Promise<Principal & {channel:string}> {
    const r=(await this.pool.query(`SELECT e.audience_id,e.channel FROM characters c JOIN social_events e ON e.id=c.active_event_id
      WHERE c.id=$1 AND e.character_id=c.id AND e.id=$2 AND c.epoch=$3 AND NOT c.paused AND c.lease_until>now() AND NOT e.processed
      AND (e.channel<>'telegram' OR EXISTS(SELECT 1 FROM telegram_bindings b WHERE b.audience_id=e.audience_id AND b.enabled))`,[this.characterId,eventId,epoch])).rows[0];
    if(!r) throw new DomainError('turn_not_active');
    return {characterId:this.characterId,audienceId:r.audience_id,channel:r.channel};
  }
  async history(p:Principal,before?:string,limit=20) {
    const b=(await this.pool.query('SELECT b.id,a.observation_gap FROM telegram_bindings b JOIN telegram_accounts a USING(bot_id) WHERE b.character_id=$1 AND b.audience_id=$2 AND b.enabled',[p.characterId,p.audienceId])).rows[0];
    if(!b) throw new DomainError('binding_unavailable');
    const rows=(await this.pool.query(`SELECT seq::text,message_id,author_id,text,reply_to,observed_at FROM telegram_messages
      WHERE binding_id=$1 AND ($2::bigint IS NULL OR seq<$2::bigint) ORDER BY seq DESC LIMIT $3`,[b.id,before??null,Math.max(1,Math.min(20,limit))])).rows;
    let n=0;const bounded=rows.filter(m=>{n+=m.text.length;return n<=12000;}).reverse();
    return {messages:bounded,incomplete:true,observation_gap:b.observation_gap,source:'local_journal',observed_at:new Date().toISOString()};
  }
  async finish(eventId:string,epoch:number,decision:'reply'|'silence',text?:string) {
    return this.tx(async(db,c)=>{
      const old=(await db.query(`SELECT d.outcome,d.completion_epoch,d.completion_payload FROM telegram_decisions d JOIN social_events e ON e.id=d.event_id WHERE e.id=$1 AND e.character_id=$2`,[eventId,this.characterId])).rows[0];
      if(old?.outcome) {
        if(old.completion_epoch!==epoch || old.completion_payload!==JSON.stringify({decision,text})) throw new DomainError('completion_conflict');
        return {saved:true,decision:old.outcome};
      }
      assertActive(c,epoch);
      if(c.active_event_id!==eventId || !c.lease_until || new Date(c.lease_until).getTime()<=Date.now()) throw new DomainError('turn_not_active');
      const d=(await db.query(`SELECT d.*,b.enabled,b.revision,b.kind,b.audience_id,e.turn_expires_at FROM telegram_decisions d JOIN telegram_bindings b ON b.id=d.binding_id
        JOIN social_events e ON e.id=d.event_id WHERE e.id=$1 AND e.character_id=$2 AND NOT e.processed`,[eventId,this.characterId])).rows[0];
      if(!d || !d.enabled) throw new DomainError('binding_unavailable');
      if(decision==='silence' && d.kind!=='group') throw new DomainError('silence_private');
      if(decision==='reply' && (!text?.trim() || text.length>2000)) throw new DomainError('invalid_reply');
      let allowed=decision==='reply' && new Date(d.turn_expires_at).getTime()>Date.now();
      if(allowed && !d.direct) allowed=await this.initiativeAllowed(db,d.binding_id);
      if(allowed) {
        await db.query("INSERT INTO replies(event_id,text,channel,epoch) VALUES($1,$2,'telegram',$3) ON CONFLICT DO NOTHING",[eventId,text,epoch]);
        await db.query(`INSERT INTO telegram_outbox(id,event_id,binding_id,revision,text,reply_to,direct,state,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) ON CONFLICT(event_id) WHERE image_job_id IS NULL DO NOTHING`,[randomUUID(),eventId,d.binding_id,d.revision,text,d.reply_to,d.direct,d.turn_expires_at]);
      }
      await db.query('UPDATE telegram_decisions SET outcome=$2,completion_epoch=$3,completion_payload=$4 WHERE event_id=$1',[eventId,allowed?'reply':'silence',epoch,JSON.stringify({decision,text})]);
      const p={characterId:this.characterId,audienceId:d.audience_id};
      const staged=await loadStagedSocialMemory(db,p,eventId,epoch);
      const memory=staged?await applySocialMemoryDelta(db,staged,{...p,eventId,epoch}):undefined;
      await db.query('DELETE FROM social_memory_staging WHERE event_id=$1',[eventId]);
      await db.query(`UPDATE social_events SET processed=true,completion_payload=$2::jsonb,completion_memory_result=$3::jsonb WHERE id=$1`,[eventId,JSON.stringify(allowed?{text,channel:'telegram'}:{decision:'silent'}),memory?JSON.stringify(memory):null]);
      await db.query('UPDATE characters SET lease_until=NULL,active_event_id=NULL WHERE id=$1',[this.characterId]);
      return {saved:true,decision:allowed?'reply':'silence'};
    });
  }
  private async initiativeAllowed(db:DB,bindingId:string,exclude?:string) {
    const r=(await db.query(`SELECT count(*)::int AS n,max(COALESCE(send_started_at,created_at)) AS last FROM telegram_outbox
      WHERE binding_id=$1 AND NOT direct AND ($2::uuid IS NULL OR id<>$2) AND state NOT IN ('cancelled','expired','failed')
      AND COALESCE(send_started_at,created_at)>now()-interval '10 minutes'`,[bindingId,exclude??null])).rows[0];
    return r.n<2 && (!r.last || Date.now()-new Date(r.last).getTime()>=60000);
  }
  async claim(botId:string,owner:string) {
    return this.tx(async(db,c)=>{
      await db.query(`UPDATE telegram_outbox SET state='unknown',error_code='worker_lease_lost' WHERE state='sending' AND lease_until<now()
        AND binding_id IN (SELECT id FROM telegram_bindings WHERE character_id=$1)`,[this.characterId]);
      await db.query(`UPDATE telegram_outbox o SET state=CASE WHEN o.expires_at<=now() THEN 'expired' ELSE 'cancelled' END
        FROM telegram_bindings b WHERE o.binding_id=b.id AND b.character_id=$1 AND o.state IN ('pending','retry_wait')
        AND (o.expires_at<=now() OR NOT b.enabled OR o.revision<>b.revision OR $2)`,[this.characterId,c.paused]);
      if(c.paused) return null;
      const poller=await db.query('SELECT 1 FROM telegram_accounts WHERE bot_id=$1 AND character_id=$2 AND poll_owner=$3 AND poll_until>now()',[botId,this.characterId,owner]);
      if(!poller.rowCount) throw new DomainError('poller_lease_expired');
      const jobs=(await db.query(`SELECT o.*,b.chat_id,b.bot_id FROM telegram_outbox o JOIN telegram_bindings b ON b.id=o.binding_id
        JOIN telegram_accounts a ON a.bot_id=b.bot_id
        WHERE b.character_id=$1 AND b.enabled AND a.status='connected' AND (a.retry_at IS NULL OR a.retry_at<=now()) AND o.state IN ('pending','retry_wait')
        AND (o.retry_at IS NULL OR o.retry_at<=now()) ORDER BY o.created_at LIMIT 20`,[this.characterId])).rows;
      for(const job of jobs) {
        if(!await runtimeDeliveryValid(db,job)){await db.query("UPDATE telegram_outbox SET state='cancelled' WHERE id=$1",[job.id]);continue;}
        const sameReply=job.image_job_id && (await db.query("SELECT 1 FROM telegram_outbox WHERE event_id=$1 AND image_job_id IS NULL AND state IN ('pending','sending','sent','retry_wait')",[job.event_id])).rowCount;
        if(!job.direct && !sameReply && !await this.initiativeAllowed(db,job.binding_id,job.id)) {
          await db.query("UPDATE telegram_outbox SET state='cancelled',error_code='initiative_budget' WHERE id=$1",[job.id]);continue;
        }
        const count=(await db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE binding_id=$2)::int AS local FROM telegram_outbox
          WHERE binding_id IN (SELECT id FROM telegram_bindings WHERE bot_id=$1) AND send_started_at>now()-interval '1 minute'`,[job.bot_id,job.binding_id])).rows[0];
        if(count.total>=20 || count.local>=5) continue;
        const claimId=randomUUID();
        await db.query("UPDATE telegram_outbox SET state='sending',claim_id=$2,lease_until=now()+interval '30 seconds',send_started_at=now() WHERE id=$1",[job.id,claimId]);
        return {id:job.id,claim_id:claimId,bot_id:job.bot_id,chat_id:job.chat_id,text:job.text,reply_to:job.reply_to,...(job.image_data?{image:job.image_data.toString('base64')}: {})};
      }
      return null;
    });
  }
  async delivered(id:string,claim:string,state:'sent'|'retry_wait'|'failed'|'unknown',messageId?:string,retryAfter?:number,code?:string) {
    return this.tx(async db=>{
      const job=(await db.query(`SELECT o.* FROM telegram_outbox o JOIN telegram_bindings b ON b.id=o.binding_id WHERE o.id=$1 AND b.character_id=$2 AND o.claim_id=$3 AND o.state IN ('sending','unknown')`,[id,this.characterId,claim])).rows[0];
      if(!job) throw new DomainError('delivery_claim_invalid');
      await db.query(`UPDATE telegram_outbox SET state=$2,message_id=$3,error_code=$4,retry_at=CASE WHEN $5::int IS NULL THEN NULL ELSE now()+$5*interval '1 second' END WHERE id=$1`,[id,state,messageId??null,code??null,retryAfter??null]);
      if(state==='retry_wait' && retryAfter) await db.query(`UPDATE telegram_accounts SET retry_at=GREATEST(COALESCE(retry_at,now()),now()+$2*interval '1 second') WHERE bot_id=(SELECT bot_id FROM telegram_bindings WHERE id=$1)`,[job.binding_id,retryAfter]);
      if(state==='sent') await db.query(`INSERT INTO telegram_messages(binding_id,message_id,author_id,text,incoming,consumed,reply_to) VALUES($1,$2,'telegram:self',$3,false,true,$4) ON CONFLICT DO NOTHING`,[job.binding_id,messageId,job.text,job.reply_to]);
      if(code==='forbidden') {
        await db.query('UPDATE telegram_bindings SET enabled=false,revision=revision+1 WHERE id=$1',[job.binding_id]);
        await db.query("UPDATE telegram_outbox SET state='cancelled' WHERE binding_id=$1 AND state IN ('pending','retry_wait')",[job.binding_id]);
      }
      return {saved:true};
    });
  }
  async resolve(id:string,action:'sent'|'retry'|'cancelled',messageId?:string) {
    return this.tx(async db=>{
      const job=(await db.query(`SELECT o.*,b.enabled,b.revision AS current_revision FROM telegram_outbox o JOIN telegram_bindings b ON b.id=o.binding_id
        WHERE o.id=$1 AND b.character_id=$2 AND o.state='unknown'`,[id,this.characterId])).rows[0];
      if(!job) throw new DomainError('unknown_delivery_not_found');
      if(action==='sent' && !messageId) throw new DomainError('message_id_required');
      if(action==='retry' && (!job.enabled || job.revision!==job.current_revision || new Date(job.expires_at).getTime()<=Date.now())) throw new DomainError('delivery_revoked');
      await db.query('UPDATE telegram_outbox SET state=$2,message_id=$3,claim_id=NULL,retry_at=NULL WHERE id=$1',[id,action==='retry'?'pending':action,messageId??null]);
      return {saved:true};
    });
  }
  async overview() {
    const accounts=(await this.pool.query('SELECT bot_id,status,next_offset::text,last_poll_at,observation_gap FROM telegram_accounts WHERE character_id=$1',[this.characterId])).rows;
    const bindings=(await this.pool.query('SELECT * FROM telegram_bindings WHERE character_id=$1 ORDER BY created_at',[this.characterId])).rows;
    const deliveries=(await this.pool.query(`SELECT o.id,o.state,o.message_id,o.error_code,o.created_at,o.expires_at,o.binding_id FROM telegram_outbox o
      JOIN telegram_bindings b ON b.id=o.binding_id WHERE b.character_id=$1 ORDER BY o.created_at DESC LIMIT 50`,[this.characterId])).rows;
    const discovered_chats=(await this.pool.query(`SELECT d.chat_id,d.bot_id,d.kind,d.observed_at FROM telegram_discovered_chats d JOIN telegram_accounts a USING(bot_id) WHERE a.character_id=$1 ORDER BY d.observed_at DESC LIMIT 50`,[this.characterId])).rows;
    const events=(await this.pool.query(`SELECT e.id,e.audience_id,e.attempts,e.turn_expires_at FROM social_events e WHERE e.character_id=$1 AND e.channel='telegram' AND NOT e.processed ORDER BY e.created_at LIMIT 100`,[this.characterId])).rows;
    const decisions=(await this.pool.query(`SELECT d.event_id,d.binding_id,d.direct,d.outcome,d.created_at FROM telegram_decisions d JOIN social_events e ON e.id=d.event_id WHERE e.character_id=$1 ORDER BY d.created_at DESC LIMIT 50`,[this.characterId])).rows;
    return {accounts,bindings,discovered_chats,events,decisions,deliveries};
  }
}
