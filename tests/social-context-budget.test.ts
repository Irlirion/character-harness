import test from 'node:test';
import assert from 'node:assert/strict';
import { boundSocialContext, type SocialContextInput } from '../packages/domain/conversation-context.ts';

const source = { event_id: '11111111-1111-4111-8111-111111111111', source_type: 'owner', author_provenance: 'owner_input', created_at: '2026-10-10T10:00:00.000Z' };
const empty = (): SocialContextInput => ({ working_state: null, current_person: null, facts: [], relationships: [], commitments: [], other_open_commitment_count: 0 });

test('social context caps escaped state and retains version and sourced commitments under its total budget', () => {
  const input = empty();
  input.working_state = {
    version: 17, topic: '"'.repeat(500), goal: '\n'.repeat(1000),
    open_questions: Array.from({ length: 20 }, () => '\\'.repeat(500)),
    commitment_keys: Array.from({ length: 20 }, (_, i) => `promise-${i}-${'"'.repeat(180)}`),
    last_event_id: source.event_id
  };
  input.current_person = { display_name: 'Sasha', identity_status: 'unverified' };
  input.commitments = Array.from({ length: 20 }, (_, i) => ({ key: `promise-${i}`, description: '"'.repeat(1000), status: 'open', due_at: null, source }));
  input.facts = Array.from({ length: 20 }, () => ({ content: '\n'.repeat(2000), confidence: 0.5, epistemic_status: 'inferred', source }));
  const before = JSON.stringify(input);
  const result = boundSocialContext(input);
  assert.ok(JSON.stringify(result).length <= 6000);
  assert.equal(result.serialized_chars, JSON.stringify(result).length);
  assert.ok(JSON.stringify(result.working_state).length <= 2000);
  assert.equal(result.working_state?.version, 17);
  assert.equal(result.working_state?.last_event_id, source.event_id);
  assert.ok(result.commitments.length > 0);
  assert.equal(result.omitted.commitments, 20 - result.commitments.length);
  assert.ok(result.omitted.state_questions > 0);
  assert.equal(JSON.stringify(input), before);
});

test('an oversized obligation does not hide later short obligations and omitted counts include unloaded records', () => {
  const input = empty();
  input.commitments = [
    { key: 'oversized', description: '\n'.repeat(2000), status: 'open', due_at: null, source },
    { key: 'short', description: 'Discuss the settlement name', status: 'open', due_at: null, source }
  ];
  input.counts = { facts: 0, relationships: 0, commitments: 8 };
  const result = boundSocialContext(input, 1200);
  assert.deepEqual(result.commitments.map(c => c.key), ['short']);
  assert.equal(result.omitted.commitments, 7);
  assert.ok(JSON.stringify(result).length <= 1200);
  assert.equal(result.serialized_chars, JSON.stringify(result).length);
});
