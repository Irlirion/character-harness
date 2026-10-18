import type { FastifyInstance } from 'fastify';
import { DomainError } from '../../packages/domain/policy.ts';
import { z } from 'zod';
import type { TelegramStore } from '../../packages/storage/telegram.ts';
export function telegramRoutes(app:FastifyInstance,store:TelegramStore) {
  const numeric=z.string().regex(/^\d+$/).max(30);
  const chat=z.string().regex(/^-?\d+$/).max(30);
  // Keep the global role budget first; the plugin skips its second handler via the request marker.
  app.get('/owner/telegram',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},()=>store.overview());
  app.post('/owner/telegram/runtime-control',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},async req=>{
    const b=z.object({binding_id:z.uuid(),enabled:z.boolean()}).strict().parse(req.body);
    return store.runtimeControl(b.binding_id,b.enabled);
  });
  app.post('/owner/telegram/bindings',async req=>{
    const b=z.object({bot_id:numeric,chat_id:chat,kind:z.enum(['private','group']),enabled:z.boolean().default(true)}).strict().parse(req.body);
    return store.bind(b.bot_id,b.chat_id,b.kind,b.enabled);
  });
  app.post('/owner/telegram/deliveries/:id/resolve',async req=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    const b=z.object({action:z.enum(['sent','retry','cancelled']),message_id:numeric.optional()}).strict().parse(req.body);
    return store.resolve(id,b.action,b.message_id);
  });
  app.post('/telegram/register',async req=>{
    const b=z.object({bot_id:numeric,username:z.string().regex(/^[A-Za-z0-9_]+$/).max(100)}).strict().parse(req.body);
    return store.register(b.bot_id,b.username);
  });
  app.post('/telegram/poll',async req=>{
    const b=z.object({bot_id:numeric,owner:z.string().uuid()}).strict().parse(req.body);
    return store.polling(b.bot_id,b.owner);
  });
  app.post('/telegram/updates',async req=>{
    const b=z.object({bot_id:numeric,owner:z.string().uuid(),updates:z.array(z.unknown()).max(100)}).strict().parse(req.body);
    return store.ingest(b.bot_id,b.owner,b.updates);
  });
  app.post('/telegram/state',async req=>{
    const b=z.object({bot_id:numeric,owner:z.string().uuid(),state:z.enum(['connected','auth_required','configuration_error','disconnected'])}).strict().parse(req.body);
    return store.accountState(b.bot_id,b.state,b.owner);
  });
  app.post('/telegram/claim',async req=>{
    const b=z.object({bot_id:numeric,owner:z.string().uuid()}).strict().parse(req.body);
    return {job:await store.claim(b.bot_id,b.owner)};
  });
  app.post('/telegram/deliveries/:id',async req=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    const b=z.object({claim_id:z.string().uuid(),state:z.enum(['sent','retry_wait','failed','unknown']),message_id:numeric.optional(),retry_after:z.number().int().min(1).max(2147483647).optional(),error_code:z.enum(['unauthorized','forbidden','rate_limited','rejected','unknown']).optional()}).strict().parse(req.body);
    if(b.state==='sent' && !b.message_id) throw new DomainError('message_id_required');
    if(b.state==='retry_wait' && !b.retry_after) throw new DomainError('retry_after_required');
    return store.delivered(id,b.claim_id,b.state,b.message_id,b.retry_after,b.error_code);
  });
}
