# Fabric client bridge

Client-only Fabric mod for Minecraft 1.21.11, Fabric Loader 0.19.5 and Fabric API 0.141.6. It requires no server mod. It forwards all visible signed user chat messages except the local player's own messages; the character decides whether to reply. Generated replies appear in local chat. The Codex engine sends reply decisions to the existing speech queue.

## Build

```sh
./gradlew build
```

The distributable is `build/libs/character-harness-bridge-0.1.0.jar`.

## Configure the test client

For a fresh setup, create local secrets with `node --experimental-strip-types scripts/setup-secrets.ts`. If the project already has secrets, add a separate bridge token without replacing them:

```sh
node --experimental-strip-types scripts/setup-bridge-secret.ts
```

Copy the jar into the test instance's `minecraft/mods/` folder and create `minecraft/config/character-harness-bridge.properties`:

```properties
core_url=http://127.0.0.1:3000
character_name=Лада
token_file=/absolute/path/to/character-harness/secrets/bridge_token
system_chat_enabled=false
system_chat_server=mc.agicraft.ru:25565
```

Lada is the default for new configurations. For an existing installation, change `character_name` to `Лада` and restart the client; the bridge preserves existing properties files. This controls the displayed character name, not chat filtering or the Minecraft account nickname.

`core_url` must be plain HTTP on exactly `127.0.0.1` or `localhost` with an explicit port from 1 to 65535. Credentials, any path other than `/`, query strings and fragments are rejected before the bridge token is read.

Start core, the Codex profile and the native audio worker, then restart only the test Minecraft instance. Any visible player message can prompt a reply; mentioning `Лада` is optional. The model may choose silence. The mod ignores messages from its own player UUID and applies the server-provided filter mask before forwarding visible content.

Some servers send player chat as an ordinary system message instead of signed chat. An optional adapter reads visible `<nickname> user text` lines from Fabric's GAME event, whether or not the text addresses the character. It ignores overlay messages and non-player/system notification shapes and is disabled by default. For the test server only, set `system_chat_enabled=true`; its address is pinned to `mc.agicraft.ru:25565`. Core also requires `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true` and `AUDIENCE_ID=demo-public` before accepting this event type. Configure that non-secret opt-in when starting Compose, for example `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true docker compose up --build -d core`. Because Compose defaults the variable to `false`, a later plain `docker compose up` recreates the service with system-chat ingestion silently disabled. Put the value in a gitignored `.env` instead so it survives any later start.

The system-chat nickname is spoofable display text, stored under a separate `minecraft-system:` namespace with provenance `minecraft_system_chat` and trust `unverified`. The UUID from signed Fabric chat is also stored as `unverified` server profile context; it is not proof of an online-mode identity. Neither form grants privileges or links identities across channels. System-chat ingestion is rejected outside the public demo audience.

On the signed chat path the bridge sends the UUID provided with the server chat message context, not a player nickname or a log-parser match. That UUID is a server-provided profile identifier; on offline-mode servers it does not prove a Mojang account identity. It must not be used for cross-channel identity or private-memory access. The system-chat adapter is the opposite case and sends a nickname.

Every forwarded message still uses the existing admission limits: at most 100 pending events per character and 10 new events per author per minute. When either budget is full, core rejects the event with 429 and it is not queued; the bridge logs the rejection status. These limits bound bursts and model starts, so a busy chat can exceed them.

Replies are displayed locally and acknowledged to core after display. If the client closes between display and acknowledgement, a reply may be shown again after reconnect. Voice is emitted by the existing SVC client/audio path; this mod does not manipulate the microphone or alter SVC settings.

Automated verification covers compilation and parser tests against the declared Fabric versions, plus the synthetic core → Codex → speech queue cycle. A previous live addressed line reached core via the unverified system-chat path; this does not validate the new all-message policy or an end-to-end reply/silence decision. Live inference was not part of this implementation slice.
