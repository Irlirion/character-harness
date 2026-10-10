# Minecraft voice and local speech input

The Minecraft client uses Simple Voice Chat 2.6.24. Outgoing character audio already follows the native audio path documented in [audio-worker.md](../audio-worker.md). The client mod does not add a Minecraft server plugin or a server-side voice addon.

## Addressed incoming speech

The Fabric client subscribes to Simple Voice Chat's `ClientReceiveSoundEvent.EntitySound`, which carries the remote sender UUID and short PCM frames. The MVP assumes the documented 48 kHz mono PCM16 rate. It keeps 200 ms of pre-roll and up to 150 ms of trailing silence, segments after 700 ms of silence or an end-of-transmission frame, caps each utterance at eight seconds and two concurrent speakers, and clears audio buffers after processing.

STT is disabled unless `stt_enabled=true` is set in the test client's bridge properties and the core has the independent `BRIDGE_SYSTEM_CHAT_PUBLIC_DEMO=true` gate enabled for the `demo-public` audience. It is accepted only on `mc.agicraft.ru:25565`. The bridge posts raw PCM16LE to the authenticated loopback service at `stt_url=http://127.0.0.1:3082`; the dedicated bearer credential comes from `stt_token_file`. Requests are capped at eight seconds and time out after 20 seconds; responses are limited to 4 KiB. PCM is not logged or retained by the service. The service is the only transcription provider, so `stt_provider` no longer exists. Anyone with an existing bridge properties file must delete the four dead keys — `stt_provider`, `ffmpeg_path`, `whisper_cli_path` and `whisper_model_path` — because they are now ignored, and must also set `stt_token_file`, since without a token path the mod refuses to start and the config error it prints still names the removed provider. The bridge ignores its own player UUID and whisper frames. The GigaAM transcript carries neither case nor punctuation, so the wake-name match is case-insensitive by necessity: expect lowercase input such as `лада привет`, never `Лада, привет`. The bridge forwards only text beginning with the configured wake name `Лада`, such as `лада привет`; ambient conversation is discarded. A recent matching bot reply is suppressed to reduce echo. A recognized sender is stored in a separate `minecraft-voice:` author namespace with `minecraft_voice_stt` provenance and `unverified` trust. An online name/location match is optional observation metadata and never links that sender to another channel or grants permissions.

### Running the STT service

The service is an optional Compose profile. Provision the model before starting it: the healthcheck retries 20 times at 5 s intervals, so a container without weights spends about two minutes waiting before it reports `unhealthy` and `restart: unless-stopped` puts it into a crash loop. Create the dedicated bearer token first — the script refuses to overwrite an existing file — then download the four pinned model files into the ignored local directory, verify the weights checksum, start the profile and run the smoke check:

```sh
node --experimental-strip-types scripts/setup-stt-secret.ts
mkdir -p work/stt-models
REV=322c3b29492673eb7d0b434bfa9dfb8653e34d02
BASE=https://huggingface.co/istupakov/gigaam-v3-onnx/resolve/$REV
curl -fL "$BASE/config.json"      -o work/stt-models/config.json
curl -fL "$BASE/v3_ctc.int8.onnx" -o work/stt-models/v3_ctc.int8.onnx
curl -fL "$BASE/v3_vocab.txt"     -o work/stt-models/v3_vocab.txt
curl -fL "$BASE/LICENSE.txt"      -o work/stt-models/LICENSE.txt
shasum -a 256 work/stt-models/v3_ctc.int8.onnx
docker compose --profile stt up --build -d --wait stt
node --experimental-strip-types scripts/stt-smoke.ts
```

All four files are required. The service validates `config.json`, `v3_ctc.int8.onnx` and `v3_vocab.txt` at startup and exits with `stt_configuration_invalid` if any is missing, so a directory holding only the model file fails in a way that otherwise looks unrelated to the model. `shasum` only prints the digest — compare it against `ceb61454…a12acd` from [stt-model-selection.md](../reviews/stt-model-selection.md), which also lists the digests of the other three files.

