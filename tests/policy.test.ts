import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesToken, snapshot, assertActive, assertReplay } from '../packages/domain/policy.ts';
const p = { characterId: 'sever', audienceId: 'public' };
test('private and other-character memories are excluded from public snapshot', () => {
  const records = [
    { ...p, id: '1', text: 'public event', source: 'world', createdAt: '' },
    { ...p, audienceId: 'private', id: '2', text: 'secret', source: 'dm', createdAt: '' },
    { ...p, characterId: 'iskra', id: '3', text: 'personal relationship', source: 'world', createdAt: '' }
  ];
  assert.deepEqual(snapshot(p, records).memories.map(m=>m.id), ['1']);
});
test('revoked epoch and paused state fence changes', () => {
  assert.throws(()=>assertActive({ paused: false, epoch: 3 },2), /stale_epoch/);
  assert.throws(()=>assertActive({ paused: true, epoch: 3 },3), /paused/);
  assert.doesNotThrow(()=>assertActive({ paused: false, epoch: 3 },3));
});
test('same invocation may not be reused for a different effect', () => {
  assert.doesNotThrow(()=>assertReplay('a','a'));
  assert.throws(()=>assertReplay('a','b'), /invocation_conflict/);
});
test('engine token does not authenticate owner and malformed tokens fail closed', () => {
  const engine='a'.repeat(64), owner='b'.repeat(64);
  assert.equal(matchesToken(`Bearer ${engine}`,engine),true);
  assert.equal(matchesToken(`Bearer ${engine}`,owner),false);
  assert.equal(matchesToken(undefined,engine),false);
  assert.equal(matchesToken('Bearer short',engine),false);
});
