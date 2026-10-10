# Fabric client bridge

Client-only Fabric mod for Minecraft 1.21.11, Fabric Loader 0.19.5 and Fabric API 0.141.6. It requires no server mod. It forwards only chat messages addressed to the configured character (`@Лада ...` or `Лада: ...`) and shows generated replies in the local chat. The Codex engine sends the same reply to the existing speech queue.

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
actions_enabled=false
observation_enabled=false
action_server=mc.agicraft.ru:25565
stt_enabled=false
voice_server=mc.agicraft.ru:25565
stt_url=http://127.0.0.1:3082
stt_token_file=/absolute/path/to/character-harness/secrets/stt_token
```

Lada is the default for new configurations. For an existing installation, change `character_name` to `Лада` and restart the client; the bridge preserves existing properties files. This changes addressed chat, not the Minecraft account nickname.

`core_url` must be plain HTTP on exactly `127.0.0.1` or `localhost` with an explicit port from 1 to 65535. Credentials, any path other than `/`, query strings and fragments are rejected before the bridge token is read.

Start core, the Codex profile and the native audio worker, then restart only the test Minecraft instance. In-game, address the character with `@Лада привет` or `Лада: привет`. Only addressed messages are forwarded. The mod ignores messages from its own player UUID.

Some servers send player chat as an ordinary system message instead of signed chat. An optional adapter reads only the visible `<nickname> addressed text` shape from Fabric's GAME event. It is disabled by default. For the test server only, set `system_chat_enabled=true`; its address is pinned to `mc.agicraft.ru:25565`. Core also requires `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true` and `AUDIENCE_ID=demo-public` before accepting this event type. Configure that non-secret opt-in when starting Compose, for example `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true docker compose up --build -d core`. Because Compose defaults the variable to `false`, a later plain `docker compose up` recreates the service with system-chat ingestion silently disabled. Put the value in a gitignored `.env` instead so it survives any later start.

The system-chat nickname is spoofable display text, stored under a separate `minecraft-system:` namespace with provenance `minecraft_system_chat` and trust `unverified`. The UUID from signed Fabric chat is also stored as `unverified` server profile context; it is not proof of an online-mode identity. Neither form grants privileges or links identities across channels. System-chat ingestion is rejected outside the public demo audience.

On the signed chat path the bridge sends the UUID provided with the server chat message context, not a player nickname or a log-parser match. That UUID is a server-provided profile identifier; on offline-mode servers it does not prove a Mojang account identity. It must not be used for cross-channel identity or private-memory access. The system-chat adapter is the opposite case and sends a nickname.

Replies are displayed locally and acknowledged to core after display. If the client closes between display and acknowledgement, a reply may be shown again after reconnect. Voice is emitted by the existing SVC client/audio path; this mod does not manipulate the microphone or alter SVC settings.

## Read-only awareness, movement, and incoming voice

These features are disabled by default and are pinned to `mc.agicraft.ru:25565`. Core also requires the separate `BRIDGE_CLIENT_WORLD_ENABLED=true` opt-in before it accepts observations or exposes movement to the client; this setting defaults to false. Set `observation_enabled=true` before enabling either `actions_enabled` or `stt_enabled`; the config loader rejects action/STT without observation. Core action authorization also requires a fresh observation and the active character epoch. Keep the matching core audience limited to the opted-in public demo.

The client publishes one compact local snapshot per second: its own position, yaw/pitch, velocity, health, dimension and a one-step collision/support check; at most eight loaded players within 16 blocks that pass a block raycast; and the current crosshair target. Player UUIDs and names are local server-provided observations, not externally verified identity. No chunk scan or world map is sent. Snapshots expire after 2.5 seconds, and a reconnect changes the client session ID.

`agent_walk` uses `forward` and `strafe` values of -1, 0, or 1 (back/forward and left/right, with diagonals allowed) for 100–1200 ms, after checking a short step and collision-shape support locally. A supported step down of at most 9/16 of a block is allowed to accommodate the 15/16-height dirt-path collision shape after a half-block tread; unsupported edges, larger drops, collisions and unknown chunks are still rejected. `agent_turn` changes yaw by at most 90 degrees and pitch by at most 30. Core fences jobs by character, audience, invocation, epoch, observation session, lease and deadline. The client rechecks the lease, session, screen and collision each tick and releases movement keys on completion, cancellation, disconnect or shutdown. Snapshots and failed walk evidence can include `step_status`, a nearby colliding block ID, a bounded estimated step height, and the nearest collision support block/drop within a 1.5-block diagnostic window. That lower support estimate only explains a rejection: `support_ahead` still accepts drops up to 9/16 of a block, and the estimate never authorizes walking farther. Each scan inspects at most 12 already-loaded positions and never loads chunks. Completion reports local position/rotation evidence; it does not claim server acknowledgement or pathfinding.

For background actions in the test client, keep the world open and close any inventory, pause menu, or other screen. If the game pauses when unfocused, press F3+P in the test instance to toggle “Pause on Lost Focus” off. The bridge reports an open screen as `screen_opened` and never dismisses or bypasses menus.

Incoming Simple Voice Chat transcription uses the client API's remote entity audio event, sender UUID, and 48 kHz mono PCM16 frames. The bridge keeps at most 200 ms of pre-roll, closes a segment after 700 ms of silence while retaining at most 150 ms of tail, and caps each utterance at eight seconds. It ignores own-player and whisper frames. It posts bounded PCM over authenticated loopback HTTP to the resident STT service; the dedicated token is read from `stt_token_file`. The request has a 20-second timeout and the JSON response is capped at 4 KiB. PCM buffers are cleared after processing, and the service does not retain audio. It accepts only transcripts beginning with the character wake name `Лада`; it does not continuously forward ambient conversation. Set `stt_enabled=true` only for the test server after provisioning its separate service token; the config loader rejects `stt_enabled=true` without `stt_token_file`. The resulting author is namespaced as an unverified SVC sender; a matching visible player record is attached as observation metadata without cross-channel identity linking.

The new observation, movement, and STT paths have offline schema/DB-smoke and Fabric unit/build checks. They have not been exercised in a live game, and no live movement, model inference, or microphone speech was sent during implementation. Restart only the separate test instance to load an updated jar; the primary Minecraft instance is not part of this setup.