The image installs pinned `onnx-asr`, `onnxruntime` and `numpy` wheels and runs the Python service tests during the build, so a failed transcription contract fails the image build rather than the first utterance. The service binds to host `127.0.0.1:3082`, mounts the model directory read-only, and runs as an unprivileged user on a read-only root filesystem with all capabilities dropped. Point the client at it with `stt_url=http://127.0.0.1:3082` and give the test client the same token path in `stt_token_file`. `stt_provider` no longer exists: the service is the only transcription provider, so `ffmpeg_path`, `whisper_cli_path` and `whisper_model_path` are gone from the client configuration too and there is no second provider to fall back to. To reuse a model copy elsewhere, set `STT_MODEL_DIR=/absolute/path/to/models` in the ignored `.env` instead of copying the files. That host-side variable only chooses which host directory is mounted at `/models`; the container's own `STT_MODEL_DIR` is always `/models`, so the same name in `.env` relocates the mount source and never the in-container path. Checksums, measured numbers and the rejected alternatives are in [stt-model-selection.md](../reviews/stt-model-selection.md).

## Read-only awareness and basic actions

Once per second, the opted-in client sends a small local snapshot: self position/orientation/velocity/health/dimension, a local collision/support check, up to eight visible loaded players within 16 blocks, and a crosshair target. It does not scan or send chunks. UUIDs and names are client-observed server profile data, not a verified identity claim. Snapshot freshness is capped at 2.5 seconds, and reconnects receive a new session ID. Core requires a separate `BRIDGE_CLIENT_WORLD_ENABLED=true` opt-in for snapshots and action claims; it defaults to false.

Both STT and action control require `observation_enabled=true`; every option defaults to false. `agent_walk` accepts forward and strafe axes of -1, 0, or 1 (including diagonals) for 100–1200 ms and is rejected before keypress if the immediate step is blocked or unsupported. Support is checked against actual loaded collision-shape tops beneath the destination footprint, including a bounded step down of at most 9/16 of a block to account for the dirt-path collision height after a half-block tread; deeper drops, missing support, collisions, and unknown chunks remain rejected. Bounded `step_status`, nearby collision block ID, estimated step height, and nearest support block/drop diagnostics help explain rejections. The nearest-support window extends 1.5 blocks for reporting only; walking still requires support within 9/16 of a block. Each scan reads at most 12 already-loaded positions and never loads chunks. `agent_turn` is bounded to 90 degrees of yaw and 30 degrees of pitch. Core binds durable jobs to the character, audience, invocation, current epoch, fresh client session, active lease and short deadline. The client polls lease status, rechecks safety on client ticks, and releases keys on cancellation, pause/revocation, connection change, deadline, or shutdown. Results report local state observed by the client; the feature does not provide pathfinding or claim server acknowledgement.

The existing test client may need a restart to load an updated Fabric jar. Keep all new options off until the test instance is ready. Do not install a mod on the Minecraft server or enable these options in the primary client.

## Verification boundary

Offline tests cover address parsing, PCM segmentation, turn bounds, cardinal movement vectors, collision-shape support checks, core request validation, and PostgreSQL action fencing with a synthetic character/audience. Fabric compilation and tests do not simulate server movement or real microphone input.

On 2026-10-10 the user confirmed that Lada replied and turned during a live Minecraft check. The reply channel (chat or voice) was not established, so this does not verify live STT, echo suppression, or audible speech. A fresh post-restart snapshot was grounded at y=67.5 with no collision ahead but `support_ahead=false`; the diagnostic found a loaded `minecraft:dirt_path` support top 0.5625 blocks below the feet. That is 1/16 beyond the previous cap, so the guard correctly stopped movement before an action was queued. The cap now accommodates this actual path shape at 9/16 while still rejecting deeper drops. The client needs one restart to load this final adjustment.

### Manual two-player verification

The live Minecraft speech path has not yet been verified with two participants. When both players are available on `mc.agicraft.ru:25565`, use the isolated test bridge and its dedicated STT token, then check:

1. A player says “Лада, привет”; the bridge addresses the transcript to Лада and the core records a `minecraft_voice_stt` event.
2. Лада replies through the normal in-game voice path, and the speaker can hear the reply.
3. The same reply is not transcribed back into a second event (echo suppression).
4. A movement request is admitted only while the client is connected to the configured server and its observation, epoch, lease, and session remain current; disconnect or pause cancels any claimed action.
