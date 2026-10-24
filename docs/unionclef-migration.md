# UnionClef MCP migration

## Pinned runtime

- Upstream: https://github.com/3ndetz/unionclef
- Release: `v0.95.63`, Minecraft 1.21.11 / Fabric / Java 21.
- Source tag commit: `818e6f80137ad9bdbc87884cb926531065d97e2e`.
- Artifact: `unionclef-1.21.11-0.95.63.jar`, SHA256 `4b48f14b657646c302af6df6d5c78737cf406e75736c757af5e8adb0e76eb1ba`.
- Companion: `character-harness-bridge-0.2.0.jar`. UnionClef is downloaded separately, not vendored or bundled into our artifact.

## Install in the separate test instance

Build the companion with Java 21:

```sh
cd client-bridge
./gradlew --no-daemon build
cd ..
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft'
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft' --apply
```

The first invocation prepares/downloads and verifies the release without changing the instance. `--apply` backs up old mods/configuration under `minecraft/character-harness-backups`, installs the two jars and configures the authenticated built-in MCP. The token is stored in owner-only settings/token files and never printed. Existing chat, STT, server gates and user automation preferences are retained. Only Minecraft 1.21.11 Prism instances are accepted when instance metadata is present. Stop/restart only the test client to load the jars. Do not copy jars into a running primary client.

Set `MINECRAFT_BACKEND=unionclef` (the Compose default) in core. Apply migration 020 before starting the updated core. `BRIDGE_CLIENT_WORLD_ENABLED=true` and the existing observation/action opt-ins are still required. No producer or model receives the MCP token. Production must remain stopped until the owner requests a start.

## Control flow

`agent_goto` → durable `client_actions` → Fabric companion → authenticated UnionClef MCP `gotoXYZ` → `pathStatus` → observed arrival → durable completion. An MCP acknowledgement is never treated as arrival. Target coordinates are integer local cells within 32 blocks of a fresh observation. Each request is bounded to 20 seconds and the existing one-current-action rule. Total reserved navigation duration is at most 20 seconds per active epoch; other action budgets retain their smaller limit.

The companion's HTTP client implements UnionClef's JSON-RPC MCP transport (`initialize`, `tools/call`). It uses only `gotoXYZ`, `pathStatus` and `stopPathing`, a fixed loopback URL, a bearer token, no redirects, bounded response bodies and request deadlines. Upstream server instructions/catalog are never promoted to model authority. Raw `ExecuteCommand`, chat commands, menu actions, combat, mining and building are not exposed by this migration. Native `agent_turn` remains available. Adding further MCP tools requires explicit schemas and action/permission semantics.

Navigation is enabled only with the pinned mod present and Tungsten `allowBreak=false`, `allowPlace=false`. The installer establishes those navigation settings; it does not disable UnionClef's survival settings or idle preferences. Busy existing UnionClef tasks are not replaced.

## Cancellation and uncertain outcomes

Epoch, pause, session, screen and core-lease checks remain active. The Minecraft tick watchdog stops the local Tungsten route if the core lease goes stale (500 ms) even when the MCP HTTP request is blocked. Normal command/control uses MCP; the local `stopNavigation` hook is an emergency stop only. Cancellation sends MCP `stopPathing` and waits for idle before accepting another route. Cancellation before actuation is observed, an ambiguous start or uncertain cleanup keeps the watchdog asserted and rejects new navigation until recovery/restart. A timed-out move is never retried automatically. Process death ends both mod and companion together.

UnionClef's separate Py4J interface and other manually connected MCP clients are not managed by this adapter. The built-in MCP binds to the LAN by upstream design, so the generated bearer token is required; the harness itself connects only through loopback. Owner stop/pause fences harness navigation; separate manually initiated UnionClef jobs retain their own controls.

## Verification and rollback

Tests cover MCP auth/envelope validation, endpoint restrictions, oversized responses, redirects, denied arbitrary tools, cancellation during an in-flight move, busy-task ownership, durable replay, session/epoch fencing and the model tool catalog. Unit/synthetic checks do not prove in-world path quality. A live world test must separately confirm arrival and pause/stop on the configured test server.

For rollback, restore the backed-up mods/config files and use `MINECRAFT_BACKEND=fabric`. Migration 020 is additive in accepted action kinds; finish/cancel existing navigation before reverting. Keep database volumes and credentials.
