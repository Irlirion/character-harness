# UnionClef Minecraft workspace

## Runtime and installation

Pinned upstream: [3ndetz/unionclef](https://github.com/3ndetz/unionclef), release `v0.95.63`, Minecraft 1.21.11 / Fabric / Java 21. Source tag `818e6f80137ad9bdbc87884cb926531065d97e2e`. Release artifact `unionclef-1.21.11-0.95.63.jar`, SHA256 `4b48f14b657646c302af6df6d5c78737cf406e75736c757af5e8adb0e76eb1ba`. The upstream jar is downloaded and verified separately, not bundled into our companion.

Build and install in the selected test instance:

```sh
JAVA_HOME=/absolute/path/to/java21 ./client-bridge/gradlew -p client-bridge --no-daemon build
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft'
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft' --apply
```

Dry run verifies the release and reports proposed settings. Apply backs up the existing jars/configuration under `minecraft/character-harness-backups`, installs both mods, enables authenticated MCP and `unionclef_workspace_enabled=true`, and enables Tungsten `allowBreak` and `allowPlace`. Existing chat, voice, server and automation preferences are retained. Only Minecraft 1.21.11 Prism instances are accepted when metadata is present. Restart that client to load the changed jar/settings; do not stop or modify unrelated instances.

Apply migrations through **021-minecraft-workspace** before running the updated core. Enable `BRIDGE_CLIENT_WORLD_ENABLED=true`, the existing bridge observation/action settings, and the full MCP connection. For a native core:

```sh
export UNIONCLEF_MCP_URL=http://127.0.0.1:25350/mcp
export UNIONCLEF_MCP_TOKEN_FILE='/absolute/path/to/instance/minecraft/config/character-harness-unionclef-mcp.token'
```

For Docker, `compose.unionclef.yaml` supplies the host connection and secret mount. Set `UNIONCLEF_MCP_TOKEN_PATH` to that host token file, and include this file along with the normal Compose files when starting/stopping the deployment. Do not copy the token into prompts or logs. Adding configuration does not start production; startup remains an explicit operator action.

## Full tool access

The agent sees three tools:

- `minecraft_tools` discovers the entire catalog published by the installed UnionClef MCP, including descriptions and JSON argument schemas.
- `minecraft_call` calls any tool in that catalog, with upstream schema validation and a trusted event/call identifier and character epoch injected by either engine.
- `minecraft_stop` requests stops of navigation/tasks, combat, fleeing and the build queue.

There is no navigation-only whitelist in this workspace. Published navigation, inventory, block inspection, mining, building, combat, menus, chat, commands and server connection tools are exposed. Mod/server capabilities and server permissions still apply. The former 32-block/20-second route budget and no-break/no-place profile do not apply to `minecraft_call`. Upstream descriptions and outputs remain untrusted data, not system instructions. Existing content rules remain in effect.

The same client is available from Minecraft turns and verified owner private Telegram turns. Telegram group members and other private users do not acquire Minecraft controls. Owner access uses the existing verified private binding and valid policy admission. The configured server scope remains `mc.agicraft.ru:25565`; switching to another server closes access until the configured server is restored. This change does not add an autonomous Minecraft scheduler or grant server operator privileges.

Without the full MCP environment configuration, the legacy `agent_goto` adapter remains available for compatibility. It retains its durable local route budget and navigation-specific result decoder. Do not confuse that fallback with the full workspace.

## Creatures and items

The companion's shared observation includes up to 64 nearest non-player entities within 32 blocks with an unobstructed ray to their bounding-box center: entity type, UUID, position, distance and relative bearing. Dropped items include item ID/count. Invisible/removed entities and entities behind collision blocks are omitted. The crosshair reports the entity type, such as `minecraft:chicken`. This is structured local game data, not a screenshot or proof of the entire world state. Existing observations without the new optional fields remain valid.

`getGameState` in this upstream release contains self/players/beds but not animals. Its non-MCP `getEntitiesInfo` is not used as a Py4J backdoor; animals are supplied by the companion observation through `agent_observe`.

## Receipts, stopping and recovery

Every forwarded invocation reserves a database receipt before dispatch. Concurrent/repeated invocations with the same key cannot repeat the action; changed arguments/session/epoch conflict. A timeout or lost response leaves the result `unknown` and is never automatically resent. Inspect current world/status instead. A returned RPC or `ok` means accepted/returned, not completion of a background task. Use the appropriate UnionClef status tool and observed evidence before claiming success.

Core checks the active epoch, pause state, fresh connected observation and companion workspace readiness before dispatch. Turn authorization is checked again after discovery. Stop fences calls still being prepared; if a call returns after stop/revocation, stops are requested again. Background mod tasks may continue after the conversational turn while the workspace remains admitted; there is no artificial 20-second task lifetime.

A dedicated companion heartbeat expires after 2.5 seconds without renewal. The Minecraft tick stops task execution locally even when core/MCP HTTP is unavailable. Pause, epoch/session change, core restart and client shutdown also revoke the lease. Emergency hooks stop AltoClef tasks, combat, fleeing, placement queue and navigation; normal actions use MCP. Tick-based stopping requires a responsive Minecraft client. It cannot undo blocks already changed or messages already sent. Separate manually connected mod clients are not fenced by harness receipts.

MCP credentials stay in service configuration. Only a fixed local/operator host endpoint is accepted, redirects are refused, RPC deadlines and response size bounds apply. The upstream MCP listens on all interfaces and requires its bearer token.

## Verification and rollback

Tests exercise full catalog calls and raw perception results, schema checks, concurrent PostgreSQL receipts, uncertain network outcomes, stop races, pause/session fencing, the client-side lease and bounded creature observations. Java tests/build and TypeScript checks cover the companion and both engines. Synthetic tests do not prove path quality or real server interactions; test those separately after an explicit startup.

Rollback: stop the workspace, remove its optional connection configuration, restore the backed-up instance jars/settings and restart only that client. Keep database volumes/receipts and credentials. The new receipt migration is additive. `MINECRAFT_BACKEND=fabric` selects the old backend when needed.
