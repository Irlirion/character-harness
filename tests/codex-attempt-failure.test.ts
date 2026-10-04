import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAttemptFailure } from '../packages/codex/backoff.ts';

const quotaError={message:'You’ve hit your usage limit. … or try again at 9:57 AM.',codexErrorInfo:'usageLimitExceeded'};
// Exactly the object apps/codex-engine/main.ts rejects with when turn/completed reports a failure.
const quotaTurnFailure=Object.assign(new Error('codex_turn_failed'),{turn:{status:'failed',error:quotaError}});
const NOW=Date.parse('2026-10-04T08:29:00Z');

function recorder(){
  const deferred:string[]=[];const slept:number[]=[];const logged:Record<string,unknown>[]=[];
  return {deferred,slept,logged,
    deps:{eventId:'evt-1',defer:async(id:string)=>{deferred.push(id);},sleep:async(ms:number)=>{slept.push(ms);},
      log:(e:Record<string,unknown>)=>{logged.push(e);},now:()=>NOW}};
}

test('a quota failure hands the event back before pausing',async()=>{
  const r=recorder();
  await handleAttemptFailure(quotaTurnFailure,r.deps);
  assert.deepEqual(r.deferred,['evt-1']);
});
test('a quota failure waits until the reset time it reported',async()=>{
  const r=recorder();
  await handleAttemptFailure(quotaTurnFailure,r.deps);
  assert.deepEqual(r.slept,[Date.parse('2026-10-04T09:57:00Z')-NOW]);
});
test('a quota failure is logged as such and never leaks provider text',async()=>{
  const r=recorder();
  await handleAttemptFailure(quotaTurnFailure,r.deps);
  assert.deepEqual(r.logged,[{event:'codex_usage_limit',retry_in_ms:5_280_000}]);
  assert.equal(JSON.stringify(r.logged).includes('usage limit'),false);
});
test('a transient failure keeps the one second retry and does not refund attempts',async()=>{
  const r=recorder();
  await handleAttemptFailure(new Error('codex_rpc_timeout'),r.deps);
  assert.deepEqual(r.deferred,[]);
  assert.deepEqual(r.slept,[1000]);
  assert.deepEqual(r.logged,[{event:'codex_attempt_failed',error_type:'codex_rpc_timeout'}]);
});
test('a quota failure with no claimed event still pauses without refunding',async()=>{
  const r=recorder();
  await handleAttemptFailure(quotaTurnFailure,{...r.deps,eventId:undefined});
  assert.deepEqual(r.deferred,[]);
  assert.deepEqual(r.slept,[5_280_000]);
});
test('a failing refund does not prevent the cooldown',async()=>{
  const r=recorder();
  await handleAttemptFailure(quotaTurnFailure,{...r.deps,defer:async()=>{throw new Error('core down');}});
  assert.deepEqual(r.slept,[5_280_000]);
});