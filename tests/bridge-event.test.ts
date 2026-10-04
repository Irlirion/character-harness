import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeEvent, BridgeEventScopeError } from '../packages/domain/bridge-event.ts';

const systemEvent = {
  source_key: 'minecraft-system:mc.agicraft.ru:25565:irlirion:1720000000000:abc123',
  author_id: 'minecraft-system:mc.agicraft.ru:25565:irlirion',
  author_provenance: 'minecraft_system_chat',
  source_server: 'mc.agicraft.ru:25565',
  text: 'привет'
};

test('system display-name author is explicitly unverified and admitted only to opted-in public demo', () => {
  assert.deepEqual(parseBridgeEvent(systemEvent, true, 'demo-public'), {
    ...systemEvent,
    author_trust: 'unverified'
  });
  assert.throws(() => parseBridgeEvent(systemEvent, false, 'demo-public'), BridgeEventScopeError);
  assert.throws(() => parseBridgeEvent(systemEvent, true, 'private'), BridgeEventScopeError);
});

test('system chat contract rejects any source server other than the fixed test server', () => {
  assert.throws(() => parseBridgeEvent({ ...systemEvent, source_server: 'attacker.example:25565' }, true, 'demo-public'));
});

test('signed profile context is also stored as unverified', () => {
  const event = {
    source_key: 'minecraft:12345678-1234-1234-8234-123456789012:123:abc',
    author_id: '12345678-1234-1234-8234-123456789012',
    author_provenance: 'fabric_profile_context',
    text: 'привет'
  };
  assert.equal(parseBridgeEvent(event, false, 'private').author_trust, 'unverified');
});
