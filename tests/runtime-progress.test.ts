import test from 'node:test';
import assert from 'node:assert/strict';
import {hasMinecraftGoalProgress} from '../packages/storage/runtime.ts';

test('only a new plan or a completed step permits a quick continuation',()=>{
 assert.equal(hasMinecraftGoalProgress(null,{completed:0}),true);
 assert.equal(hasMinecraftGoalProgress({completed:0},{completed:1}),true);
 assert.equal(hasMinecraftGoalProgress({completed:1},{completed:1}),false);
 assert.equal(hasMinecraftGoalProgress({completed:1},null),false);
 assert.equal(hasMinecraftGoalProgress({completed:2},{completed:1}),false);
});
