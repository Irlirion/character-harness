import { toolDescription } from '../../packages/domain/tool-descriptions.ts';
import { readFileSync } from 'node:fs';
import type { UnionClefWorkspace } from '../../packages/minecraft/unionclef.ts';
import { approachPlayer } from '../../packages/minecraft/approach-player.ts';
import type { ClientActionKind } from '../../packages/storage/actions.ts';
import { runtimeOwnerRoutes, runtimeEngineRoutes, type RuntimeOwnerStore, type RuntimeEngineStore, type RuntimePlanningPolicy } from './runtime.ts';
import type { ImageStore } from '../../packages/storage/images.ts';
import { ImageSchema } from '../../packages/images/domain.ts';
import {directedErrorDetail} from '../../packages/storage/telegram-directed.ts';
import { telegramRoutes } from './telegram.ts';
import type { TelegramStore } from '../../packages/storage/telegram.ts';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Principal } from '../../packages/domain/policy.ts';
import { DomainError, OWNER_CHAT_AUDIENCE, matchesToken, requestPath, requiredRole } from '../../packages/domain/policy.ts';
import { BridgeEventScopeError, parseBridgeEvent, SYSTEM_CHAT_SERVER } from '../../packages/domain/bridge-event.ts';
import { isObservationTimeCurrent, worldObservationSchema } from '../../packages/domain/world-observation.ts';
import { SocialMemoryDeltaSchema } from '../../packages/domain/social-memory.ts';
import { SocialMemoryProposalSchema } from '../../packages/domain/social-memory.ts';
import { boundSocialContext, makeTurnInput, type SocialContextInput } from '../../packages/domain/conversation-context.ts';

export type CoreTokens = { engine: string; owner: string; audio: string; bridge: string; telegram?:string };
export type CoreDeps = {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; end: () => Promise<void> };
  status: (p: Principal) => Promise<any>;
  search: (p: Principal, query: string) => Promise<any>;
  remember: (p: Principal, text: string, invocationId: string, epoch: number) => Promise<any>;
  control: (p: Principal, paused: boolean) => Promise<any>;
  ingest: (p: Principal, event: any) => Promise<{ inserted: boolean; event_id: string | null }>;
  nextEvent: (p: Principal) => Promise<any>;
  recentConversation: (p: Principal, currentEventId: string) => Promise<any>;
  loadSharedDesk?: (p:Principal)=>Promise<{revision:number;notes:string;plan:string}>;
  loadSocialMemory?: (p: Principal, event: any) => Promise<SocialContextInput>;
  inspectEvent?: (p: Principal, eventId?: string) => Promise<any>;
  stageMemory?: (p: Principal, eventId: string, epoch: number, invocationId: string, proposal: unknown) => Promise<any>;
  socialCommitmentPage?: (p:Principal,eventId:string,epoch:number,limit:number,offset:number)=>Promise<any>;
  complete: (p: Principal, eventId: string, text: string | null, epoch: number, speak?: boolean, delta?: any, deltaDiagnostic?: string, rawDelta?: unknown, decision?: 'reply'|'silent', channel?: 'local'|'voice'|'chat') => Promise<any>;
  deferEvent: (p: Principal, eventId: string, epoch?: number) => Promise<any>;
  enqueueSpeech: (p: Principal, requestId: string, text: string) => Promise<any>;
  claimSpeech: (p: Principal) => Promise<any>;
  speechState: (p: Principal, id: string) => Promise<any>;
  updateSpeech: (p: Principal, id: string, claimId: string, state: 'playing' | 'completed' | 'failed' | 'cancelled') => Promise<any>;
  enqueueClientAction?: (p: Principal, invocationId: string, kind: ClientActionKind, args: Record<string, number>, durationMs: number, epoch: number) => Promise<any>;
  clientActionStatus?: (p: Principal, id: string) => Promise<any>;
  clientActionLease?: (p: Principal, id: string, claimId: string) => Promise<any>;
  claimClientAction?: (p: Principal) => Promise<any>;
  finishClientAction?: (p: Principal, id: string, claimId: string, state: 'completed'|'failed'|'cancelled', evidence: unknown) => Promise<any>;
  cancelClientActions?: (p:Principal) => Promise<any>;
  saveWorldObservation?: (p:Principal, observation:any) => Promise<any>;
  latestWorldObservation?: (p:Principal) => Promise<any>;
};
export type BuildAppOptions = {
  shadowStatus?: () => {state:string;model:string};
  principal: Principal;
  tokens: CoreTokens;
  minecraft?:UnionClefWorkspace;
  deps: CoreDeps;
  runtime?: RuntimeOwnerStore;
  runtimeEngine?: RuntimeEngineStore;
  runtimePolicy?: RuntimePlanningPolicy;
  telegram?:TelegramStore;
  images?:ImageStore;
  memoryInstructions?: string;
  responseInstructions?: string;
  allowClientWorld?: boolean;
  allowSystemChatPublicDemo?: boolean;
};

function emptySocialContext(): SocialContextInput {
  return {working_state:null,current_person:null,facts:[],relationships:[],commitments:[],other_open_commitment_count:0,counts:{facts:0,relationships:0,commitments:0}};
}

