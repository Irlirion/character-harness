import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {ImageStore} from '../packages/storage/images.ts';
import {TelegramStore} from '../packages/storage/telegram.ts';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=';
test('image queue PostgreSQL contracts',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema='images_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
 process.env.DATABASE_URL=url.toString();const storage=await import('../packages/storage/db.ts');const pool=storage.pool;
 try{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const images=new ImageStore(pool,'lada');const telegram=new TelegramStore(pool,'lada');
  const p={characterId:'lada',audienceId:'demo-public'};let owner=randomUUID(),uid=0;let binding:any;
  async function reset(){await pool.query('TRUNCATE characters CASCADE');await pool.query("INSERT INTO characters(id,name,persona) VALUES('lada','Лада','test')");owner=randomUUID();uid=0;await telegram.register('99','LadaBot');await telegram.polling('99',owner);await telegram.accountState('99','connected',owner);binding=await telegram.bind('99','8','private',true);}
  async function event(){const id=++uid;await telegram.ingest('99',owner,[{update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),from:{id:8,is_bot:false},chat:{id:8,type:'private'},text:'Нарисуй себя'}}]);await telegram.prepare();const e=await storage.nextEvent(p,true);return {e,epoch:(await storage.status(p)).epoch,scope:{...p,audienceId:binding.audience_id}};}
  await t.test('async result survives the conversation turn and deduplicates queue and delivery',async()=>{
   await reset();const {e,epoch,scope}=await event();const queued=await images.queue(scope,e.id,epoch,'Portrait','Вот я');
   assert.deepEqual(await images.queue(scope,e.id,epoch,'another prompt',''),queued);
   await telegram.finish(e.id,epoch,'reply','Рисую');
   const [a,b]=await Promise.all([images.claim(),images.claim()]);const job=a??b;assert.ok(job);assert.ok(!a||!b);
   assert.equal((await images.status(scope)).attempts_24h,1);
   await images.finish(job.id,job.claim_id,'generated',image);await images.finish(job.id,job.claim_id,'generated',image);
   const text=await telegram.claim('99',owner);assert.ok(text);assert.ok(!text.image);await telegram.delivered(text.id,text.claim_id,'sent','90');
   const photo=await telegram.claim('99',owner);assert.ok(photo);assert.equal(photo.image,image);assert.equal(photo.chat_id,'8');
   await telegram.delivered(photo.id,photo.claim_id,'sent','91');assert.equal(await telegram.claim('99',owner),null);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_outbox')).rows[0].n,2);
  });
  await t.test('pause revokes generated result, attempt stays counted',async()=>{
   await reset();const {e,epoch,scope}=await event();await images.queue(scope,e.id,epoch,'Portrait','');const job=await images.claim();assert.ok(job);await storage.control(p,true);
   assert.equal((await images.finish(job.id,job.claim_id,'generated',image)).state,'cancelled');
   assert.equal((await images.status(scope)).attempts_24h,1);assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_outbox')).rows[0].n,0);
  });
  await t.test('restart expires running job without regenerating; failure is not retried',async()=>{
   await reset();const {e,epoch,scope}=await event();await images.queue(scope,e.id,epoch,'Portrait','');const job=await images.claim();assert.ok(job);
   await pool.query("UPDATE image_jobs SET lease_until=now()-interval '1 second'");assert.equal(await new ImageStore(pool,'lada').claim(),null);
   assert.equal((await images.status(scope)).jobs[0].state,'unknown');assert.equal((await images.status(scope)).attempts_24h,1);
   assert.equal((await images.finish(job.id,job.claim_id,'generated',image)).state,'unknown');
  });
  await t.test('job start budget and audience boundaries',async()=>{
   await reset();const {e,epoch,scope}=await event();
   await assert.rejects(images.queue(p,e.id,epoch,'Portrait',''),{code:'binding_unavailable'});
   await images.queue(scope,e.id,epoch,'Portrait','');const job=await images.claim();assert.ok(job);await images.finish(job.id,job.claim_id,'failed');await telegram.finish(e.id,epoch,'reply','Не получилось');
   for(let i=0;i<2;i++){const n=await event();await images.queue(n.scope,n.e.id,n.epoch,'Portrait','');const j=await images.claim();assert.ok(j);await images.finish(j.id,j.claim_id,'failed');await telegram.finish(n.e.id,n.epoch,'reply','Не получилось');}
   const n=await event();await assert.rejects(images.queue(n.scope,n.e.id,n.epoch,'Portrait',''),{code:'image_budget_exhausted'});
   assert.equal((await images.status(p)).jobs.length,0);
  });
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
