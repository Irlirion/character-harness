import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { assertActive, DomainError } from '../domain/policy.ts';
import type { Principal } from '../domain/policy.ts';
import { SocialMemoryDeltaSchema, SocialMemoryProposalSchema, type SocialMemoryDelta } from '../domain/social-memory.ts';
import type { SocialContextInput } from '../domain/conversation-context.ts';

export type DeltaResult = { status: 'accepted' | 'rejected'; reason?: string; state_version?: number };

function sourceType(key: string) {
  return key.startsWith('minecraft-system:') ? 'minecraft_system' : key.startsWith('minecraft:') ? 'minecraft' : key.startsWith('telegram:') ? 'telegram' : 'owner';
}

/** Read-only audience scoped data for the common bounded turn context. */
export async function loadSocialContext(query: pg.Pool | pg.PoolClient, p: Principal, event: { author_id: string; source_key: string }): Promise<SocialContextInput> {
  const channel = sourceType(event.source_key);
  const personResult = await query.query(`SELECT id,display_name,identity_status FROM social_people
    WHERE character_id=$1 AND audience_id=$2 AND channel=$3 AND external_id=$4`, [p.characterId, p.audienceId, channel, event.author_id]);
  const person = personResult.rows[0];
  const stateResult = await query.query(`SELECT version,topic,goal,open_questions,commitment_keys,last_event_id
    FROM social_working_states WHERE character_id=$1 AND audience_id=$2`, [p.characterId,p.audienceId]);
  const state = stateResult.rows[0] ? {
    ...stateResult.rows[0], version: Number(stateResult.rows[0].version),
    open_questions: stateResult.rows[0].open_questions ?? [], commitment_keys: stateResult.rows[0].commitment_keys ?? []
  } : null;
  const currentPerson = person ? { display_name: person.display_name, identity_status: 'unverified' as const } : null;
    const [factsResult, relationshipsResult, commitmentsResult, allOpenResult] = await Promise.all([
    person ? query.query(`SELECT f.content,f.confidence,f.epistemic_status,e.id AS event_id,e.source_key,e.author_provenance,e.created_at,
        count(*) OVER()::int AS total
      FROM social_facts f JOIN social_events e ON e.id=f.source_event_id AND e.character_id=f.character_id AND e.audience_id=f.audience_id
      WHERE f.character_id=$1 AND f.audience_id=$2 AND f.person_id=$3
      ORDER BY f.created_at DESC LIMIT 100`,[p.characterId,p.audienceId,person.id]) : Promise.resolve({rows:[],rowCount:0}),
    person ? query.query(`SELECT r.note,r.version,e.id AS event_id,e.source_key,e.author_provenance,e.created_at,
        count(*) OVER()::int AS total
      FROM social_relationships r JOIN social_events e ON e.id=r.source_event_id AND e.character_id=r.character_id AND e.audience_id=r.audience_id
      WHERE r.character_id=$1 AND r.audience_id=$2 AND r.person_id=$3
      ORDER BY r.version DESC LIMIT 100`,[p.characterId,p.audienceId,person.id]) : Promise.resolve({rows:[],rowCount:0}),
    person ? query.query(`SELECT DISTINCT ON (c.commitment_key) c.commitment_key AS key,c.description,c.status,c.due_at,
        e.id AS event_id,e.source_key,e.author_provenance,e.created_at
      FROM social_commitments c JOIN social_events e ON e.id=c.source_event_id AND e.character_id=c.character_id AND e.audience_id=c.audience_id
      WHERE c.character_id=$1 AND c.audience_id=$2 AND c.person_id=$3
      ORDER BY c.commitment_key,c.version DESC`,[p.characterId,p.audienceId,person.id]) : Promise.resolve({rows:[],rowCount:0}),
    query.query(`SELECT count(*)::int AS total FROM (
      SELECT DISTINCT ON (commitment_key) commitment_key,status FROM social_commitments
      WHERE character_id=$1 AND audience_id=$2 ORDER BY commitment_key,version DESC
    ) latest WHERE status='open'`, [p.characterId,p.audienceId])
  ]);
  const src = (row: any) => ({event_id:row.event_id,source_type:sourceType(row.source_key),author_provenance:row.author_provenance,created_at:new Date(row.created_at).toISOString()});
  const allCommitments = commitmentsResult.rows.filter((row:any)=>row.status==='open').sort((a:any,b:any)=>{
    const dueA=a.due_at?new Date(a.due_at).getTime():Number.MAX_SAFE_INTEGER;
    const dueB=b.due_at?new Date(b.due_at).getTime():Number.MAX_SAFE_INTEGER;
    return dueA-dueB;
  });
  const currentOpenCount=allCommitments.length;
  const otherCount=Math.max(0,Number(allOpenResult.rows[0]?.total??0)-currentOpenCount);
  return {
    working_state:state,
    current_person:currentPerson,
    facts:factsResult.rows.map((r:any)=>({content:r.content,confidence:Number(r.confidence),epistemic_status:r.epistemic_status,source:src(r)})),
    relationships:relationshipsResult.rows.map((r:any)=>({note:r.note,version:Number(r.version),source:src(r)})),
    commitments:allCommitments.map((r:any)=>({key:r.key,description:r.description,status:r.status,due_at:r.due_at?new Date(r.due_at).toISOString():null,person_ref:'current_speaker',source:src(r)})),
    other_open_commitment_count:otherCount,
    counts:{facts:Number(factsResult.rows[0]?.total??0),relationships:Number(relationshipsResult.rows[0]?.total??0),commitments:currentOpenCount}
  };
}

