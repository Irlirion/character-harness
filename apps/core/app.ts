import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Principal } from '../../packages/domain/policy.ts';
import { DomainError, matchesToken, requestPath, requiredRole } from '../../packages/domain/policy.ts';
import { BridgeEventScopeError, parseBridgeEvent } from '../../packages/domain/bridge-event.ts';
import { SocialMemoryDeltaSchema } from '../../packages/domain/social-memory.ts';
import { SocialMemoryProposalSchema } from '../../packages/domain/social-memory.ts';
import { boundSocialContext, makeTurnInput, type SocialContextInput } from '../../packages/domain/conversation-context.ts';
import type { ClientActionKind } from '../../packages/storage/actions.ts';
import { isObservationTimeCurrent, worldObservationSchema } from '../../packages/domain/world-observation.ts';
import { SYSTEM_CHAT_SERVER } from '../../packages/domain/bridge-event.ts';
import type { WorldObservation } from '../../packages/domain/world-observation.ts';

export type CoreTokens = { engine: string; owner: string; audio: string; bridge: string };
export type CoreDeps = {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; end: () => Promise<void> };
  status: (p: Principal) => Promise<any>;
  search: (p: Principal, query: string) => Promise<any>;
  remember: (p: Principal, text: string, invocationId: string, epoch: number) => Promise<any>;
  control: (p: Principal, paused: boolean) => Promise<any>;
  ingest: (p: Principal, event: any) => Promise<{ inserted: boolean; event_id: string | null }>;
  nextEvent: (p: Principal) => Promise<any>;
  recentConversation: (p: Principal, currentEventId: string) => Promise<any>;
  loadSocialMemory?: (p: Principal, event: any) => Promise<SocialContextInput>;
  inspectEvent?: (p: Principal, eventId?: string) => Promise<any>;
  stageMemory?: (p: Principal, eventId: string, epoch: number, invocationId: string, proposal: unknown) => Promise<any>;
  socialCommitmentPage?: (p:Principal,eventId:string,epoch:number,limit:number,offset:number)=>Promise<any>;
  complete: (p: Principal, eventId: string, text: string | null, epoch: number, speak?: boolean, delta?: any, deltaDiagnostic?: string, rawDelta?: unknown, decision?: 'reply'|'silent') => Promise<any>;
  deferEvent: (p: Principal, eventId: string, epoch?: number) => Promise<any>;
  enqueueSpeech: (p: Principal, requestId: string, text: string) => Promise<any>;
  claimSpeech: (p: Principal) => Promise<any>;
  speechState: (p: Principal, id: string) => Promise<any>;
  updateSpeech: (p: Principal, id: string, claimId: string, state: 'playing' | 'completed' | 'failed' | 'cancelled') => Promise<any>;
  enqueueClientAction: (p: Principal, invocationId: string, kind: ClientActionKind, args: Record<string, number>, durationMs: number, epoch: number) => Promise<any>;
  clientActionStatus: (p: Principal, id: string) => Promise<any>;
  clientActionLease: (p: Principal, id: string, claimId: string) => Promise<any>;
  claimClientAction: (p: Principal) => Promise<any>;
  finishClientAction: (p: Principal, id: string, claimId: string, state: 'completed'|'failed'|'cancelled', evidence: unknown) => Promise<any>;
  saveWorldObservation: (p:Principal,o:WorldObservation)=>Promise<any>;
  latestWorldObservation: (p:Principal)=>Promise<any>;
  cancelClientActions: (p:Principal)=>Promise<any>;
};
export type BuildAppOptions = {
  principal: Principal;
  tokens: CoreTokens;
  allowSystemChatPublicDemo: boolean;
  allowClientWorld?: boolean;
  deps: CoreDeps;
  memoryInstructions?: string;
  responseInstructions?: string;
};

function emptySocialContext(): SocialContextInput {
  return {working_state:null,current_person:null,facts:[],relationships:[],commitments:[],other_open_commitment_count:0,counts:{facts:0,relationships:0,commitments:0}};
}

