import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError,assertActive,type Principal } from '../domain/policy.ts';
import { decodeImage } from '../images/domain.ts';
export class ImageStore {
 private pool:pg.Pool;private characterId:string;
 constructor(pool:pg.Pool,characterId:string){this.pool=pool;this.characterId=characterId;}
 private async tx<T>(run:(db:pg.PoolClient,c:any)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();try{await db.query('BEGIN');const c=(await db.query('SELECT * FROM characters WHERE id=$1 FOR UPDATE',[this.characterId])).rows[0];if(!c)throw new DomainError('character_not_found');const r=await run(db,c);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async status(p?:Principal){
  const usage=(await this.pool.query(`SELECT count(*) FILTER(WHERE started_at>now()-interval '24 hours')::int AS attempts_24h,count(*) FILTER(WHERE started_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS attempts_month FROM image_jobs WHERE character_id=$1`,[this.characterId])).rows[0];
  const jobs=(await this.pool.query(`SELECT j.id,j.state,j.created_at,j.error_code,o.state AS delivery_state FROM image_jobs j JOIN telegram_bindings b ON b.id=j.binding_id LEFT JOIN telegram_outbox o ON o.image_job_id=j.id WHERE j.character_id=$1 AND ($2::text IS NULL OR b.audience_id=$2) ORDER BY j.created_at DESC LIMIT 5`,[this.characterId,p?.audienceId??null])).rows;
  return {...usage,limits:{attempts_24h:3,attempts_month:15},guarantee:'job_starts_only_native_tool_calls_not_hard_limited',jobs};
 }
 async queue(p:Principal,eventId:string,epoch:number,prompt:string,caption:string){
  return this.tx(async(db,c)=>{
   assertActive(c,epoch);
   if(c.active_event_id!==eventId||!c.lease_until||new Date(c.lease_until).getTime()<=Date.now())throw new DomainError('turn_not_active');
   const d=(await db.query(`SELECT d.*,b.revision,b.enabled FROM telegram_decisions d JOIN telegram_bindings b ON b.id=d.binding_id JOIN social_events e ON e.id=d.event_id WHERE d.event_id=$1 AND b.character_id=$2 AND b.audience_id=$3 AND NOT e.processed AND e.turn_expires_at>now()`,[eventId,this.characterId,p.audienceId])).rows[0];
   if(!d?.enabled)throw new DomainError('binding_unavailable');
   const old=(await db.query('SELECT id,state FROM image_jobs WHERE event_id=$1',[eventId])).rows[0];if(old)return old;
   const busy=await db.query("SELECT 1 FROM image_jobs WHERE character_id=$1 AND state IN ('queued','generating')",[this.characterId]);if(busy.rowCount)throw new DomainError('image_busy');
   const usage=await this.status(p);if(usage.attempts_24h>=3||usage.attempts_month>=15)throw new DomainError('image_budget_exhausted');
   const id=randomUUID();await db.query("INSERT INTO image_jobs(id,character_id,event_id,binding_id,revision,prompt,caption,state) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')",[id,this.characterId,eventId,d.binding_id,d.revision,prompt,caption]);return {id,state:'queued'};
  });
 }
 async claim(){
  return this.tx(async(db,c)=>{
   await db.query("UPDATE image_jobs SET state='unknown',error_code='lease_lost' WHERE character_id=$1 AND state='generating' AND lease_until<=now()",[this.characterId]);
   await db.query(`UPDATE image_jobs j SET state='cancelled' FROM telegram_bindings b WHERE j.binding_id=b.id AND j.character_id=$1 AND j.state='queued' AND ($2 OR NOT b.enabled OR b.revision<>j.revision OR j.created_at<now()-interval '5 minutes')`,[this.characterId,c.paused]);
   if(c.paused)return null;
   if((await db.query("SELECT 1 FROM image_jobs WHERE character_id=$1 AND state='generating'",[this.characterId])).rowCount)return null;
   const job=(await db.query("SELECT * FROM image_jobs WHERE character_id=$1 AND state='queued' ORDER BY created_at LIMIT 1",[this.characterId])).rows[0];if(!job)return null;
   const usage=await this.status({characterId:this.characterId,audienceId:''});
   if(usage.attempts_24h>=3||usage.attempts_month>=15){await db.query("UPDATE image_jobs SET state='cancelled',error_code='budget_exhausted' WHERE id=$1",[job.id]);return null;}
   const claim=randomUUID();await db.query("UPDATE image_jobs SET state='generating',started_at=now(),claim_id=$2,lease_until=now()+interval '4 minutes' WHERE id=$1",[job.id,claim]);
   return {id:job.id,claim_id:claim,prompt:job.prompt};
  });
 }
 async finish(id:string,claim:string,state:'generated'|'failed'|'unknown',encoded?:string){
  let bytes:Buffer|undefined;try{bytes=state==='generated'?decodeImage(encoded??''):undefined;}catch{throw new DomainError('invalid_image');}
  return this.tx(async(db,c)=>{
   const j=(await db.query(`SELECT j.*,b.enabled,b.revision AS current_revision,d.reply_to,d.direct FROM image_jobs j JOIN telegram_bindings b ON b.id=j.binding_id JOIN telegram_decisions d ON d.event_id=j.event_id WHERE j.id=$1 AND j.character_id=$2 AND j.claim_id=$3`,[id,this.characterId,claim])).rows[0];
   if(!j)throw new DomainError('image_claim_invalid');
   if(j.state!=='generating')return {saved:true,state:j.state};
   let next=state==='generated'?'ready':state;
   if(c.paused||!j.enabled||j.current_revision!==j.revision||new Date(j.lease_until).getTime()<=Date.now())next='cancelled';
   if(next==='ready')await db.query(`INSERT INTO telegram_outbox(id,event_id,binding_id,revision,text,reply_to,direct,state,expires_at,image_job_id,image_data) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',now()+interval '5 minutes',$8,$9) ON CONFLICT(image_job_id) DO NOTHING`,[randomUUID(),j.event_id,j.binding_id,j.revision,j.caption,j.reply_to,j.direct,j.id,bytes]);
   await db.query('UPDATE image_jobs SET state=$2,error_code=$3 WHERE id=$1',[id,next,next==='failed'?'generation_failed':next==='unknown'?'generation_unknown':null]);
   return {saved:true,state:next};
  });
 }
}