/** Builds the HTTP surface. Environment, secrets and the database stay in main.ts. */
export function buildApp({ shadowStatus, principal, tokens, minecraft, deps, memoryInstructions = '', responseInstructions = '', telegram, images, runtime, runtimeEngine, runtimePolicy, allowClientWorld = false, allowSystemChatPublicDemo = false }: BuildAppOptions): FastifyInstance {
const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 64 * 1024 });
const dashboardHtml = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const HeartbeatSchema=z.object({component:z.enum(['codex-engine','pi-engine','audio-worker','tts-service']),state:z.enum(['starting','ready','busy','degraded','stopping']),error_code:z.string().regex(/^[a-z0-9_]{1,80}$/).nullable().optional()}).strict();
// Roles share a token, so budget by role rather than IP or attacker-supplied headers.
// Audio workers poll frequently; engine and owner requests use separate budgets.
function rateBudget(path: string) {
  const role = requiredRole(path) ?? 'owner';
  return { key: role, max: { audio: 600, engine: 300, bridge:900, owner: 120, telegram:600 }[role] };
}
app.register(rateLimit, {
  hook: 'preHandler', timeWindow: '1 minute',
  max: req => rateBudget(requestPath(req.url)).max,
  keyGenerator: req => rateBudget(requestPath(req.url)).key
});
// Install routes after the plugin's onRoute hook is ready.
app.after(() => {
const { engine: engineToken, owner: ownerToken, audio: audioToken, bridge: bridgeToken } = tokens;
const { pool, status, search, remember, control, ingest, nextEvent, recentConversation, complete, deferEvent,
  enqueueSpeech, claimSpeech, speechState, updateSpeech } = deps;
app.addHook('onSend',async(req,reply,payload)=>{if(req.url.startsWith('/owner/overview'))reply.header('Cache-Control','no-store');return payload;});
const currentWorldObservation=async()=>{
  const [workspace,client]=await Promise.all([
    minecraft?minecraft.observe():Promise.resolve({available:false,connected:false,stale:true,state:'not_configured'}),
    deps.latestWorldObservation?deps.latestWorldObservation(principal):Promise.resolve({available:false,connected:false,stale:true})
  ]);
  const snapshot=client.snapshot ? {...client.snapshot,self:{...client.snapshot.self}} : null;
  // This flag describes the disabled companion watchdog, not the direct MCP connection.
  if(snapshot?.self)delete snapshot.self.minecraft_workspace_ready;
  return {...workspace,client_observation:{available:client.available,connected:client.connected,stale:client.stale,server:client.server??null,session_id:client.session_id??null,age_ms:client.age_ms??null,snapshot}};
};
app.addHook('onRequest', async (req, reply) => {
  const path = requestPath(req.url);
  if (path === '/health') return;
  // The local dashboard uses a bearer token in same-origin fetches. Cross-origin
  // browser requests remain rejected; the token is never placed in the page.
  if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) {
    return reply.code(403).send({ error: 'browser_access_disabled' });
  }
  if (path === '/' && req.method === 'GET') return;
  // Derive the required token from the resolved path, never from the raw request target:
  // an unmatched path has no role and must not fall back to the engine token.
  const role = requiredRole(path);
  const required = role === 'owner' ? ownerToken : role === 'audio' ? audioToken : role === 'bridge' ? bridgeToken : role === 'engine' ? engineToken : role === 'telegram' ? tokens.telegram??null : null;
  if (required === null || !matchesToken(req.headers.authorization, required)) return reply.code(401).send({ error: 'unauthorized' });
});
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) return reply.code(429).send({ error: 'rate_limit_exceeded' });
  if (error instanceof DomainError && ['event_queue_full', 'author_rate_limit'].includes(error.code)) {
    return reply.header('Retry-After', '60').code(429).send({ error: error.code });
  }
  if (error instanceof DomainError) return reply.code(409).send({ error: error.code });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_input' });
  app.log.error({ name: error instanceof Error ? error.name : 'unknown' }, 'Request failed');
  return reply.code(500).send({ error: 'internal_error' });
});
if (runtime) runtimeOwnerRoutes(app, principal, runtime);
if (runtimeEngine) runtimeEngineRoutes(app,principal,runtimePolicy,minecraft,deps.latestWorldObservation);
if(telegram)telegramRoutes(app,telegram);
if(images){
 app.get('/owner/images',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}},()=>images.status());
 app.post('/engine/images/claim',{preHandler:app.rateLimit(),config:{rateLimit:{max:300,timeWindow:'1 minute',keyGenerator:()=> 'engine'}}},async()=>({job:await images.claim()}));
 app.post('/engine/images/:id/result',{bodyLimit:15_000_000,preHandler:app.rateLimit(),config:{rateLimit:{max:300,timeWindow:'1 minute',keyGenerator:()=> 'engine'}}},async req=>{
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const b=z.object({claim_id:z.string().uuid(),state:z.enum(['generated','failed','unknown']),image:ImageSchema.optional()}).strict().parse(req.body);
  return images.finish(id,b.claim_id,b.state,b.image);
 });
}
app.get('/health', async () => ({ alive: true }));
app.get('/ready', async () => { await pool.query('SELECT 1'); return { ready: true }; });
app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8')
  .header('Cache-Control', 'no-store')
  .header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:")
  .send(dashboardHtml));
