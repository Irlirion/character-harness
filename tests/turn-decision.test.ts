import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnFinishDecisionSchema } from '../packages/domain/turn-decision.ts';

test('typed turn finish distinguishes a bounded reply from explicit silence',()=>{
  assert.deepEqual(TurnFinishDecisionSchema.parse({decision:'reply',text:'Здравствуйте!'}),{decision:'reply',text:'Здравствуйте!'});
  assert.deepEqual(TurnFinishDecisionSchema.parse({decision:'silent'}),{decision:'silent'});
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'silent',text:'sentinel'}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'x'.repeat(301)}));
  assert.throws(()=>TurnFinishDecisionSchema.parse({decision:'reply',text:'ok',extra:'not allowed'}));
});