/** Builds the HTTP surface. Environment, secrets and the database stay in main.ts. */
export function buildApp({ principal, tokens, allowSystemChatPublicDemo, allowClientWorld = false, deps, memoryInstructions = '', responseInstructions = '' }: BuildAppOptions): FastifyInstance {
const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 64 * 1024 });
// Roles share a token, so budget by role rather than IP or attacker-supplied headers.
// Audio and action leases poll frequently; keep bridge event ingestion in its own budget.
function rateBudget(path: string) {
  if (path === '/bridge/events') return { key: 'bridge-events', max: 180 };
  const role = requiredRole(path) ?? 'owner';
  return { key: role, max: { audio: 600, engine: 300, bridge: 900, owner: 120 }[role] };
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
  enqueueSpeech, claimSpeech, speechState, updateSpeech, enqueueClientAction, clientActionStatus, clientActionLease, claimClientAction, finishClientAction,
  saveWorldObservation,latestWorldObservation,cancelClientActions } = deps;
async function currentWorldObservation() {
  if (!allowClientWorld) return { available:false, stale:true, connected:false, disabled:true };
  const current=await latestWorldObservation(principal);
  if (!current.available) return { available:false, stale:true, connected:false };
  if (!current.stale && current.connected && current.server===SYSTEM_CHAT_SERVER && current.snapshot) {
    return { available:true, stale:false, connected:true, session_id:current.session_id, server:current.server,
      age_ms:current.age_ms, snapshot:current.snapshot };
  }
  return { available:true, stale:current.stale, connected:false, server:current.server??null,
    age_ms:current.age_ms };
}
app.addHook('onRequest', async (req, reply) => {
  // No browser access is needed in this slice. Reject Origin instead of offering permissive CORS.
  if (req.headers.origin) return reply.code(403).send({ error: 'browser_access_disabled' });
  const path = requestPath(req.url);
  if (path === '/health') return;
  // Derive the required token from the resolved path, never from the raw request target:
  // an unmatched path has no role and must not fall back to the engine token.
  const role = requiredRole(path);
  const required = role === 'owner' ? ownerToken : role === 'audio' ? audioToken : role === 'bridge' ? bridgeToken : role === 'engine' ? engineToken : null;
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
app.get('/health', async () => ({ alive: true }));
app.get('/ready', async () => { await pool.query('SELECT 1'); return { ready: true }; });
app.get('/engine/status', async () => status(principal));
app.get('/owner/status', async () => ({ character: await status(principal), audience: principal.audienceId, adapters: { minecraft: 'not_implemented', telegram: 'not_implemented', voice: 'not_implemented' } }));
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
  const turnInput=makeTurnInput(event,memories,recent,await currentWorldObservation(),bounded);
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
app.post('/owner/events', async req => {
  const event = z.object({
    source_key: z.string().min(1).max(200), author_id: z.string().min(1).max(200),
    text: z.string().min(1).max(4000), reply_to: z.string().max(200).optional()
  }).strict().parse(req.body);
  return ingest(principal, { ...event, author_provenance: 'owner_input', author_trust: 'unverified' });
});
app.post('/bridge/events', async (req, reply) => {
  let event;
  try { event = parseBridgeEvent(req.body, allowSystemChatPublicDemo, principal.audienceId); }
  catch (error) {
    if (error instanceof BridgeEventScopeError) {
      req.log.warn({ reason: error.message }, 'Rejected unverified public event');
      return reply.code(403).send({ error: error.message });
    }
    throw error;
  }
  return ingest(principal, event);
});
app.post('/bridge/observation', async req => {
  if (!allowClientWorld) throw new DomainError('client_world_disabled');
  const observation=worldObservationSchema.parse(req.body);
  if(JSON.stringify(observation).length>16_384)throw new DomainError('observation_too_large');
  if(!isObservationTimeCurrent(observation.observed_at))throw new DomainError('observation_time_outside_window');
  return saveWorldObservation(principal,observation);
});
app.post('/bridge/actions/claim', async () => {
  if (!allowClientWorld) { await cancelClientActions(principal); return { action:null }; }
  return { action: await claimClientAction(principal) };
});
app.post('/bridge/actions/:id/lease', async req => {
  const id = z.string().uuid().parse((req.params as {id:string}).id);
  const b = z.object({claim_id:z.string().uuid()}).strict().parse(req.body);
  if (!allowClientWorld) return { valid: false };
  return clientActionLease(principal,id,b.claim_id);
});
app.post('/bridge/actions/:id', async req => {
  const id = z.string().uuid().parse((req.params as {id:string}).id);
  const coordinate=z.number().finite().min(-30_000_000).max(30_000_000);const yCoordinate=z.number().finite().min(-4096).max(4096);
  const evidenceSchema=z.object({kind:z.enum(['walk','turn']).optional(),reason:z.enum(['action_expired_before_start','client_not_ready','movement_input_busy','unsupported_action','invalid_walk_bounds','invalid_turn_bounds','unsafe_or_unsupported_step','step_became_unsafe','action_expired_mid_descent','player_flying','client_disconnected','screen_opened','world_session_mismatch','action_lease_stale','action_lease_revoked','action_expired_or_no_movement','no_position_change','rotation_not_observed','client_action_busy','test_server_gate_closed','initial_lease_invalid']).optional(),
    on_ground:z.boolean().optional(),collision_ahead:z.boolean().optional(),support_ahead:z.boolean().optional(),
    step_status:z.enum(['clear','not_grounded','collision','no_support','unknown_chunk']).optional(),
    obstacle_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),estimated_step_up:z.number().finite().min(0).max(2).optional(),
    nearest_support_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),nearest_support_drop:z.number().finite().min(0).max(3).optional(),
    start_x:coordinate.optional(),start_y:yCoordinate.optional(),start_z:coordinate.optional(),end_x:coordinate.optional(),end_y:yCoordinate.optional(),end_z:coordinate.optional(),
    start_yaw:z.number().finite().min(-360).max(360).optional(),end_yaw:z.number().finite().min(-360).max(360).optional(),
    start_pitch:z.number().finite().min(-90).max(90).optional(),end_pitch:z.number().finite().min(-90).max(90).optional()}).strict();
  const b = z.object({claim_id:z.string().uuid(),state:z.enum(['completed','failed','cancelled']),evidence:evidenceSchema.optional()}).strict().parse(req.body);
  return finishClientAction(principal,id,b.claim_id,allowClientWorld?b.state:'cancelled',b.evidence ?? {});
});
app.get('/bridge/replies', async () => (await pool.query(`SELECT e.id,e.author_id,r.text
  FROM social_events e JOIN replies r ON r.event_id=e.id
  WHERE e.character_id=$1 AND e.audience_id=$2 AND (e.source_key LIKE 'minecraft:%' OR e.source_key LIKE 'minecraft-system:%' OR e.source_key LIKE 'minecraft-voice:%') AND NOT e.reply_delivered
  ORDER BY e.created_at,e.id LIMIT 20`,[principal.characterId,principal.audienceId])).rows);