app.get('/engine/status', async () => status(principal));
app.post('/engine/heartbeat',{preHandler:app.rateLimit(),config:{rateLimit:{max:300,timeWindow:'1 minute',keyGenerator:()=> 'engine'}}},async req=>{
  const body=HeartbeatSchema.parse(req.body);
  if(!['codex-engine','pi-engine'].includes(body.component))throw new DomainError('heartbeat_component_denied');
  return pool.query(`INSERT INTO worker_heartbeats(character_id,component,state,error_code,heartbeat_at)
    VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(character_id,component) DO UPDATE SET
      state=excluded.state,error_code=excluded.error_code,heartbeat_at=excluded.heartbeat_at`,
    [principal.characterId,body.component,body.state,body.error_code??null]).then(()=>({saved:true}));
});
app.post('/bridge/events',{preHandler:app.rateLimit(),config:{rateLimit:{max:180,timeWindow:'1 minute',keyGenerator:()=> 'bridge-events'}}},async(req,reply)=>{
  let event;
  try{event=parseBridgeEvent(req.body,allowSystemChatPublicDemo,principal.audienceId)}
  catch(error){if(error instanceof BridgeEventScopeError)return reply.code(403).send({error:error.message});throw error;}
  return ingest(principal,event);
});
app.post('/bridge/actions/claim', async () => {
  if (!allowClientWorld || !deps.claimClientAction || !deps.clientActionLease || !deps.finishClientAction) { await deps.cancelClientActions?.(principal); return { action:null }; }
  return { action: await deps.claimClientAction!(principal) };
});
app.post('/bridge/actions/:id/lease', async req => {
  const id = z.string().uuid().parse((req.params as {id:string}).id);
  const b = z.object({claim_id:z.string().uuid()}).strict().parse(req.body);
  if (!allowClientWorld || !deps.claimClientAction || !deps.clientActionLease || !deps.finishClientAction) return { valid: false };
  return deps.clientActionLease!(principal,id,b.claim_id);
});
app.post('/bridge/actions/:id', async req => {
  const id = z.string().uuid().parse((req.params as {id:string}).id);
  const coordinate=z.number().finite().min(-30_000_000).max(30_000_000);const yCoordinate=z.number().finite().min(-4096).max(4096);
  const evidenceSchema=z.object({kind:z.enum(['walk','turn','goto']).optional(),reason:z.enum(['action_expired_before_start','client_not_ready','movement_input_busy','unsupported_action','invalid_walk_bounds','invalid_turn_bounds','unsafe_or_unsupported_step','step_became_unsafe','action_expired_mid_descent','player_flying','client_disconnected','screen_opened','world_session_mismatch','action_lease_stale','action_lease_revoked','action_expired_or_no_movement','no_position_change','rotation_not_observed','client_action_busy','test_server_gate_closed','initial_lease_invalid','unionclef_unavailable','unionclef_not_ready','invalid_navigation_target','navigation_stopped','navigation_timeout']).optional(),
    on_ground:z.boolean().optional(),collision_ahead:z.boolean().optional(),support_ahead:z.boolean().optional(),
    step_status:z.enum(['clear','not_grounded','collision','no_support','unknown_chunk']).optional(),
    obstacle_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),estimated_step_up:z.number().finite().min(0).max(2).optional(),
    nearest_support_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),nearest_support_drop:z.number().finite().min(0).max(3).optional(),
    start_x:coordinate.optional(),start_y:yCoordinate.optional(),start_z:coordinate.optional(),end_x:coordinate.optional(),end_y:yCoordinate.optional(),end_z:coordinate.optional(),
    start_yaw:z.number().finite().min(-360).max(360).optional(),end_yaw:z.number().finite().min(-360).max(360).optional(),
    start_pitch:z.number().finite().min(-90).max(90).optional(),end_pitch:z.number().finite().min(-90).max(90).optional()}).strict();
  const b = z.object({claim_id:z.string().uuid(),state:z.enum(['completed','failed','cancelled']),evidence:evidenceSchema.optional()}).strict().parse(req.body);
  return deps.finishClientAction!(principal,id,b.claim_id,allowClientWorld?b.state:'cancelled',b.evidence ?? {});
});
app.post('/bridge/observation',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'bridge-observation'}}},async req=>{
  if(!allowClientWorld||!deps.saveWorldObservation)throw new DomainError('client_world_disabled');
  const observation=worldObservationSchema.parse(req.body);
  if(JSON.stringify(observation).length>16_384)throw new DomainError('observation_too_large');
  if(!isObservationTimeCurrent(observation.observed_at))throw new DomainError('observation_time_outside_window');
  return deps.saveWorldObservation(principal,observation);
});
app.get('/bridge/replies',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'bridge-replies'}}},async req=>{
  const query=z.object({chat:z.literal('true').optional(),session_id:z.string().uuid(),server:z.literal(SYSTEM_CHAT_SERVER)}).strict().parse(req.query);
  return (await pool.query(`SELECT e.id,e.author_id,r.text,r.channel
    FROM social_events e JOIN replies r ON r.event_id=e.id
    WHERE e.character_id=$1 AND e.audience_id=$2
      AND e.author_provenance IN ('fabric_profile_context','minecraft_system_chat','minecraft_voice_stt')
      AND e.author_metadata->>'bridge_session_id'=$3 AND e.author_metadata->>'source_server'=$4
      AND NOT e.reply_delivered
      AND (r.channel<>'chat' OR ($5::boolean AND r.created_at>now()-interval '60 seconds'
        AND EXISTS(SELECT 1 FROM characters c WHERE c.id=e.character_id AND NOT c.paused AND c.epoch=r.epoch)))
    ORDER BY e.created_at,e.id LIMIT 20`,[principal.characterId,principal.audienceId,query.session_id,query.server,query.chat==='true'])).rows;
});
app.post('/bridge/replies/:id/claim-chat',{preHandler:app.rateLimit(),config:{rateLimit:{max:60,timeWindow:'1 minute',keyGenerator:()=> 'bridge-chat-claims'}}},async req=>{
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const body=z.object({session_id:z.string().uuid(),server:z.literal(SYSTEM_CHAT_SERVER)}).strict().parse(req.body);
  const result=await pool.query(`UPDATE social_events e SET reply_delivered=true
    WHERE e.id=$1 AND e.character_id=$2 AND e.audience_id=$3 AND e.processed AND NOT e.reply_delivered
      AND e.author_provenance IN ('fabric_profile_context','minecraft_system_chat','minecraft_voice_stt')
      AND e.author_metadata->>'bridge_session_id'=$4 AND e.author_metadata->>'source_server'=$5
      AND EXISTS(SELECT 1 FROM replies r JOIN characters c ON c.id=e.character_id
        WHERE r.event_id=e.id AND r.channel='chat' AND r.created_at>now()-interval '60 seconds' AND NOT c.paused AND c.epoch=r.epoch)
      AND EXISTS(SELECT 1 FROM characters c WHERE c.id=e.character_id AND NOT c.paused)
    RETURNING e.id`,[id,principal.characterId,principal.audienceId,body.session_id,body.server]);
  return {claimed:result.rowCount===1};
});
app.post('/bridge/replies/:id/ack',{preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'bridge-reply-acks'}}},async req=>{
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const body=z.object({session_id:z.string().uuid(),server:z.literal(SYSTEM_CHAT_SERVER)}).strict().parse(req.body);
  const result=await pool.query(`UPDATE social_events SET reply_delivered=true
    WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND processed
      AND author_provenance IN ('fabric_profile_context','minecraft_system_chat','minecraft_voice_stt')
      AND author_metadata->>'bridge_session_id'=$4 AND author_metadata->>'source_server'=$5
      AND EXISTS(SELECT 1 FROM replies WHERE event_id=$1)`,[id,principal.characterId,principal.audienceId,body.session_id,body.server]);
  if(!result.rowCount)throw new DomainError('reply_not_found');
  return {acknowledged:true};
});
app.post('/audio/heartbeat',{preHandler:app.rateLimit(),config:{rateLimit:{max:600,timeWindow:'1 minute',keyGenerator:()=> 'audio'}}},async req=>{
  const body=HeartbeatSchema.parse(req.body);
  if(!['audio-worker','tts-service'].includes(body.component))throw new DomainError('heartbeat_component_denied');
  return pool.query(`INSERT INTO worker_heartbeats(character_id,component,state,error_code,heartbeat_at)
    VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(character_id,component) DO UPDATE SET
      state=excluded.state,error_code=excluded.error_code,heartbeat_at=excluded.heartbeat_at`,
    [principal.characterId,body.component,body.state,body.error_code??null]).then(()=>({saved:true}));
});
// The global handler runs first to retain the shared role budget; route config also exposes the limit to static analysis.
app.get('/owner/status', {preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}}, async () => ({ character: await status(principal), audience: principal.audienceId, runtime: { storage_enabled: !!runtime, protocol_enabled: !!runtimeEngine, autonomous_execution: runtimePolicy?.executionEnabled?await runtimePolicy.executionEnabled(principal):false, policy_gate: runtimePolicy?'installed':'unavailable' }, adapters: { minecraft: minecraft ? await minecraft.status() : {state:'not_configured'}, game_bridge:deps.latestWorldObservation?await deps.latestWorldObservation(principal):{available:false,state:'not_observed'}, telegram: telegram?await telegram.overview():'not_configured', voice: 'native_audio_worker_status_unavailable' } }));
app.get('/owner/overview', {preHandler:app.rateLimit(),config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:()=> 'owner'}}}, async () => {
  const [character, world, queue, event, activeActivity, heartbeats, bridge] = await Promise.all([
    pool.query(`SELECT id,name,paused,epoch,active_event_id,active_runtime_turn_id,lease_until FROM characters WHERE id=$1`, [principal.characterId]),
    minecraft?minecraft.status():Promise.resolve({configured:false,connected:false,stale:true,state:'not_configured',tool_count:null,self:null,player_count:null}),
    pool.query(`SELECT count(*) FILTER (WHERE NOT processed)::int AS pending_events,
      count(*) FILTER (WHERE processed)::int AS processed_events FROM social_events WHERE character_id=$1`, [principal.characterId]),
    pool.query(`SELECT id,channel,text,created_at,processed FROM social_events WHERE id=(SELECT active_event_id FROM characters WHERE id=$1)`, [principal.characterId]),
    pool.query(`SELECT a.id,a.objective,a.status,a.turns_used,a.max_turns,a.question,a.summary,t.created_at AS turn_started_at,t.lease_until
      FROM characters c JOIN runtime_turns t ON t.id=c.active_runtime_turn_id AND t.status='running'
      JOIN runtime_activities a ON a.id=t.activity_id WHERE c.id=$1`, [principal.characterId]),
    pool.query(`SELECT component,state,error_code,heartbeat_at,
      (extract(epoch FROM clock_timestamp()-heartbeat_at)*1000)::int AS age_ms FROM worker_heartbeats
      WHERE character_id=$1 ORDER BY heartbeat_at DESC`,[principal.characterId]),
    deps.latestWorldObservation?deps.latestWorldObservation(principal):Promise.resolve({available:false,stale:true,connected:false,state:'not_observed'})
  ]);
  const latestWorld = world;
  const c=character.rows[0];
  const heartbeat=(components:string[])=>{
    const row=heartbeats.rows.find((item:any)=>components.includes(item.component));
    if(!row)return {state:'not_observed',fresh:false,last_seen_at:null,age_ms:null,error_code:null};
    const age=Number(row.age_ms),fresh=age<=30000;
    return {state:fresh?row.state:'stale',reported_state:row.state,fresh,last_seen_at:row.heartbeat_at,age_ms:age,error_code:row.error_code??null};
  };
  const engineHeartbeat=heartbeat(['codex-engine','pi-engine']);
  const audioHeartbeat=heartbeat(['audio-worker']);
  const ttsHeartbeat=heartbeat(['tts-service']);
  const voiceState=audioHeartbeat.state==='not_observed'&&ttsHeartbeat.state==='not_observed'?'not_observed':
    [audioHeartbeat.state,ttsHeartbeat.state].includes('degraded')?'degraded':
    [audioHeartbeat.state,ttsHeartbeat.state].includes('stale')?'stale':
    audioHeartbeat.state==='busy'?'busy':
    audioHeartbeat.state==='ready'&&ttsHeartbeat.state==='ready'?'ready':
    audioHeartbeat.state==='starting'||ttsHeartbeat.state==='starting'?'starting':'not_observed';
  const bridgeState=!bridge.available?'not_observed':bridge.stale?'stale':bridge.connected?'connected':'disconnected';
  return {generated_at:new Date().toISOString(),character:c?{id:c.id,name:c.name,paused:c.paused,epoch:c.epoch,lease_until:c.lease_until,active_event: event.rows[0]??null,active_activity:activeActivity.rows[0]??null}:null,
    world:latestWorld,bridge,queue:queue.rows[0]??{pending_events:0,processed_events:0},workers:{engine:engineHeartbeat,audio:audioHeartbeat,tts:ttsHeartbeat},
    signals:{core:'ok',database:'ok',minecraft:!latestWorld.configured?'not_configured':latestWorld.stale?'stale':latestWorld.connected?'connected':'disconnected',bridge:bridgeState,voice:voiceState,engine:engineHeartbeat.state}};
});
app.get('/owner/inspect-context', async req => {
  if (!deps.inspectEvent) throw new DomainError('context_inspection_unavailable');
  const query=z.object({event_id:z.string().uuid().optional()}).strict().parse(req.query);
  const event=await deps.inspectEvent(principal,query.event_id);
  if(!event)return {event:null,turn_input:null,memory_instructions:memoryInstructions,response_instructions:responseInstructions,diagnostics:{reason:'no_pending_event'}};
  const [state,memories,recent,social]=await Promise.all([
    status(principal),search(principal,''),deps.recentConversation(principal,event.id),
    deps.loadSocialMemory?deps.loadSocialMemory(principal,event):Promise.resolve(emptySocialContext())
  ]);
  const bounded=boundSocialContext(social);
  const turnInput=makeTurnInput(event,memories,recent,await currentWorldObservation(),bounded,await deps.loadSharedDesk?.(principal));
  return {event_id:event.id,turn_input:turnInput,memory_instructions:memoryInstructions,response_instructions:responseInstructions,diagnostics:{
    reconstruction:'current_scoped_memory_for_selected_pending_event',
    block_chars:{event:JSON.stringify(turnInput.event).length,memories:JSON.stringify(turnInput.memories).length,
      recent_conversation:JSON.stringify(turnInput.recent_conversation).length,social_memory:bounded.serialized_chars,
      memory_instructions:memoryInstructions.length,response_instructions:responseInstructions.length},
    selected:{facts:bounded.facts.length,relationships:bounded.relationships.length,commitments:bounded.commitments.length},
    omitted:bounded.omitted,other_open_commitment_count:bounded.other_open_commitment_count,
    sources:[...bounded.facts,...bounded.relationships,...bounded.commitments].map(row=>row.source),epoch:state.epoch
  }};
});
app.post('/owner/pause', async () => control(principal, true));
app.post('/owner/resume', async () => control(principal, false));
app.post('/owner/speech', async req => {
  const b=z.object({request_id:z.string().min(1).max(200),text:z.string().min(1).max(300)}).strict().parse(req.body);
  return enqueueSpeech(principal,b.request_id,b.text);
});
app.get('/owner/speech/:id', async req => speechState(principal,z.string().uuid().parse((req.params as {id:string}).id)));
app.post('/owner/speech/:id/cancel', async req => {
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  await speechState(principal,id);
  await pool.query("UPDATE speech_jobs SET state='cancelled',finished_at=now() WHERE id=$1 AND state IN ('pending','claimed','playing')",[id]);
  return speechState(principal,id);
});
app.post('/audio/claim', async () => ({job:await claimSpeech(principal)}));
app.get('/audio/jobs/:id', async req => speechState(principal,z.string().uuid().parse((req.params as {id:string}).id)));
app.post('/audio/jobs/:id', async req => {
  const b=z.object({claim_id:z.string().uuid(),state:z.enum(['playing','completed','failed','cancelled'])}).strict().parse(req.body);
  return updateSpeech(principal,z.string().uuid().parse((req.params as {id:string}).id),b.claim_id,b.state);
});
const ownerChat = {...principal, audienceId: OWNER_CHAT_AUDIENCE};
async function isOwnerChatEvent(eventId:string) {
  const result = await pool.query('SELECT 1 FROM social_events WHERE id=$1 AND character_id=$2 AND audience_id=$3',
    [eventId, principal.characterId, ownerChat.audienceId]);
  return result.rows.length > 0;
}
app.post('/owner/chat', async req => {
  const body = z.object({request_id:z.string().uuid(), text:z.string().trim().min(1).max(4000)}).strict().parse(req.body);
  return ingest(ownerChat, {
    source_key: `owner-dashboard:${body.request_id}`, author_id:'owner-dashboard',
    text:body.text, author_provenance:'owner_input', author_trust:'unverified'
  });
});
app.get('/owner/chat', async (_req, reply) => {
  reply.header('Cache-Control','no-store');
  const read = async (privateChat:boolean) => (await pool.query(`
    SELECT e.id,e.text,e.channel,e.author_provenance,e.created_at,r.text AS reply,
      s.decision AS shadow_decision,s.reason AS shadow_reason,s.latency_ms AS shadow_latency_ms,s.model AS shadow_model,s.scores AS shadow_scores,
      CASE WHEN e.processed AND r.event_id IS NOT NULL THEN 'answered'
           WHEN e.processed THEN 'closed'
           WHEN c.active_event_id=e.id AND c.lease_until>now() AND NOT c.paused THEN 'active'
           WHEN e.attempts>=3 THEN 'failed' ELSE 'queued' END AS status
    FROM social_events e JOIN characters c ON c.id=e.character_id
    LEFT JOIN replies r ON r.event_id=e.id
    LEFT JOIN LATERAL (
      SELECT * FROM shadow_decisions WHERE event_id=e.id
      ORDER BY (model=$4) DESC NULLS LAST, model LIMIT 1
    ) s ON true
    WHERE e.character_id=$1 AND (e.audience_id=$2)=$3
    ORDER BY e.created_at DESC,e.id DESC LIMIT 30
  `,[principal.characterId,ownerChat.audienceId,privateChat,shadowStatus?.().model??null])).rows;
  const [messages,feed] = await Promise.all([read(true),read(false)]);
  return {messages,feed,shadow:shadowStatus?.()??{state:'disabled'}};
});
app.post('/owner/events', async req => {
  const event = z.object({
    source_key: z.string().min(1).max(200), author_id: z.string().min(1).max(200),
    text: z.string().min(1).max(4000), reply_to: z.string().max(200).optional()
  }).strict().parse(req.body);
  return ingest(principal, { ...event, author_provenance: 'owner_input', author_trust: 'unverified' });
});
app.get('/owner/replies', async () => (await pool.query(`SELECT e.id,e.author_id,e.text AS input,r.text AS reply
  FROM social_events e LEFT JOIN replies r ON r.event_id=e.id
  WHERE e.character_id=$1 AND e.audience_id=$2 ORDER BY e.created_at DESC LIMIT 20`, [principal.characterId, principal.audienceId])).rows);
