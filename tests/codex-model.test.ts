import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConfiguredModel } from '../packages/codex/model.ts';

test('Codex model selection uses the configured model and never falls back to default',()=>{
  const models=[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',isDefault:true},{id:'gpt-6-luna',model:'gpt-6-luna'}];
  assert.equal(selectConfiguredModel(models,'gpt-6-luna').model,'gpt-6-luna');
  assert.throws(()=>selectConfiguredModel(models,'gpt-unavailable'),/configured_model_unavailable/);
});