app.post('/bridge/replies/:id/ack', async req => {
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const result=await pool.query(`UPDATE social_events SET reply_delivered=true
    WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND (source_key LIKE 'minecraft:%' OR source_key LIKE 'minecraft-system:%' OR source_key LIKE 'minecraft-voice:%') AND processed
    AND EXISTS(SELECT 1 FROM replies WHERE event_id=$1)`,[id,principal.characterId,principal.audienceId]);
  if(!result.rowCount)throw new DomainError('reply_not_found');
  return {acknowledged:true};
});
app.get('/owner/replies', async () => (await pool.query(`SELECT e.id,e.author_id,e.text AS input,r.text AS reply
  FROM social_events e LEFT JOIN replies r ON r.event_id=e.id
  WHERE e.character_id=$1 AND e.audience_id=$2 ORDER BY e.created_at DESC LIMIT 20`, [principal.characterId, principal.audienceId])).rows);
app.get('/engine/input', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store');
  const event = await nextEvent(principal);
  const state = await status(principal);
  const currentEvent = state.paused ? null : event;
  const recent_conversation = currentEvent ? await recentConversation(principal, currentEvent.id) : [];
  const memories=await search(principal,'');
  const social_memory=currentEvent?boundSocialContext(deps.loadSocialMemory?await deps.loadSocialMemory(principal,currentEvent):emptySocialContext()):undefined;
  const world_observation=currentEvent?await currentWorldObservation():undefined;
  const turn_input=currentEvent?makeTurnInput(currentEvent,memories,recent_conversation,world_observation,social_memory):null;
  return { character: state, audience_id: principal.audienceId,
    event: currentEvent, memories, recent_conversation, social_memory, world_observation, turn_input, memory_instructions:memoryInstructions,response_instructions:responseInstructions };
});
app.get('/engine/observation',async()=>currentWorldObservation());
app.post('/engine/defer', async req => {
  const body=z.object({event_id:z.string().uuid(),epoch:z.number().int().positive().optional()}).strict().parse(req.body);
  return deps.deferEvent(principal, body.event_id, body.epoch);
});
app.post('/engine/complete', async req => {
  const base={event_id:z.string().uuid(),epoch:z.number().int().positive(),memory_delta:z.unknown().optional()};
  const body=z.union([
    z.object({...base,decision:z.literal('reply'),text:z.string().min(1).max(8000),speak:z.boolean().default(false)}).strict(),
    z.object({...base,decision:z.literal('silent')}).strict(),
    z.object({...base,text:z.string().min(1).max(8000),speak:z.boolean().default(false)}).strict()
  ]).parse(req.body);
  const decision='decision' in body?body.decision:'reply';
  const text='text' in body?body.text:null;
  const speak=decision==='reply'&&'speak' in body?body.speak:false;
  let delta: ReturnType<typeof SocialMemoryDeltaSchema.parse> | undefined;
  let diagnostic: string | undefined;
  if (Object.hasOwn(body, 'memory_delta')) {
    const parsed = SocialMemoryDeltaSchema.safeParse(body.memory_delta);
    if (parsed.success) delta = parsed.data;
    else diagnostic = 'schema_invalid';
  }
  return complete(principal, body.event_id, text, body.epoch, speak, delta, diagnostic, body.memory_delta,decision);
});
function gateway(scope?: {eventId:string;epoch:number}) {
  const server = new McpServer({ name: 'character-harness', version: '0.1.0' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('agent_get_status', { description: 'Read current character status', inputSchema: {} }, async () => result(await status(principal)));
  server.registerTool('agent_observe',{description:'Read a compact bounded local client snapshot. It may be stale and is not server-authoritative or a full world map. nearest_support_block_id/drop are diagnostic; support_ahead confirms a loaded collision top within the lesser of the effective player safe-fall distance and 3 blocks.',inputSchema:{}},async()=>result(await currentWorldObservation()));
  server.registerTool('memory_search', { description: 'Search only the current character and audience memory', inputSchema: { query: z.string().max(200).default('') } }, async ({ query }) => result(await search(principal, query)));
  server.registerTool('memory_stage_delta', {
    description: 'Stage one complete sourced memory proposal for this active turn. A later call replaces the earlier staged proposal. Core supplies participant identity, source, audience, epoch, and version. Never include the proposal in your reply.',
    inputSchema: { invocation_id: z.string().min(1).max(200), proposal: SocialMemoryProposalSchema }
  }, async ({invocation_id,proposal}) => {
    if(!scope||!deps.stageMemory)return {...result({error:'turn_scope_missing'}),isError:true};
    try{return result(await deps.stageMemory(principal,scope.eventId,scope.epoch,invocation_id,proposal));}
    catch(error){if(error instanceof DomainError)return {...result({error:error.code}),isError:true};throw error;}
  });
  server.registerTool('memory_social_list', {
    description:'List open commitments for the current unverified participant, with bounded pagination. Use when the context reports omitted commitments.',
    inputSchema:{limit:z.number().int().min(1).max(25).default(10),offset:z.number().int().min(0).max(500).default(0)}
  },async({limit,offset})=>{
    if(!scope||!deps.socialCommitmentPage)return {...result({error:'turn_scope_missing'}),isError:true};
    try{return result(await deps.socialCommitmentPage(principal,scope.eventId,scope.epoch,limit,offset));}
    catch(error){if(error instanceof DomainError)return {...result({error:error.code}),isError:true};throw error;}
  });
  server.registerTool('memory_propose', {
    description: 'Save a personal, unverified note for this audience; do not save secrets or treat guesses as facts',
    inputSchema: { text: z.string().min(1).max(2000), invocation_id: z.string().min(1).max(200), epoch: z.number().int().positive() }
  }, async ({ text, invocation_id, epoch }) => {
    try { return result(await remember(principal, text, invocation_id, epoch)); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { ...result({ error: error.code }), isError: true };
    }
  });
  server.registerTool('agent_walk', {
    description: 'Walk briefly using normal client movement keys. Start only while grounded. forward is -1 backward, 0 neutral, 1 forward; strafe is -1 left, 0 neutral, 1 right. Both axes may be combined. A controlled downward step may briefly be airborne only while descending toward confirmed loaded support within the lesser of effective safe fall distance and 3 blocks. Never jump, sprint, break blocks, or interact. This queues an action; use agent_action_status and claim success only after state=completed. Maximum 1200 ms.',
    inputSchema: { forward:z.number().int().min(-1).max(1), strafe:z.number().int().min(-1).max(1), duration_ms:z.number().int().min(100).max(1200), invocation_id:z.string().min(1).max(200), expected_epoch:z.number().int().positive() }
  }, async ({forward,strafe,duration_ms,invocation_id,expected_epoch}) => {
    if (!allowClientWorld) return { ...result({error:'client_world_disabled'}), isError:true };
    if (forward === 0 && strafe === 0) return { ...result({error:'empty_movement'}), isError:true };
    try { return result(await enqueueClientAction(principal,invocation_id,'walk',{forward,strafe},duration_ms,expected_epoch)); }
    catch (error) { if (!(error instanceof DomainError)) throw error; return { ...result({error:error.code}), isError:true }; }
  });
  server.registerTool('agent_turn', {
    description: 'Turn the local character camera by a small relative yaw/pitch; this does not require grounded/support/collision checks (those gate walking only). Positive Minecraft yaw turns west; negative yaw turns east. Use a nearby player bearing_degrees as the relative yaw target. Maximum per call is 90 degrees yaw and 30 degrees pitch; if the target bearing exceeds that, turn by 90 degrees toward the target, observe again, then turn the remainder. This queues an action; use agent_action_status and only say it succeeded after state=completed. No teleport or chat commands.',
    inputSchema: { yaw_degrees:z.number().min(-90).max(90), pitch_degrees:z.number().min(-30).max(30), invocation_id:z.string().min(1).max(200), expected_epoch:z.number().int().positive() }
  }, async ({yaw_degrees,pitch_degrees,invocation_id,expected_epoch}) => {
    if (!allowClientWorld) return { ...result({error:'client_world_disabled'}), isError:true };
    if (yaw_degrees === 0 && pitch_degrees === 0) return { ...result({error:'empty_turn'}), isError:true };
    try { return result(await enqueueClientAction(principal,invocation_id,'turn',{yaw_degrees,pitch_degrees},0,expected_epoch)); }
    catch (error) { if (!(error instanceof DomainError)) throw error; return { ...result({error:error.code}), isError:true }; }
  });
  server.registerTool('agent_action_status', {
    description:'Read the status and local client evidence for one of your previously queued walk/turn operations. For blocked walking, explain step_status, obstacle_block_id/estimated_step_up, and nearest_support_block_id/drop when present; these are bounded diagnostics, not permission to step over a block. A walk that expires while airborne is cancelled, never reported completed. The crosshair target is not necessarily the obstacle. Only state=completed proves it succeeded.',
    inputSchema:{id:z.string().uuid()}
  }, async ({id}) => {
    try { const current=await clientActionStatus(principal,id);return result(allowClientWorld?current:{...current,allowed:false}); }
    catch (error) { if (!(error instanceof DomainError)) throw error; return { ...result({error:error.code}), isError:true }; }
  });
  return server;
}
app.post('/mcp', async (req, reply) => {
  const eventId=typeof req.headers['x-harness-event']==='string'?req.headers['x-harness-event']:undefined;
  const epochHeader=typeof req.headers['x-harness-epoch']==='string'?req.headers['x-harness-epoch']:undefined;
  const scope=eventId&&z.string().uuid().safeParse(eventId).success&&epochHeader&&/^\d+$/.test(epochHeader)?{eventId,epoch:Number(epochHeader)}:undefined;
  const server = gateway(scope);
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
