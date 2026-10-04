# Fabric client bridge

Client-only Fabric mod for Minecraft 1.21.11, Fabric Loader 0.19.5 and Fabric API 0.141.6. It requires no server mod. It forwards only chat messages addressed to the configured character (`@Север ...` or `Север: ...`) and shows generated replies in the local chat. The Codex engine sends the same reply to the existing speech queue.

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
character_name=Север
token_file=/absolute/path/to/character-harness/secrets/bridge_token
system_chat_enabled=false
system_chat_server=mc.agicraft.ru:25565
```

`core_url` must be plain HTTP on exactly `127.0.0.1` or `localhost` with an explicit port from 1 to 65535. Credentials, any path other than `/`, query strings and fragments are rejected before the bridge token is read.

Start core, the Codex profile and the native audio worker, then restart only the test Minecraft instance. In-game, address the character with `@Север привет` or `Север: привет`. Only addressed messages are forwarded. The mod ignores messages from its own player UUID.

Some servers send player chat as an ordinary system message instead of signed chat. An optional adapter reads only the visible `<nickname> addressed text` shape from Fabric's GAME event. It is disabled by default. For the test server only, set `system_chat_enabled=true`; its address is pinned to `mc.agicraft.ru:25565`. Core also requires `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true` and `AUDIENCE_ID=demo-public` before accepting this event type. Configure that non-secret opt-in when starting Compose, for example `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true docker compose up --build -d core`.

The system-chat nickname is spoofable display text, stored under a separate `minecraft-system:` namespace with provenance `minecraft_system_chat` and trust `unverified`. The UUID from signed Fabric chat is also stored as `unverified` server profile context; it is not proof of an online-mode identity. Neither form grants privileges or links identities across channels. System-chat ingestion is rejected outside the public demo audience.

The bridge sends the UUID provided with the server chat message context, not a player nickname or a log-parser match. That UUID is a server-provided profile identifier; on offline-mode servers it does not prove a Mojang account identity. It must not be used for cross-channel identity or private-memory access.

Replies are displayed locally and acknowledged to core after display. If the client closes between display and acknowledgement, a reply may be shown again after reconnect. Voice is emitted by the existing SVC client/audio path; this mod does not manipulate the microphone or alter SVC settings.

Current verification covers compilation against the declared Fabric versions and the synthetic core → Codex → speech queue cycle. A live addressed player message still requires restarting the test client with this mod and trying it on the server.
