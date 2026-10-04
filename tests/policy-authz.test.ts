import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPath, requiredRole } from '../packages/domain/policy.ts';

test('origin-form request target yields its path',()=>{
  assert.equal(requestPath('/owner/status'),'/owner/status');
  assert.equal(requestPath('/bridge/replies/abc/ack'),'/bridge/replies/abc/ack');
});
test('query and fragment are not part of the path',()=>{
  assert.equal(requestPath('/owner/status?x=1'),'/owner/status');
  assert.equal(requestPath('/owner/status#frag'),'/owner/status');
});
test('absolute-form request target yields the same path as origin-form',()=>{
  assert.equal(requestPath('http://127.0.0.1:3000/owner/status'),'/owner/status');
  assert.equal(requestPath('http://core:3000/bridge/events'),'/bridge/events');
});
test('an authority that looks like a role prefix cannot reach another role',()=>{
  assert.equal(requestPath('http://owner/bridge/events'),'/bridge/events');
  assert.equal(requestPath('http://127.0.0.1:3000/owner/pause'),'/owner/pause');
});

test('owner, audio, bridge and engine prefixes map to their own role',()=>{
  assert.equal(requiredRole('/owner/pause'),'owner');
  assert.equal(requiredRole('/owner/replies'),'owner');
  assert.equal(requiredRole('/audio/claim'),'audio');
  assert.equal(requiredRole('/bridge/events'),'bridge');
  assert.equal(requiredRole('/engine/input'),'engine');
});
test('root-level routes are attributed explicitly',()=>{
  assert.equal(requiredRole('/mcp'),'engine');
  assert.equal(requiredRole('/ready'),'engine');
});
test('unknown paths have no role instead of falling back to engine',()=>{
  assert.equal(requiredRole('/'),null);
  assert.equal(requiredRole('/unknown'),null);
  assert.equal(requiredRole('/ownerx/status'),null);
  assert.equal(requiredRole('/bridge'),null);
});
test('public health path has no role so the caller can skip it',()=>{
  assert.equal(requiredRole('/health'),null);
});