app.get('/engine/input', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if(telegram)await telegram.prepare();
  const event = await nextEvent(principal);
  const state = await status(principal);
  const currentEvent = state.paused ? null : event;
  const scoped=currentEvent?.audience_id?{...principal,audienceId:currentEvent.audience_id}:principal;
  const recent_conversation = currentEvent ? await recentConversation(scoped, currentEvent.id) : [];
  const memories=await search(scoped,'');
  const social_memory=currentEvent?boundSocialContext(deps.loadSocialMemory?await deps.loadSocialMemory(scoped,currentEvent):emptySocialContext()):undefined;
  const world_observation=currentEvent&&currentEvent.channel!=='telegram'?await currentWorldObservation():undefined;
  const turn_input=currentEvent?makeTurnInput(currentEvent,memories,recent_conversation,world_observation,social_memory,await deps.loadSharedDesk?.(scoped)):null;
  return { character: state, audience_id: scoped.audienceId,
    event: currentEvent, memories, recent_conversation, social_memory, world_observation, turn_input, memory_instructions:memoryInstructions,response_instructions:scoped.audienceId===OWNER_CHAT_AUDIENCE
      ? responseInstructions+'\n'+readFileSync(new URL('./owner-dashboard.md',import.meta.url),'utf8')
      : responseInstructions };
});
app.get('/engine/observation',async()=>currentWorldObservation());
app.post('/engine/defer', async req => {
  const body=z.object({event_id:z.string().uuid(),epoch:z.number().int().positive().optional()}).strict().parse(req.body);
  const scoped=telegram&&body.epoch?await telegram.scope(body.event_id,body.epoch):await isOwnerChatEvent(body.event_id)?ownerChat:principal;
  return deps.deferEvent(scoped, body.event_id, body.epoch);
});
app.post('/engine/complete', async req => {
  if(telegram && (req.body as any)?.channel==='telegram') {
    const b=z.object({channel:z.literal('telegram'),event_id:z.string().uuid(),epoch:z.number().int().positive(),decision:z.enum(['reply','silence']),text:z.string().min(1).max(2000).optional()}).strict().parse(req.body);
    return telegram.finish(b.event_id,b.epoch,b.decision,b.text);
  }
  const base={event_id:z.string().uuid(),epoch:z.number().int().positive(),memory_delta:z.unknown().optional()};
  const body=z.union([
    z.object({...base,decision:z.literal('reply'),channel:z.enum(['voice','chat']),text:z.string().trim().min(1).max(256)}).strict(),
    z.object({...base,decision:z.literal('reply'),text:z.string().min(1).max(8000),speak:z.boolean().default(false)}).strict(),
    z.object({...base,decision:z.literal('silent')}).strict(),
    z.object({...base,text:z.string().min(1).max(8000),speak:z.boolean().default(false)}).strict()
  ]).parse(req.body);
  const decision='decision' in body?body.decision:'reply';
  const text='text' in body?body.text:null;
  const channel='channel' in body?body.channel:undefined;
  const speak=channel?channel==='voice':decision==='reply'&&'speak' in body?body.speak:false;
  let delta: ReturnType<typeof SocialMemoryDeltaSchema.parse> | undefined;
  let diagnostic: string | undefined;
  if (Object.hasOwn(body, 'memory_delta')) {
    const parsed = SocialMemoryDeltaSchema.safeParse(body.memory_delta);
    if (parsed.success) delta = parsed.data;
    else diagnostic = 'schema_invalid';
  }
  if(await isOwnerChatEvent(body.event_id))
    return complete(ownerChat, body.event_id, text, body.epoch, false, delta, diagnostic, body.memory_delta, decision, 'local');
  return complete(principal, body.event_id, text, body.epoch, speak, delta, diagnostic, body.memory_delta,decision,channel);
});
async function gateway(scope?: {eventId:string;epoch:number},scopedPrincipal:Principal=principal,isTelegram=false,guard:()=>Promise<unknown>=async()=>{}) {
  const server = new McpServer({ name: 'character-harness', version: '0.1.0' });
  const originalRegister=server.registerTool.bind(server);
  server.registerTool=((name:any,config:any,callback:any)=>originalRegister(name,config,async(...args:any[])=>{await guard();return callback(...args);})) as typeof server.registerTool;
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('agent_get_status', { description: toolDescription('core-read-current-character-status'), inputSchema: {} }, async () => result(await status(principal)));
  if(!isTelegram&&minecraft) server.registerTool('agent_observe',{description:toolDescription('core-read-current-game-state-directly'),inputSchema:{}},async()=>result(await currentWorldObservation()));
  server.registerTool('memory_search', { description: toolDescription('core-search-only-the-current-character'), inputSchema: { query: z.string().max(200).default('') } }, async ({ query }) => result(await search(scopedPrincipal, query)));
  server.registerTool('memory_stage_delta', {
    description: toolDescription('core-stage-one-complete-sourced-memory'),
    inputSchema: { invocation_id: z.string().min(1).max(200), proposal: SocialMemoryProposalSchema }
  }, async ({invocation_id,proposal}) => {
    if(!scope||!deps.stageMemory)return {...result({error:'turn_scope_missing'}),isError:true};
    try{return result(await deps.stageMemory(scopedPrincipal,scope.eventId,scope.epoch,invocation_id,proposal));}
    catch(error){if(error instanceof DomainError)return {...result({error:error.code}),isError:true};throw error;}
  });
  server.registerTool('memory_social_list', {
    description:toolDescription('core-list-open-commitments-for-the'),
    inputSchema:{limit:z.number().int().min(1).max(25).default(10),offset:z.number().int().min(0).max(500).default(0)}
  },async({limit,offset})=>{
    if(!scope||!deps.socialCommitmentPage)return {...result({error:'turn_scope_missing'}),isError:true};
    try{return result(await deps.socialCommitmentPage(scopedPrincipal,scope.eventId,scope.epoch,limit,offset));}
    catch(error){if(error instanceof DomainError)return {...result({error:error.code}),isError:true};throw error;}
  });
  server.registerTool('memory_propose', {
    description: toolDescription('core-save-a-personal-unverified-note'),
    inputSchema: { text: z.string().min(1).max(2000), invocation_id: z.string().min(1).max(200), epoch: z.number().int().positive() }
  }, async ({ text, invocation_id, epoch }) => {
    try { return result(await remember(scopedPrincipal, text, invocation_id, epoch)); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { ...result({ error: error.code }), isError: true };
    }
  });
  const minecraftAllowed=!!minecraft&&(!isTelegram||!!(telegram&&scope&&await telegram.canSendGroup(scopedPrincipal,scope.eventId,scope.epoch)));
  if(!isTelegram&&minecraft&&allowClientWorld&&deps.latestWorldObservation&&deps.enqueueClientAction&&deps.clientActionStatus)server.registerTool('agent_approach_player',{
   description:toolDescription('core-approach-a-visible-nearby-player'),
   inputSchema:{name:z.string().regex(/^[A-Za-z0-9_]{1,16}$/),invocation_id:z.string().min(1).max(160),expected_epoch:z.number().int().positive()}
  },async({name,invocation_id,expected_epoch})=>{
   const outcome=await approachPlayer(name,{
    observe:()=>deps.latestWorldObservation!(principal),pathStatus:()=>minecraft.navigationStatus(),
    navigate:p=>minecraft.call('gotoXYZ',{x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)},`${invocation_id}:navigate`,expected_epoch,guard),
    stop:()=>minecraft.stop(),turn:(degrees,index)=>deps.enqueueClientAction!(principal,`${invocation_id}:turn:${index}`,'turn',{yaw_degrees:degrees,pitch_degrees:0},0,expected_epoch),
    turnStatus:id=>deps.clientActionStatus!(principal,id),guard,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),now:()=>Date.now()
   });return {...result(outcome),...(outcome.state==='failed'?{isError:true}:{})};
  });
  if(minecraftAllowed&&minecraft){
   server.registerTool('minecraft_tools',{description:toolDescription('core-list-the-complete-live-unionclef'),inputSchema:{}},async()=>result(await minecraft.catalog()));
   server.registerTool('minecraft_call',{description:toolDescription('core-call-any-tool-published-by'),inputSchema:{name:z.string().min(1).max(100),arguments:z.record(z.string(),z.unknown()).default({}),invocation_id:z.string().min(1).max(200),expected_epoch:z.number().int().positive()}},async({name,arguments:args,invocation_id,expected_epoch})=>{
    try{const value=await minecraft.call(name,args,invocation_id,expected_epoch,guard) as any;return {...result(value),...(value.result?.isError?{isError:true}:{})};}catch{return {...result({error:'minecraft_call_failed_or_unknown',retry:false}),isError:true};}
   });
   server.registerTool('minecraft_stop',{description:toolDescription('core-request-stop-of-minecraft-navigation'),inputSchema:{}},async()=>{try{return result(await minecraft.stop());}catch{return {...result({error:'minecraft_stop_unconfirmed'}),isError:true};}});
   if(isTelegram)server.registerTool('agent_observe',{description:toolDescription('core-read-current-game-state-directly-2'),inputSchema:{}},async()=>result(await currentWorldObservation()));
  }
  if(!isTelegram && deps.enqueueClientAction && deps.clientActionStatus) server.registerTool('agent_turn', {
    description: toolDescription('core-turn-the-local-character-camera'),
    inputSchema: { yaw_degrees:z.number().min(-90).max(90), pitch_degrees:z.number().min(-30).max(30), invocation_id:z.string().min(1).max(200), expected_epoch:z.number().int().positive() }
  }, async ({yaw_degrees,pitch_degrees,invocation_id,expected_epoch}) => {
    if (!allowClientWorld) return { ...result({error:'client_world_disabled'}), isError:true };
    if (yaw_degrees === 0 && pitch_degrees === 0) return { ...result({error:'empty_turn'}), isError:true };
    try { return result(await deps.enqueueClientAction!(principal,invocation_id,'turn',{yaw_degrees,pitch_degrees},0,expected_epoch)); }
    catch (error) { if (!(error instanceof DomainError)) throw error; return { ...result({error:error.code}), isError:true }; }
  });
  if(!isTelegram && deps.enqueueClientAction && deps.clientActionStatus) server.registerTool('agent_action_status', {
    description:toolDescription('core-read-the-status-and-local'),
    inputSchema:{id:z.string().uuid()}
  }, async ({id}) => {
    try { const current=await deps.clientActionStatus!(principal,id);return result(allowClientWorld?current:{...current,allowed:false}); }
    catch (error) { if (!(error instanceof DomainError)) throw error; return { ...result({error:error.code}), isError:true }; }
  });
  if(isTelegram && images && scope){
   server.registerTool('image_generation_status',{description:toolDescription('core-read-shared-image-job-usage'),inputSchema:{}},async()=>result(await images.status(scopedPrincipal)));
   server.registerTool('image_generate',{description:toolDescription('core-queue-one-image-as-a'),inputSchema:{prompt:z.string().trim().min(1).max(1500),caption:z.string().max(500).default('')}},async({prompt,caption})=>{
    try{return result(await images.queue(scopedPrincipal,scope.eventId,scope.epoch,prompt,caption));}
    catch(e){if(e instanceof DomainError)return {...result({error:e.code}),isError:true};throw e;}
   });
  }
  if(isTelegram&&telegram&&scope&&await telegram.canSendGroup(scopedPrincipal,scope.eventId,scope.epoch)){
   server.registerTool('telegram_send_group',{description:toolDescription('core-send-one-short-message-to'),inputSchema:{text:z.string().trim().min(1).max(1000),group_ref:z.string().max(256).optional()}},async({text,group_ref})=>{
    try{return result(await telegram.sendGroup(scopedPrincipal,scope.eventId,scope.epoch,text,group_ref));}catch(e){if(e instanceof DomainError)return {...result(directedErrorDetail(e)),isError:true};throw e;}
   });
   server.registerTool('telegram_groups',{description:toolDescription('core-list-approved-group-destinations-for'),inputSchema:{}},async()=>{
    try{return result(await telegram.approvedGroups(scopedPrincipal,scope.eventId,scope.epoch));}catch(e){if(e instanceof DomainError)return {...result({error:e.code}),isError:true};throw e;}
   });
   server.registerTool('telegram_group_delivery' ,{description:toolDescription('core-check-a-group-send-requested'),inputSchema:{id:z.uuid()}},async({id})=>{
    try{return result(await telegram.groupDelivery(scopedPrincipal,scope.eventId,scope.epoch,id));}catch(e){if(e instanceof DomainError)return {...result({error:e.code}),isError:true};throw e;}
   });
  }
  if(isTelegram&&telegram&&scope&&await telegram.canReadGroup(scopedPrincipal,scope.eventId,scope.epoch))server.registerTool('telegram_group_participants',{description:toolDescription('core-query-current-available-participants-on'),inputSchema:{group_ref:z.string().max(256).optional()}},async({group_ref})=>{
   try{return result(await telegram.groupParticipants(scopedPrincipal,scope.eventId,scope.epoch,group_ref));}catch(e){if(e instanceof DomainError)return {...result({error:e.code}),isError:true};throw e;}
  });
  if(isTelegram&&telegram&&scope&&await telegram.canReadGroup(scopedPrincipal,scope.eventId,scope.epoch))server.registerTool('telegram_member_profile',{description:toolDescription('core-read-available-bio-and-current'),inputSchema:{participant:z.string().trim().min(1).max(128),group_ref:z.string().max(256).optional()}},async({participant,group_ref})=>{
   try{const profile=await telegram.memberProfile(scopedPrincipal,scope.eventId,scope.epoch,participant,group_ref);const {photo,...metadata}=profile;return {content:[{type:'text' as const,text:JSON.stringify({...metadata,photo_available:!!photo})},...(photo?[{type:'image' as const,data:photo.data,mimeType:photo.mime}]:[])]};}catch(e){if(e instanceof DomainError)return {...result({error:e.code}),isError:true};throw e;}
  });
  if(isTelegram && telegram)server.registerTool('telegram_read_history',{
    description:toolDescription('core-read-the-bounded-local-journal'),
    inputSchema:{limit:z.number().int().min(1).max(20).default(20),before:z.string().regex(/^\d+$/).max(18).optional()}
  },async({before,limit})=>result(await telegram.history(scopedPrincipal,before,limit)));
  return server;
}
app.post('/mcp', async (req, reply) => {
  const eventId=typeof req.headers['x-harness-event']==='string'?req.headers['x-harness-event']:undefined;
  const epochHeader=typeof req.headers['x-harness-epoch']==='string'?req.headers['x-harness-epoch']:undefined;
  const scope=eventId&&z.string().uuid().safeParse(eventId).success&&epochHeader&&/^\d+$/.test(epochHeader)?{eventId,epoch:Number(epochHeader)}:undefined;
  let scopedPrincipal:Principal=principal;let isTelegram=false;
  let guard:()=>Promise<unknown>=async()=>{};
  if(telegram){
    if(!scope)throw new DomainError('turn_scope_missing');
    const current=await telegram.scope(scope.eventId,scope.epoch);scopedPrincipal=current;isTelegram=current.channel==='telegram';
    guard=()=>telegram.scope(scope.eventId,scope.epoch);
  }
  if(!telegram && scope && await isOwnerChatEvent(scope.eventId)) scopedPrincipal=ownerChat;
  const legacyGuard=guard;
  guard=async()=>{if(runtimeEngine)await runtimeEngine.assertLegacyTurn(principal);await legacyGuard();};
  if(runtimeEngine)await runtimeEngine.assertLegacyTurn(principal);
  const server = await gateway(scope,scopedPrincipal,isTelegram,guard);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  reply.hijack();
  reply.raw.on('close', () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req.raw, reply.raw, req.body); }
  catch { if (!reply.raw.headersSent) { reply.raw.writeHead(500); reply.raw.end(); } }
});
app.route({ method: ['GET', 'DELETE'], url: '/mcp', handler: async (_req, reply) => reply.code(405).send({ error: 'stateless_transport' }) });
const shutdown = async () => { await app.close(); await pool.end(); };
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
});
return app;
}