/** Full bounded-page obligation lookup for a trusted active event's participant. */
export async function listSocialCommitments(query: pg.Pool | pg.PoolClient, p: Principal, event: {author_id:string;source_key:string}, limit=20, offset=0) {
  const channel=sourceType(event.source_key);
  const person=(await query.query(`SELECT id FROM social_people WHERE character_id=$1 AND audience_id=$2 AND channel=$3 AND external_id=$4`,[p.characterId,p.audienceId,channel,event.author_id])).rows[0];
  if(!person)return {items:[],total:0,offset,limit};
  const result=await query.query(`WITH latest AS (
    SELECT DISTINCT ON (c.commitment_key) c.commitment_key,c.description,c.status,c.due_at,c.source_event_id,c.version
    FROM social_commitments c WHERE c.character_id=$1 AND c.audience_id=$2 AND c.person_id=$3
    ORDER BY c.commitment_key,c.version DESC
  ) SELECT l.*,e.source_key,e.author_provenance,e.created_at,count(*) OVER()::int AS total
    FROM latest l JOIN social_events e ON e.id=l.source_event_id AND e.character_id=$1 AND e.audience_id=$2
    WHERE l.status='open' ORDER BY l.due_at NULLS LAST,l.commitment_key LIMIT $4 OFFSET $5`,[p.characterId,p.audienceId,person.id,limit,offset]);
  return {items:result.rows.map((r:any)=>({key:r.commitment_key,description:r.description,status:r.status,due_at:r.due_at?new Date(r.due_at).toISOString():null,person_ref:'current_speaker',source:{event_id:r.source_event_id,source_type:sourceType(r.source_key),author_provenance:r.author_provenance,created_at:new Date(r.created_at).toISOString()}})),total:Number(result.rows[0]?.total??0),offset,limit};
}

