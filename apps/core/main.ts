import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { secret } from '../../packages/domain/secrets.ts';
import { DomainError, matchesToken } from '../../packages/domain/policy.ts';
import { pool, status, search, remember, control, ingest, nextEvent, complete } from '../../packages/storage/db.ts';
import { enqueueSpeech, claimSpeech, speechState, updateSpeech } from '../../packages/storage/speech.ts';

const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 64 * 1024 });
const principal = { characterId: process.env.CHARACTER_ID ?? 'sever', audienceId: process.env.AUDIENCE_ID ?? 'demo-public' };
const engineToken = secret('ENGINE_TOKEN');
const ownerToken = secret('OWNER_TOKEN');
const audioToken = secret('AUDIO_TOKEN');
const bridgeToken = secret('BRIDGE_TOKEN');
if (audioToken.length < 32 || audioToken === ownerToken || audioToken === engineToken) throw new Error('Distinct audio token required');
if (bridgeToken.length < 32 || new Set([bridgeToken, ownerToken, engineToken, audioToken]).size !== 4) throw new Error('Distinct bridge token required');
if (engineToken.length < 32 || ownerToken.length < 32 || engineToken === ownerToken) throw new Error('Distinct tokens of at least 32 characters required');
const character = z.object({ id: z.string(), name: z.string(), persona: z.string() }).parse(
  JSON.parse(await readFile(process.env.CHARACTER_FILE ?? 'characters/sever.json', 'utf8')));
if (character.id !== principal.characterId) throw new Error('Character binding mismatch');
await pool.query(`INSERT INTO characters(id,name,persona) VALUES($1,$2,$3)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,persona=excluded.persona`, [character.id, character.name, character.persona]);
app.addHook('onRequest', async (req, reply) => {
  // No browser access is needed in this slice. Reject Origin instead of offering permissive CORS.
  if (req.headers.origin) return reply.code(403).send({ error: 'browser_access_disabled' });
  if (req.url === '/health') return;
  const required = req.url.startsWith('/owner/') ? ownerToken : req.url.startsWith('/audio/') ? audioToken : req.url.startsWith('/bridge/') ? bridgeToken : engineToken;
  if (!matchesToken(req.headers.authorization, required)) return reply.code(401).send({ error: 'unauthorized' });
});
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof DomainError) return reply.code(409).send({ error: error.code });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_input' });
  app.log.error({ name: error instanceof Error ? error.name : 'unknown' }, 'Request failed');
  return reply.code(500).send({ error: 'internal_error' });
});
app.get('/health', async () => ({ alive: true }));
app.get('/ready', async () => { await pool.query('SELECT 1'); return { ready: true }; });
app.get('/engine/status', async () => status(principal));
app.get('/owner/status', async () => ({ character: await status(principal), audience: principal.audienceId, adapters: { minecraft: 'not_implemented', telegram: 'not_implemented', voice: 'not_implemented' } }));
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
app.post('/owner/events', async req => ingest(principal, z.object({
  source_key: z.string().min(1).max(200), author_id: z.string().min(1).max(200),
  text: z.string().min(1).max(4000), reply_to: z.string().max(200).optional()
}).strict().parse(req.body)));
app.post('/bridge/events', async req => ingest(principal, z.object({
  source_key:z.string().regex(/^minecraft:[^\s]{1,300}$/), author_id:z.string().uuid(),
  text:z.string().min(1).max(1000)
}).strict().parse(req.body)));
app.get('/bridge/replies', async () => (await pool.query(`SELECT e.id,e.author_id,r.text
  FROM social_events e JOIN replies r ON r.event_id=e.id
  WHERE e.character_id=$1 AND e.audience_id=$2 AND e.source_key LIKE 'minecraft:%' AND NOT e.reply_delivered
  ORDER BY e.created_at,e.id LIMIT 20`,[principal.characterId,principal.audienceId])).rows);
app.post('/bridge/replies/:id/ack', async req => {
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const result=await pool.query(`UPDATE social_events SET reply_delivered=true
    WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND source_key LIKE 'minecraft:%' AND processed
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
  return { character: state, audience_id: principal.audienceId,
    event: state.paused ? null : event, memories: await search(principal, '') };
});
app.post('/engine/complete', async req => {
  const body = z.object({ event_id: z.string().uuid(), text: z.string().min(1).max(8000), epoch: z.number().int().positive(), speak: z.boolean().default(false) }).strict().parse(req.body);
  await complete(principal, body.event_id, body.text, body.epoch, body.speak);
  return { saved: true };
});
function gateway() {
  const server = new McpServer({ name: 'character-harness', version: '0.1.0' });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.registerTool('agent_get_status', { description: 'Read current character status', inputSchema: {} }, async () => result(await status(principal)));
  server.registerTool('memory_search', { description: 'Search only the current character and audience memory', inputSchema: { query: z.string().max(200).default('') } }, async ({ query }) => result(await search(principal, query)));
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
  return server;
}
app.post('/mcp', async (req, reply) => {
  const server = gateway();
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
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
