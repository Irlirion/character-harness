import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCodex } from '../packages/codex/config.ts';
import { MINECRAFT_WORKSPACE_INSTRUCTIONS } from '../packages/codex/instructions.ts';

test('Codex enables dynamic tool dispatch while keeping other built-in features disabled', async () => {
  const root=await mkdtemp(join(tmpdir(),'harness-codex-config-'));
  try {
    await configureCodex(join(root,'home'),join(root,'workspace'));
    const config=await readFile(join(root,'home','config.toml'),'utf8');
    assert.match(config,/^code_mode_host = true$/m);
    for(const feature of ['shell_tool','unified_exec','apps','computer_use','browser_use','multi_agent','view_image','image_generation'])
      assert.match(config,new RegExp(`^${feature} = false$`,'m'));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('UnionClef guidance makes unverified server/session scope explicit', () => {
  assert.match(MINECRAFT_WORKSPACE_INSTRUCTIONS,/Discover minecraft_tools/);
  assert.match(MINECRAFT_WORKSPACE_INSTRUCTIONS,/fresh session evidence after reconnecting/);
});
