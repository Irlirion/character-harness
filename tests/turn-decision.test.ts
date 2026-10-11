import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnFinishDecisionSchema } from '../packages/domain/turn-decision.ts';

test('typed turn finish distinguishes a bounded reply from explicit silence',()=>{
  assert.deepEqual(TurnFinishDecisionSchema.parse({decision:'reply',text:'Здравствуйте!',channel:'voice'}),{decision:'reply',text:'Здравствуйте!',channel:'voice'});
  assert.deepEqual(TurnFinishDecisionSchema.parse({decision:'silent'}),{decision:'silent'});
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'silent',text:'sentinel'}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'x'.repeat(257),channel:'chat'}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'ok',extra:'not allowed'}));
});

test('reply channel is explicit and silence cannot select a channel',()=>{
  assert.deepEqual(TurnFinishDecisionSchema.parse({decision:'reply',text:'Привет',channel:'chat'}),{decision:'reply',text:'Привет',channel:'chat'});
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'Привет'}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'Привет',channel:'both'}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'silent',channel:'chat'}));
});
