import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnFailure, usageLimitDelayMs } from '../packages/codex/backoff.ts';

// Real payload captured from the codex app-server when the ChatGPT plan limit was hit.
const quotaError={message:'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:57 AM.',codexErrorInfo:'usageLimitExceeded',additionalDetails:null,misalignment:null};
const otherError={message:'the model stream ended unexpectedly',codexErrorInfo:'internalError',additionalDetails:null,misalignment:null};

// 2026-10-04T08:29:00Z, the moment the quota error above was observed.
const NOW=Date.parse('2026-10-04T08:29:00Z');

test('classifies a quota error as a usage limit',()=>{
  assert.equal(classifyTurnFailure({status:'failed',error:quotaError}),'usage_limit');
});
test('classifies a non-quota turn failure as transient',()=>{
  assert.equal(classifyTurnFailure({status:'failed',error:otherError}),'transient');
});
test('classifies a completed turn as transient',()=>{
  assert.equal(classifyTurnFailure({status:'completed'}),'transient');
});
test('classifies a turn without error details as transient',()=>{
  assert.equal(classifyTurnFailure({status:'interrupted'}),'transient');
  assert.equal(classifyTurnFailure(undefined),'transient');
});

test('waits until the reset time stated by the quota error',()=>{
  assert.equal(usageLimitDelayMs(quotaError,NOW),Date.parse('2026-10-04T09:57:00Z')-NOW);
});
test('falls back to fifteen minutes when no reset time is stated',()=>{
  assert.equal(usageLimitDelayMs({...quotaError,message:'You’ve hit your usage limit.'},NOW),15*60_000);
});
test('falls back when the reset time is not in English twelve-hour form',()=>{
  assert.equal(usageLimitDelayMs({...quotaError,message:'попробуйте снова в 9:57.'},NOW),15*60_000);
});
test('falls back when the stated reset time is already in the past',()=>{
  assert.equal(usageLimitDelayMs({...quotaError,message:'try again at 7:00 AM.'},NOW),15*60_000);
});
test('never waits less than a minute even if the reset time is imminent',()=>{
  assert.equal(usageLimitDelayMs({...quotaError,message:'try again at 8:30 AM.'},NOW),60_000);
});
test('never waits more than three hours even if the reset time is far away',()=>{
  assert.equal(usageLimitDelayMs({...quotaError,message:'try again at 11:00 PM.'},NOW),3*60*60_000);
});
