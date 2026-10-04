# Minecraft voice and local speech input

The Minecraft client uses Simple Voice Chat 2.6.24. Outgoing character audio already follows the native audio path documented in [audio-worker.md](../audio-worker.md). The client mod does not add a Minecraft server plugin or a server-side voice addon.

## Addressed incoming speech

The Fabric client subscribes to Simple Voice Chat's `ClientReceiveSoundEvent.EntitySound`, which carries the remote sender UUID and short PCM frames. The MVP assumes the documented 48 kHz mono PCM16 rate. It keeps 200 ms of pre-roll and up to 150 ms of trailing silence, segments after 700 ms of silence or an end-of-transmission frame, caps each utterance at eight seconds and two concurrent speakers, and clears audio buffers after processing.

STT is disabled unless `stt_enabled=true` is set in the test client's bridge properties and the core has the independent `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true` gate enabled for the `demo-public` audience. It is accepted only on `mc.agicraft.ru:25565`. The default `stt_provider=service` posts raw PCM16LE to the authenticated loopback service at `stt_url=http://127.0.0.1:3082`; the dedicated bearer credential comes from `stt_token_file`. Requests are capped at eight seconds and time out after 20 seconds; responses are limited to 4 KiB. PCM is not logged or retained by the service. The optional `stt_provider=local` uses explicitly configured local `ffmpeg` and `whisper-cli` paths; the bridge does not fall back between providers. The bridge ignores its own player UUID and whisper frames. It forwards only text beginning with the wake name `Север`, such as `Север привет`; ambient conversation is discarded. A recent matching bot reply is suppressed to reduce echo. A recognized sender is stored in a separate `minecraft-voice:` author namespace with `minecraft_voice_stt` provenance and `unverified` trust. An online name/location match is optional observation metadata and never links that sender to another channel or grants permissions.

### Running the STT service

The service is an optional Compose profile. Create its dedicated bearer token first — the script refuses to overwrite an existing file — then download the pinned multilingual model into the ignored local directory and start the profile:

```sh
node --experimental-strip-types scripts/setup-stt-secret.ts
mkdir -p work/stt-models
curl -fL 'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small-q5_1.bin' -o work/stt-models/ggml-small-q5_1.bin
docker compose --profile stt up --build -d --wait stt
```

The image builds `whisper.cpp` at commit `927cfce34f31707e17f2bff35c349632fb9e2c3a` and runs the Python service tests during the build, so a failed transcription contract fails the image build rather than the first utterance. The service binds to host `127.0.0.1:3082`, mounts the model directory read-only, and runs as an unprivileged user on a read-only root filesystem with all capabilities dropped. Point the client at it with `stt_provider=service` and `stt_url=http://127.0.0.1:3082`, and give the test client the same token path in `stt_token_file`. To reuse an existing model copy elsewhere, set `STT_MODEL_DIR=/absolute/path/to/models` in the ignored `.env` instead of copying the file. Model rationale and measured numbers are in [stt-model-selection.md](../reviews/stt-model-selection.md); the container runs CPU-only, so the Metal latency measured on macOS does not transfer.

## Read-only awareness and basic actions

Once per second, the opted-in client sends a small local snapshot: self position/orientation/velocity/health/dimension, a local collision/support check, up to eight visible loaded players within 16 blocks, and a crosshair target. It does not scan or send chunks. UUIDs and names are client-observed server profile data, not a verified identity claim. Snapshot freshness is capped at 2.5 seconds, and reconnects receive a new session ID. Core requires a separate `BRIDGE_CLIENT_WORLD_ENABLED=true` opt-in for snapshots and action claims; it defaults to false.

Both STT and action control require `observation_enabled=true`; every option defaults to false. `agent_walk` accepts forward and strafe axes of -1, 0, or 1 (including diagonals) for 100–1200 ms and is rejected before keypress if the immediate step is blocked or unsupported. Bounded `step_status`, nearby collision block ID, and estimated step height diagnostics help explain rejections; they never bypass geometry checks, and the block scan reads at most 12 already-loaded positions. `agent_turn` is bounded to 90 degrees of yaw and 30 degrees of pitch. Core binds durable jobs to the character, audience, invocation, current epoch, fresh client session, active lease and short deadline. The client polls lease status, rechecks safety on client ticks, and releases keys on cancellation, pause/revocation, connection change, deadline, or shutdown. Results report local state observed by the client; the feature does not provide pathfinding or claim server acknowledgement.

The existing test client may need a restart to load an updated Fabric jar. Keep all new options off until the test instance is ready. Do not install a mod on the Minecraft server or enable these options in the primary client.

## Verification boundary

Offline tests cover address parsing, PCM segmentation, turn bounds, cardinal movement vectors, core request validation, and PostgreSQL action fencing with a synthetic character/audience. Fabric compilation and tests do not simulate server movement or real microphone input. The new movement and STT paths have not been tested live; an explicit user smoke test remains necessary before enabling them.
