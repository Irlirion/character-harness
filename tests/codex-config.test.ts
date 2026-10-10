import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCodex } from '../packages/codex/config.ts';
import { CODEX_ACTION_INSTRUCTIONS } from '../packages/codex/instructions.ts';

test('Codex enables dynamic tool dispatch while keeping other built-in features disabled', async () => {
  const root=await mkdtemp(join(tmpdir(),'harness-codex-config-'));
  try {
    await configureCodex(join(root,'home'),join(root,'workspace'));
    const config=await readFile(join(root,'home','config.toml'),'utf8');
    assert.match(config,/^code_mode_host = true$/m);
    for(const feature of ['shell_tool','unified_exec','apps','computer_use','browser_use','multi_agent','view_image'])
      assert.match(config,new RegExp(`^${feature} = false$`,'m'));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('action guidance gates walking independently from camera turns', () => {
  assert.match(CODEX_ACTION_INSTRUCTIONS,/A walk must start while on_ground=true, collision_ahead=false, and support_ahead=true/);
  assert.match(CODEX_ACTION_INSTRUCTIONS,/lower of the player safe-fall attribute and a 3-block cap/);
  assert.match(CODEX_ACTION_INSTRUCTIONS,/Never jump, fly, sprint, or walk across missing support/);
  assert.match(CODEX_ACTION_INSTRUCTIONS,/Turning only changes the camera and does not require walking checks/);
  assert.match(CODEX_ACTION_INSTRUCTIONS,/if the bearing magnitude is greater than 90, turn 90 degrees/);
});