export async function stageSocialMemory(
  pool: pg.Pool, p: Principal, eventId: string, epoch: number, invocationId: string, rawProposal: unknown
) {
  const proposal=SocialMemoryProposalSchema.parse(rawProposal);
  if (!proposal.person && !proposal.facts.length && !proposal.relationships.length && !proposal.commitments.length && proposal.working_state==null) throw new DomainError('empty_memory_delta');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const state=(await db.query('SELECT paused,epoch,lease_until,active_event_id FROM characters WHERE id=$1 FOR UPDATE',[p.characterId])).rows[0];
    if(!state)throw new DomainError('character_not_found');
    assertActive(state,epoch);
    if(state.active_event_id!==eventId || !state.lease_until || new Date(state.lease_until).getTime()<=Date.now())throw new DomainError('turn_not_current');
    const event=(await db.query(`SELECT author_id,author_provenance,source_key FROM social_events
      WHERE id=$1 AND character_id=$2 AND audience_id=$3 AND NOT processed FOR UPDATE`,[eventId,p.characterId,p.audienceId])).rows[0];
    if(!event)throw new DomainError('event_not_found');
    const payload=JSON.stringify(proposal);
    const oldInvocation=await db.query(`SELECT payload,stage_version FROM social_memory_stage_invocations
      WHERE character_id=$1 AND audience_id=$2 AND event_id=$3 AND epoch=$4 AND invocation_id=$5`,[p.characterId,p.audienceId,eventId,epoch,invocationId]);
    if(oldInvocation.rows[0]){
      const same=await db.query(`SELECT payload=$6::jsonb AS matches FROM social_memory_stage_invocations
        WHERE character_id=$1 AND audience_id=$2 AND event_id=$3 AND epoch=$4 AND invocation_id=$5`,[p.characterId,p.audienceId,eventId,epoch,invocationId,payload]);
      if(!same.rows[0].matches)throw new DomainError('staging_invocation_conflict');
      await db.query('COMMIT');return {staged:true,replayed:true,stage_version:oldInvocation.rows[0].stage_version};
    }
    const channel=sourceType(event.source_key);
    const version=Number((await db.query('SELECT version FROM social_working_states WHERE character_id=$1 AND audience_id=$2',[p.characterId,p.audienceId])).rows[0]?.version??0);
    const personNeeded=!!proposal.person || !!(proposal.facts.length||proposal.relationships.length||proposal.commitments.length);
    let personName=proposal.person?.display_name;
    if(personNeeded&&!personName){
      const existing=await db.query(`SELECT display_name FROM social_people WHERE character_id=$1 AND audience_id=$2 AND channel=$3 AND external_id=$4`,[p.characterId,p.audienceId,channel,event.author_id]);
      personName=existing.rows[0]?.display_name??'Unknown participant';
    }
    const delta=SocialMemoryDeltaSchema.parse({
      schema_version:1,character_id:p.characterId,audience_id:p.audienceId,epoch,base_state_version:version,
      people:personNeeded?[{channel,external_id:event.author_id,display_name:personName!,provenance:event.author_provenance,identity_status:'unverified'}]:[],
      facts:proposal.facts.map(f=>({...f,person:event.author_id,source_event_id:eventId,visibility:'audience'})),
      relationships:proposal.relationships.map(r=>({...r,person:event.author_id,source_event_id:eventId})),
      commitments:await Promise.all(proposal.commitments.map(async c=>{
        const prior=await db.query(`SELECT source_event_id,person_id FROM social_commitments WHERE character_id=$1 AND audience_id=$2 AND commitment_key=$3 ORDER BY version DESC LIMIT 1`,[p.characterId,p.audienceId,c.key]);
        if(prior.rows[0]){
          const origin=await db.query(`SELECT external_id FROM social_people WHERE id=$1 AND character_id=$2 AND audience_id=$3`,[prior.rows[0].person_id,p.characterId,p.audienceId]);
          if(origin.rows[0]?.external_id!==event.author_id)throw new DomainError('commitment_origin_immutable');
          return {...c,person:event.author_id,source_event_id:prior.rows[0].source_event_id,...(c.status==='open'?{}:{evidence_event_id:eventId})};
        }
        return {...c,person:event.author_id,source_event_id:eventId,...(c.status==='open'?{}:{evidence_event_id:eventId})};
      })),
      working_state:proposal.working_state==null?null:{...proposal.working_state,last_event_id:eventId}
    });
    const stored=await db.query(`INSERT INTO social_memory_staging(character_id,audience_id,event_id,epoch,stage_version,proposal)
      VALUES($1,$2,$3,$4,1,$5::jsonb)
      ON CONFLICT(character_id,audience_id,event_id,epoch) DO UPDATE SET stage_version=social_memory_staging.stage_version+1,proposal=EXCLUDED.proposal,updated_at=now()
      RETURNING stage_version`,[p.characterId,p.audienceId,eventId,epoch,JSON.stringify(delta)]);
    await db.query(`INSERT INTO social_memory_stage_invocations(character_id,audience_id,event_id,epoch,invocation_id,payload,stage_version)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[p.characterId,p.audienceId,eventId,epoch,invocationId,payload,stored.rows[0].stage_version]);
    await db.query('COMMIT');return {staged:true,stage_version:stored.rows[0].stage_version};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

export async function loadStagedSocialMemory(db: pg.PoolClient,p:Principal,eventId:string,epoch:number) {
  const result=await db.query(`SELECT proposal FROM social_memory_staging WHERE character_id=$1 AND audience_id=$2 AND event_id=$3 AND epoch=$4 FOR UPDATE`,[p.characterId,p.audienceId,eventId,epoch]);
  return result.rows[0]?SocialMemoryDeltaSchema.parse(result.rows[0].proposal):undefined;
}

/** Applies a pre-parsed proposal inside complete()'s transaction and savepoint. */
export async function applySocialMemoryDelta(
  db: pg.PoolClient, delta: SocialMemoryDelta, scope: { characterId: string; audienceId: string; eventId: string; epoch: number }
): Promise<DeltaResult> {
  if (delta.character_id !== scope.characterId || delta.audience_id !== scope.audienceId) return { status: 'rejected', reason: 'scope_mismatch' };
  if (delta.epoch !== scope.epoch) return { status: 'rejected', reason: 'epoch_mismatch' };
  const state = await db.query('SELECT version FROM social_working_states WHERE character_id=$1 AND audience_id=$2 FOR UPDATE', [scope.characterId, scope.audienceId]);
  const version = Number(state.rows[0]?.version ?? 0);
  if (version !== delta.base_state_version) return { status: 'rejected', reason: 'state_version_conflict', state_version: version };

  const { rows: eventRows } = await db.query(`SELECT author_id,author_provenance,source_key,created_at FROM social_events
    WHERE id=$1 AND character_id=$2 AND audience_id=$3`, [scope.eventId, scope.characterId, scope.audienceId]);
  if (!eventRows[0]) return { status: 'rejected', reason: 'source_scope_mismatch' };
  const sourceIds = new Set<string>();
  for (const item of [...delta.facts, ...delta.relationships, ...delta.commitments]) sourceIds.add(item.source_event_id);
  for (const item of delta.commitments) if (item.evidence_event_id) sourceIds.add(item.evidence_event_id);
  if (delta.working_state?.last_event_id) sourceIds.add(delta.working_state.last_event_id);
  if (sourceIds.size) {
    const scopedSources = await db.query(`SELECT e.id FROM social_events e WHERE e.id=ANY($1::uuid[]) AND e.character_id=$2 AND e.audience_id=$3
      AND (e.id=$4 OR (e.processed=true AND (e.created_at,e.id)<($5,$4::uuid)
        AND (EXISTS(SELECT 1 FROM replies r WHERE r.event_id=e.id) OR e.completion_payload->>'decision'='silent')))` ,
      [[...sourceIds], scope.characterId, scope.audienceId, scope.eventId, eventRows[0].created_at]);
    if (scopedSources.rowCount !== sourceIds.size) return { status: 'rejected', reason: 'source_scope_mismatch' };
  }
  const channel = eventRows[0].source_key.startsWith('minecraft-system:') ? 'minecraft_system'
    : eventRows[0].source_key.startsWith('minecraft:') ? 'minecraft'
      : eventRows[0].source_key.startsWith('telegram:') ? 'telegram' : 'owner';
  for (const person of delta.people) {
    if (person.external_id !== eventRows[0].author_id || person.channel !== channel || person.provenance !== eventRows[0].author_provenance) {
      return { status: 'rejected', reason: 'person_provenance_mismatch' };
    }
  }
  await db.query('SAVEPOINT social_memory_delta');
  try {
    const personIds = new Map<string, string>();
    for (const person of delta.people) {
      const id = randomUUID();
      const result = await db.query(`INSERT INTO social_people(id,character_id,audience_id,channel,external_id,display_name,provenance,identity_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'unverified')
        ON CONFLICT(character_id,audience_id,channel,external_id) DO UPDATE SET
          display_name=EXCLUDED.display_name,provenance=EXCLUDED.provenance,updated_at=now()
        RETURNING id`, [id, scope.characterId, scope.audienceId, person.channel, person.external_id, person.display_name, person.provenance]);
      personIds.set(person.external_id, result.rows[0].id);
    }
    const findPerson = async (externalId: string) => {
      const known = personIds.get(externalId);
      if (known) return known;
      const result = await db.query(`SELECT id FROM social_people WHERE character_id=$1 AND audience_id=$2 AND external_id=$3 AND channel=$4`, [scope.characterId, scope.audienceId, externalId, channel]);
      return result.rows[0]?.id as string | undefined;
    };
    for (const fact of delta.facts) {
      const personId = await findPerson(fact.person);
      if (!personId) throw new Error('unknown_person');
      await db.query(`INSERT INTO social_facts(id,character_id,audience_id,person_id,content,source_event_id,confidence,epistemic_status,visibility)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), scope.characterId, scope.audienceId, personId, fact.content, fact.source_event_id, fact.confidence, fact.epistemic_status, fact.visibility]);
    }
    for (const relationship of delta.relationships) {
      const personId = await findPerson(relationship.person);
      if (!personId) throw new Error('unknown_person');
      const current = await db.query('SELECT COALESCE(max(version),0)::int AS version FROM social_relationships WHERE character_id=$1 AND audience_id=$2 AND person_id=$3', [scope.characterId, scope.audienceId, personId]);
      await db.query(`INSERT INTO social_relationships(id,character_id,audience_id,person_id,note,source_event_id,version)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), scope.characterId, scope.audienceId, personId, relationship.note, relationship.source_event_id, current.rows[0].version + 1]);
    }
    const pendingCommitments = new Map<string, string>();
    for (const commitment of delta.commitments) {
      const personId = await findPerson(commitment.person);
      if (!personId) throw new Error('unknown_person');
      const prior = await db.query(`SELECT status,version,person_id,source_event_id FROM social_commitments WHERE character_id=$1 AND audience_id=$2 AND commitment_key=$3
        ORDER BY version DESC LIMIT 1 FOR UPDATE`, [scope.characterId, scope.audienceId, commitment.key]);
      const old = prior.rows[0];
      if (!old && commitment.source_event_id !== scope.eventId) throw new Error('commitment_source_mismatch');
      if (!old && !(await db.query('SELECT 1 FROM replies WHERE event_id=$1', [commitment.source_event_id])).rowCount) throw new Error('commitment_reply_required');
      if (!old && commitment.status !== 'open' && !commitment.evidence_event_id) throw new Error('commitment_evidence_required');
      if (old && (old.person_id !== personId || old.source_event_id !== commitment.source_event_id)) throw new Error('commitment_origin_immutable');
      if (old && old.status !== 'open') throw new Error('closed_commitment_transition');
      if (old?.status === 'open' && commitment.status !== 'open' && !commitment.evidence_event_id) throw new Error('commitment_evidence_required');
      await db.query(`INSERT INTO social_commitments(id,character_id,audience_id,commitment_key,person_id,description,source_event_id,due_at,status,evidence_event_id,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), scope.characterId, scope.audienceId, commitment.key, personId, commitment.description, commitment.source_event_id, commitment.due_at ?? null, commitment.status, commitment.evidence_event_id ?? null, (old?.version ?? 0) + 1]);
      if (commitment.status === 'open') pendingCommitments.set(commitment.key, 'open');
    }
    if (delta.working_state) {
      for (const key of delta.working_state.commitment_keys) {
        if (pendingCommitments.has(key)) continue;
        const open = await db.query(`SELECT 1 FROM social_commitments WHERE character_id=$1 AND audience_id=$2 AND commitment_key=$3
          ORDER BY version DESC LIMIT 1`, [scope.characterId, scope.audienceId, key]);
        if (!open.rowCount) throw new Error('unknown_commitment');
        const latest = await db.query(`SELECT status FROM social_commitments WHERE character_id=$1 AND audience_id=$2 AND commitment_key=$3 ORDER BY version DESC LIMIT 1`, [scope.characterId, scope.audienceId, key]);
        if (latest.rows[0].status !== 'open') throw new Error('closed_commitment');
      }
    }
    if (delta.working_state) {
      await db.query(`INSERT INTO social_working_states(character_id,audience_id,version,topic,goal,open_questions,commitment_keys,last_event_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(character_id,audience_id) DO UPDATE SET version=EXCLUDED.version,topic=EXCLUDED.topic,goal=EXCLUDED.goal,
          open_questions=EXCLUDED.open_questions,commitment_keys=EXCLUDED.commitment_keys,last_event_id=EXCLUDED.last_event_id,updated_at=now()`,
      [scope.characterId, scope.audienceId, version + 1, delta.working_state.topic, delta.working_state.goal, JSON.stringify(delta.working_state.open_questions), JSON.stringify(delta.working_state.commitment_keys), delta.working_state.last_event_id]);
    } else if (version === 0) {
      await db.query(`INSERT INTO social_working_states(character_id,audience_id,version,topic,goal,open_questions,commitment_keys,last_event_id)
        VALUES($1,$2,1,NULL,NULL,'[]'::jsonb,'[]'::jsonb,NULL)`, [scope.characterId, scope.audienceId]);
    } else {
      await db.query('UPDATE social_working_states SET version=version+1,updated_at=now() WHERE character_id=$1 AND audience_id=$2', [scope.characterId, scope.audienceId]);
    }
    await db.query('RELEASE SAVEPOINT social_memory_delta');
    return { status: 'accepted', state_version: version + 1 };
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT social_memory_delta');
    await db.query('RELEASE SAVEPOINT social_memory_delta');
    const reason = error instanceof Error && ['unknown_person','closed_commitment_transition','commitment_evidence_required','commitment_reply_required','unknown_commitment','closed_commitment','commitment_source_mismatch','commitment_origin_immutable'].includes(error.message)
      ? error.message : 'persistence_rejected';
    return { status: 'rejected', reason, state_version: version };
  }
}
