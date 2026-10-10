# GigaAM v3 CTC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whisper.cpp backend of the STT service with GigaAM v3 CTC int8 running in-process through `onnx-asr`, and delete the whisper-specific code paths from the service, the Fabric bridge and the container.

**Architecture:** `SttService` keeps its HTTP-facing surface and delegates recognition to a `Recognizer` seam. `GigaamRecognizer` owns the ONNX session, imports `onnx_asr` lazily so tests need no ML dependency, and is the only place that knows the model exists. ffmpeg, `subprocess`, tempfiles and the multipart upload are deleted; resampling happens inside `onnx-asr`.

**Tech Stack:** Python 3.12, `onnx-asr==0.12.0`, `onnxruntime==1.30.0`, `numpy==2.5.3`, Java 21 + Fabric Loom (client bridge), Node 24 + `node --test` (existing suites), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-04-gigaam-v3-stt-service-design.md`

**Pinned model:** `istupakov/gigaam-v3-onnx` at revision `322c3b29492673eb7d0b434bfa9dfb8653e34d02`, MIT.

---

## File Structure

**Created:**
- `apps/stt-service/requirements.txt` — exact dependency pins for the runtime image.
- `scripts/stt-smoke.ts` — repeatable end-to-end check against a running service.

**Deleted:**
- `client-bridge/src/main/java/dev/characterharness/bridge/LocalWhisper.java` — the `stt_provider=local` implementation. No test referenced it.

**Modified:**
- `apps/stt-service/main.py` — recognizer seam, GigaAM adapter, `main()` wiring, error codes.
- `apps/stt-service/test_main.py` — fake recognizer instead of mocked HTTP backend.
- `Dockerfile.stt` — drop the `whisper-build` stage, install pinned wheels.
- `compose.yaml` — `STT_MODEL_DIR` replaces `STT_MODEL`, drop `WHISPER_SERVER*`, `mem_limit` 3g.
- `client-bridge/src/main/java/dev/characterharness/bridge/BridgeConfig.java` — drop provider and whisper fields.
- `client-bridge/src/main/java/dev/characterharness/bridge/ClientBridge.java` — single transcription path.
- `client-bridge/README.md` — drop three config keys from the example.
- `docs/reviews/stt-model-selection.md` — rewrite as the decision record for GigaAM v3.
- `docs/integrations/minecraft-voice.md` — new provisioning steps, drop whisper references.

**Unchanged on purpose:** `client-bridge/src/test/java/dev/characterharness/bridge/SttServiceClientTest.java` talks to a local `HttpServer` and never depended on the backend.

---

### Task 1: Recognizer seam and exact PCM conversion

**Files:**
- Modify: `apps/stt-service/main.py:1-113` (imports, constants, `SttService` only)
- Test: `apps/stt-service/test_main.py`

This task touches only the service class. `main()` and its subprocess plumbing are replaced in Task 2, so every commit in this plan leaves the tree working.

- [ ] **Step 1: Write the failing conversion test**

In `apps/stt-service/test_main.py`, add `import struct` to the imports and add `import numpy as np`. Import `MIN_AUDIO_BYTES` alongside `MAX_AUDIO_BYTES` from `main`, and add the module-level constant next to `TOKEN`:

```python
TOKEN = "t" * 40
VALID_PCM = b"\x00\x00" * (MIN_AUDIO_BYTES // 2)
```

`VALID_PCM` is the smallest payload the service will accept, so every test that needs a request to reach recognition uses it. Delete the whole `TranscriptionPipelineTest` class and replace it with:

```python
class RecognizerConversionTest(unittest.TestCase):
    def test_pcm16_is_scaled_to_float32_at_the_capture_rate(self):
        captured = {}

        class CapturingRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, samples, sample_rate):
                captured["samples"] = samples
                captured["sample_rate"] = sample_rate
                return "север здесь"

        probe = struct.pack("<hhh", -32768, 0, 32767)
        service = SttService(TOKEN, CapturingRecognizer())
        text = service.transcribe(probe + b"\x00" * (MIN_AUDIO_BYTES - len(probe)))

        self.assertEqual(text, "север здесь")
        self.assertEqual(captured["sample_rate"], 48000)
        self.assertEqual(captured["samples"].dtype.name, "float32")
        self.assertAlmostEqual(float(captured["samples"][0]), -1.0, places=6)
        self.assertAlmostEqual(float(captured["samples"][1]), 0.0, places=6)
        self.assertAlmostEqual(float(captured["samples"][2]), 32767 / 32768, places=6)
```

The three probe samples stay at indices 0, 1 and 2; the trailing zero padding only clears `MIN_AUDIO_BYTES`, which six bytes of PCM would not.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```sh
cd apps/stt-service && python3 -m unittest test_main.RecognizerConversionTest -v
```
Expected: FAIL — `TypeError: SttService.__init__() takes 4 positional arguments but 3 were given`, because the current signature is `(token, backend_url, ffmpeg, backend)`.

- [ ] **Step 3: Add the seam and replace the service class**

In `apps/stt-service/main.py`, add `import numpy as np` after `import json`. Replace the constants block:

```python
MIN_AUDIO_BYTES = 2880  # 30 ms at CAPTURE_SAMPLE_RATE, clear of the GigaAM v3 analysis window
MAX_AUDIO_BYTES = 768_000  # mono PCM16 for eight seconds at CAPTURE_SAMPLE_RATE
MAX_TRANSCRIPT_CHARS = 1000
CAPTURE_SAMPLE_RATE = 48000
PCM_FULL_SCALE = 32768.0
```

`MIN_AUDIO_BYTES` is a floor rather than a feature. The GigaAM v3 preprocessor applies a 320-sample sliding window at 16 kHz with no padding, so a shorter waveform raises `ValueError` inside numpy; without this floor the blanket `except Exception` would report malformed input as a 502 service fault instead of a 400 client error.

There is deliberately no `MAX_TRANSCRIPT_BYTES` guard. At most 1000 code points times 4 UTF-8 bytes is exactly 4000, so a strict `> 4000` byte check can never fire and the bound is already enforced by the character limit.

`BACKEND_TIMEOUT_SECONDS` and `BACKEND_STARTUP_TIMEOUT_SECONDS` are removed in Task 2 along with the code that used them.

Insert the seam class immediately before `class SttService:`:

```python
class Recognizer:
    """Transcribes bounded float32 PCM to text. Only GigaamRecognizer implements it."""

    def is_loaded(self) -> bool:
        raise NotImplementedError

    def transcribe(self, samples, sample_rate: int) -> str:
        raise NotImplementedError
```

Replace the whole `SttService` class with:

```python
class SttService:
    def __init__(self, token: str, recognizer: Recognizer):
        if len(token.encode("utf-8")) < 32:
            raise RuntimeError("stt_token_too_short")
        self.token = token
        self.recognizer = recognizer
        self.inference_slot = threading.Lock()

    def is_ready(self) -> bool:
        return self.recognizer.is_loaded()

    def transcribe(self, audio: bytes) -> str:
        if len(audio) == 0:
            raise RuntimeError("audio_required")
        if len(audio) % 2:
            raise RuntimeError("pcm16_alignment_invalid")
        if len(audio) < MIN_AUDIO_BYTES:
            raise RuntimeError("audio_too_short")
        samples = np.frombuffer(audio, dtype="<i2").astype(np.float32) / PCM_FULL_SCALE
        try:
            text = self.recognizer.transcribe(samples, CAPTURE_SAMPLE_RATE)
        except Exception as error:
            raise RuntimeError("stt_recognition_failed") from error
        if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT_CHARS:
            raise RuntimeError("stt_recognition_failed")
        return text
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```sh
cd apps/stt-service && python3 -m unittest test_main.RecognizerConversionTest -v
```
Expected: PASS.

- [ ] **Step 5: Write the failure-mode tests**

Add to `apps/stt-service/test_main.py`:

```python
class _RecordingRecognizer:
    def is_loaded(self):
        return True

    def transcribe(self, samples, sample_rate):
        return "север"


class RecognitionFailureTest(unittest.TestCase):
    def serve(self, recognizer):
        server = SttServer(("127.0.0.1", 0), SttService(TOKEN, recognizer))
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return port

    def transcribe(self, port):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request(
            "POST",
            "/transcribe",
            body=VALID_PCM,
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/octet-stream"},
        )
        response = conn.getresponse()
        result = (response.status, json.loads(response.read()))
        conn.close()
        return result

    def readiness(self, port):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/ready")
        response = conn.getresponse()
        result = (response.status, json.loads(response.read()))
        conn.close()
        return result

    def test_failed_inference_is_a_502_and_leaves_the_service_ready(self):
        class FailingRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                raise ValueError("onnxruntime blew up")

        port = self.serve(FailingRecognizer())
        self.assertEqual(self.transcribe(port), (502, {"error": "stt_recognition_failed"}))
        self.assertEqual(self.readiness(port), (200, {"ready": True}))

    def test_oversized_transcript_is_rejected(self):
        class LoudRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                return "я" * 1001

        self.assertEqual(self.transcribe(self.serve(LoudRecognizer())), (502, {"error": "stt_recognition_failed"}))

    def test_char_limit_is_the_only_transcript_bound(self):
        class WideRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                return "\U0001f600" * 1000

        self.assertEqual(self.transcribe(self.serve(WideRecognizer())), (200, {"text": "\U0001f600" * 1000}))

    def test_non_string_transcript_is_rejected(self):
        class BrokenRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                return None

        self.assertEqual(self.transcribe(self.serve(BrokenRecognizer())), (502, {"error": "stt_recognition_failed"}))

    def test_unloaded_recognizer_is_never_ready(self):
        class DarkRecognizer:
            def is_loaded(self):
                return False

            def transcribe(self, _samples, _sample_rate):
                raise AssertionError("must not transcribe while unloaded")

        self.assertEqual(self.readiness(self.serve(DarkRecognizer())), (503, {"ready": False}))

    def test_empty_and_misaligned_audio_are_refused_before_recognition(self):
        reached = threading.Event()

        class WatchfulRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                reached.set()
                return "север"

        service = SttService(TOKEN, WatchfulRecognizer())
        with self.assertRaisesRegex(RuntimeError, "^audio_required$"):
            service.transcribe(b"")
        with self.assertRaisesRegex(RuntimeError, "^pcm16_alignment_invalid$"):
            service.transcribe(b"\x01")
        self.assertFalse(reached.is_set())

    def test_too_short_audio_is_a_client_error(self):
        service = SttService(TOKEN, _RecordingRecognizer())
        with self.assertRaisesRegex(RuntimeError, "^audio_too_short$"):
            service.transcribe(b"\x00\x00" * 100)

    def test_empty_transcript_is_passed_through(self):
        class SilentRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                return ""

        self.assertEqual(self.transcribe(self.serve(SilentRecognizer())), (200, {"text": ""}))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```sh
cd apps/stt-service && python3 -m unittest test_main.RecognitionFailureTest -v
```
Expected: PASS. The handler already maps any `RuntimeError` that is not `stt_backend_unavailable` to 502, so `stt_recognition_failed` needs no handler change yet.

- [ ] **Step 7: Reshape `FakeService` for the new seam**

In `apps/stt-service/test_main.py`, replace the `FakeService` class with:

```python
class FakeService:
    token = TOKEN

    def __init__(self, transcribe=None):
        self.inference_slot = threading.Lock()
        self.transcribe = transcribe or (lambda _audio: "Север здесь.")

    def is_ready(self):
        return True
```

`is_loaded` is deleted: `FakeService` stands in for `SttService`, and only a real `SttService` now delegates readiness to its recognizer.

`SttServiceTest` needs no other change at this point: the handler only touches `service.token`, `service.is_ready()`, `service.inference_slot` and `service.transcribe(audio)`, and `FakeService.transcribe` bypasses `SttService.transcribe` entirely, so `MIN_AUDIO_BYTES` does not constrain its 200-byte payloads yet. Task 2 Step 3 adds the matching floor to the handler and raises them to `VALID_PCM`.

- [ ] **Step 8: Run the whole Python suite**

Run:
```sh
cd apps/stt-service && python3 -m unittest test_main -v
```
Expected: all tests PASS, including the pre-existing HTTP contract tests and the busy test that overrides `service.transcribe`.

- [ ] **Step 9: Commit**

```sh
git add apps/stt-service/main.py apps/stt-service/test_main.py
git commit -m "refactor(stt): route transcription through a recognizer seam"
```

---

### Task 2: GigaAM adapter and service startup

**Files:**
- Modify: `apps/stt-service/main.py` (imports, `GigaamRecognizer`, `wait_for_backend`, `main`, handler error mapping)

- [ ] **Step 1: Add the `GigaamRecognizer` class**

Insert this class immediately after the `SttService` class in `apps/stt-service/main.py`:

```python
class GigaamRecognizer(Recognizer):
    def __init__(self, model_dir: Path, threads: int):
        self.model_dir = model_dir
        self.threads = max(1, threads)
        self.adapter = None

    def is_loaded(self) -> bool:
        return self.adapter is not None

    def load(self) -> None:
        # Imported here so the contract tests run without onnxruntime or the model.
        import onnx_asr
        import onnxruntime as rt

        options = rt.SessionOptions()
        options.intra_op_num_threads = self.threads
        options.inter_op_num_threads = 1
        self.adapter = onnx_asr.load_model(
            "gigaam-v3-ctc",
            self.model_dir,
            quantization="int8",
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    def transcribe(self, samples, sample_rate: int) -> str:
        if self.adapter is None:
            raise RuntimeError("gigaam_not_loaded")
        return self.adapter.recognize(samples, sample_rate=sample_rate)
```

- [ ] **Step 2: Replace `wait_for_backend` and `main`**

Delete the `wait_for_backend` function entirely. Replace `main()` with:

```python
def main():
    token = read_token(Path(os.environ.get("STT_TOKEN_FILE", "/run/secrets/stt_token")))
    model_dir = Path(os.environ.get("STT_MODEL_DIR", "/models"))
    threads = int(os.environ.get("STT_CPU_THREADS", "4"))
    if (
        not model_dir.is_absolute()
        or not (model_dir / "config.json").is_file()
        or not (model_dir / "v3_ctc.int8.onnx").is_file()
        or not (model_dir / "v3_vocab.txt").is_file()
    ):
        raise RuntimeError("stt_configuration_invalid")
    recognizer = GigaamRecognizer(model_dir, threads)
    recognizer.load()
    recognizer.transcribe(np.zeros(MIN_AUDIO_BYTES // 2, dtype=np.float32), CAPTURE_SAMPLE_RATE)

    service = SttService(token, recognizer)
    bind_host = os.environ.get("STT_HOST", "0.0.0.0")
    bind_port = int(os.environ.get("STT_PORT", "3082"))
    server = SttServer((bind_host, bind_port), service)

    def request_shutdown(_signal, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    print(json.dumps({"event": "stt_ready", "model": "gigaam-v3-ctc", "language": "ru"}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
```

- [ ] **Step 3: Simplify the handler error mapping**

In `SttHandler.do_POST`, replace:

```python
            try:
                text = self.server.service.transcribe(audio)
            except RuntimeError as exc:
                code = 504 if str(exc) == "stt_backend_unavailable" else 502
                self.send_json(code, {"error": str(exc)})
                return
            self.send_json(200, {"text": text})
```

with:

```python
            try:
                text = self.server.service.transcribe(audio)
            except RuntimeError as exc:
                self.send_json(502, {"error": str(exc)})
                return
            self.send_json(200, {"text": text})
```

There is no longer a 504 path: 504 previously meant "the backend process is gone, restart me", and there is no separate process any more.

The same step also adds a length floor to `do_POST`, immediately after the existing `audio_too_large` block and before the `pcm16_alignment_invalid` check, so that the HTTP layer owns the invariant `SttService.transcribe` already enforces:

```python
            if length < MIN_AUDIO_BYTES:
                self.send_json(400, {"error": "audio_too_short"})
                return
```

This floor invalidates three `SttServiceTest` payloads, which are 200 bytes each, so raise them in the same step:

- `test_valid_pcm_returns_only_transcript_json`: `self.post(b"\x00\x00" * 100)` becomes `self.post(VALID_PCM)`.
- `test_busy_request_is_rejected_without_queueing_or_body_read`: the same `self.post(b"\x00\x00" * 100)` becomes `self.post(VALID_PCM)`, otherwise the request is refused before `transcribe` runs and `entered.wait(2)` times out.
- `test_audio_length_format_and_pcm_alignment_are_bounded`: `self.post(b"123")` becomes `self.post(b"\x00" * (MIN_AUDIO_BYTES + 1))`, staying odd so it still tests misalignment rather than the floor, and `self.post(b"12", content_type="audio/wav")` becomes `self.post(VALID_PCM, content_type="audio/wav")`, staying above the floor while still being the wrong content type.

That last test also gains the handler-side case for the new floor, asserted with a deliberately short body:

```python
        status, body = self.post(b"\x00\x00" * 100)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "audio_too_short")
```

- [ ] **Step 4: Delete the now-dead imports**

In `apps/stt-service/main.py`, delete these import lines: `import subprocess`, `import time`, `import urllib.error`, `import urllib.request`. Those four are all that remain at this point: `import socket`, `import tempfile` and `import wave` were already removed in Task 1 along with the ffmpeg and multipart code. Keep `import hmac`, `import json`, `import os`, `import signal`, `import sys`, `import threading`.

The module docstring becomes:

```python
"""Loopback-only, bounded HTTP wrapper around in-process GigaAM v3 CTC transcription."""
```

- [ ] **Step 5: Run the Python suite**

Run:
```sh
cd apps/stt-service && python3 -m unittest test_main -v
```
Expected: 14 tests, all PASS. This expectation only holds because Step 3 also raised the three `SttServiceTest` payloads to `VALID_PCM`; skip that and the suite is red with 400s where 200s are asserted. No test constructs a real `GigaamRecognizer`, so the lazy imports never execute.

- [ ] **Step 6: Verify the lazy import and the absence of dead code**

Run:
```sh
cd apps/stt-service && python3 -c "import main; print(main.GigaamRecognizer.__name__)"
```
Expected: prints `GigaamRecognizer` with no `ModuleNotFoundError`, proving `onnx_asr` is not imported at module load.

Run:
```sh
grep -rn "subprocess\|tempfile\|ffmpeg\|multipart\|urllib\|wave\|stt_backend\|BACKEND_" apps/stt-service/main.py
```
Expected: no matches.

- [ ] **Step 7: Commit**

```sh
git add apps/stt-service/main.py apps/stt-service/test_main.py
git commit -m "feat(stt): transcribe with GigaAM v3 CTC int8 in process"
```

---

### Task 3: Dependencies and container image

**Files:**
- Create: `apps/stt-service/requirements.txt`
- Modify: `Dockerfile.stt`

- [ ] **Step 1: Create the pinned requirements file**

Create `apps/stt-service/requirements.txt`:

```
numpy==2.5.3
onnx-asr==0.12.0
onnxruntime==1.30.0
```

These satisfy `onnx-asr==0.12.0`, which requires `numpy>=1.22.4` and `onnxruntime>=1.18.1` while excluding `1.24.1`, `1.25.*` and `1.26.0`. `numpy==2.5.3` requires Python `>=3.12`, matching the `python:3.12-slim-bookworm` base. `onnxruntime==1.30.0` ships a `cp312 manylinux_2_28_aarch64` wheel, so the image builds on Apple Silicon.

- [ ] **Step 2: Rewrite `Dockerfile.stt`**

Replace the whole file with:

```dockerfile
FROM python:3.12-slim-bookworm AS service-tests
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY apps/stt-service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir "$(grep -m1 '^numpy==' /tmp/requirements.txt)"
COPY apps/stt-service/main.py /app/main.py
COPY apps/stt-service/test_main.py /app/test_main.py
RUN python /app/test_main.py

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    ORT_DISABLE_TELEMETRY=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY apps/stt-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
    && pip freeze \
    && groupadd --system --gid 10002 stt \
    && useradd --system --uid 10002 --gid 10002 --home-dir /nonexistent --shell /usr/sbin/nologin stt
WORKDIR /app
COPY --from=service-tests /app/main.py /app/main.py
USER 10002:10002
EXPOSE 3082
ENTRYPOINT ["python", "/app/main.py"]
```

The `whisper-build` stage is gone, along with `ca-certificates`, `cmake`, `build-essential`, `git`, `pkg-config` and `ffmpeg`.

`libstdc++6` stays as deliberate insurance against a base-image change, at zero cost, because the base image already ships it. `libgomp1` is **not** installed and never was required: ONNX Runtime's `DT_NEEDED` on both the aarch64 and x86_64 wheels is only `libc, libdl, libgcc_s, libm, libpthread, librt, libstdc++`. Loading and inference succeed on a bare `python:3.12-slim-bookworm` with no apt packages at all.

`ORT_DISABLE_TELEMETRY=1` keeps the privacy property in the image rather than in `compose.yaml`. With `HOME=/nonexistent`, ORT otherwise logs `Failed to persist telemetry device ID` and, wherever `HOME` is writable, writes a persistent machine identifier plus an `onnxruntime.db` SQLite event database. Only `read_only: true` in compose was preventing that.

`COPY --from=service-tests` is load-bearing, not incidental. The runtime stage must depend on the test stage so that BuildKit keeps it in the graph: BuildKit prunes any stage that is not an ancestor of the target, so a plain `COPY apps/stt-service/main.py` in the runtime stage means a default `docker compose build stt` never runs `RUN python /app/test_main.py`. Keep the two-base split — `service-tests` installs only numpy, `runtime` installs all three pins — and do **not** fold them into a shared `dependencies` base the way `Dockerfile.tts` does, because that base would install `onnxruntime` and destroy the property that makes the test stage worth having: proof that the contract tests need no ML dependency, and therefore that `GigaamRecognizer.load()`'s lazy import is intact.

`pip freeze` records the three transitive distributions that the pins do not cover (`flatbuffers`, `packaging`, `protobuf`, the last with no ceiling from ONNX Runtime) in the build log.

`requirements.txt` is the single source of the numpy pin. The `service-tests` stage reads it with `grep -m1 '^numpy=='` instead of repeating the version, because two independently written pins drift silently: with the two disagreeing, `docker build` still exits 0 while the contract tests validate against a numpy that never runs in production. The accepted cost is that the test stage's cache key now tracks the whole file, so an `onnxruntime` bump re-runs the 6-second test stage. One source of truth beats a cache hit.

The runtime stage copies `requirements.txt` to `/app/requirements.txt` and does **not** delete it. `rm` in a later layer cannot remove an earlier layer's bytes — it only records a whiteout — so the file survives in the image regardless, and the `rm` bought nothing but an extra layer. Shipping it visibly is better: the running container's declared inputs can be diffed against `pip freeze` output without re-deriving them.

- [ ] **Step 3: Verify the contract tests pass inside the image build**

Run:
```sh
docker build --no-cache --target service-tests -f Dockerfile.stt -t character-harness-stt-tests .
```
Expected: the build succeeds and the log ends with `OK` from `unittest`. This stage installs only numpy, which proves the lazy `onnx_asr` import keeps the contract tests dependency-free. `--no-cache` is required: on a cached rebuild BuildKit reports each step as `CACHED` and replays no stdout, so the `OK` this step asserts is absent on every re-run and the check would fail on a correct tree.

- [ ] **Step 4: Build the runtime image**

Run:
```sh
docker build --target runtime -f Dockerfile.stt -t character-harness-stt:latest .
docker images | grep character-harness-stt
```
Expected: the build succeeds and the image is listed.

- [ ] **Step 5: Assert the default build runs the contract tests**

Run:
```sh
set -o pipefail
docker build --no-cache -f Dockerfile.stt -t character-harness-stt:latest . 2>&1 | tee /tmp/stt-build.log
grep -c ' OK$' /tmp/stt-build.log
```
Expected: `1` or more. **If it prints `0`, stop and fix `Dockerfile.stt` before committing.**

`set -o pipefail` is load-bearing. Without it the pipeline's exit status is `tee`'s, which is always `0`, so a build that printed `ERROR: failed to solve` would still report success while the grep found its `OK` from an earlier step. `service-tests` and `runtime` build in parallel, so the `runtime` `pip install` can fail *after* the tests have already printed `OK`; only `pipefail` makes the build's own status survive the pipe.

The marker is `' OK$'`, not `^OK$` and not the test count. BuildKit prefixes each stdout line with a step id such as `#13 `, so an anchored `^OK$` matches nothing; the trailing space anchors it to the end of the line instead. A count-based marker like `Ran 14 tests` would also fail the moment anyone adds a 15th test, sending a maintainer to edit `Dockerfile.stt` in response to a test-count change. A `0` has exactly three causes: the `runtime` stage has no dependency edge on `service-tests`, so BuildKit pruned the test stage as a non-ancestor; or the build was fully cached and replayed no stdout; or the test run did not complete. The first is the one-line fix, `COPY apps/stt-service/main.py /app/main.py` in the `runtime` stage in place of `COPY --from=service-tests /app/main.py /app/main.py`. The second is why `--no-cache` is in the command: on a fully cached build BuildKit reports each step as `CACHED` and does not replay stdout, so without it this assertion fails on a correct tree and gets deleted instead of fixed.

Step 4 cannot detect the pruning regression, but not for the reason it first appears. Building `--target runtime` builds `runtime` **and all its ancestors**, so with the current `COPY --from=service-tests` edge it does run the contract tests and does print `OK`. Its blind spot is conditional, not structural: with the regression present the edge is gone, `service-tests` stops being an ancestor, and `--target runtime` then prunes it and reports success with the tests never executed. Step 3 has a different and simpler blind spot — naming `--target service-tests` never builds `runtime` at all, so it cannot observe the pruning. The default build is what `docker compose build stt` actually performs, and it exercises both stages in one pass, which is why it is the gate.

The repo's root `Dockerfile:1` puts `pnpm typecheck && pnpm test` in a shared base so its `runtime` stage inherits the tests as ancestors. `Dockerfile.stt` deliberately does not follow that pattern: its test stage must install only numpy, or it would stop proving that the contract tests need no ML dependency and therefore that `GigaamRecognizer.load()`'s lazy import is intact.

- [ ] **Step 6: Commit**

```sh
git add apps/stt-service/requirements.txt Dockerfile.stt
git commit -m "build(stt): ship GigaAM runtime image without whisper.cpp"
```
then, as a second commit, so the build-graph fix is reviewable on its own:
```sh
git add Dockerfile.stt
git commit -m "build(stt): keep contract tests in the default build graph"
```

---

### Task 4: Compose service configuration

**Files:**
- Modify: `compose.yaml` — the `stt` service block

- [ ] **Step 1: Replace the environment block**

Inside the `stt:` service in `compose.yaml`, replace the environment block with:

```yaml
    environment:
      STT_TOKEN_FILE: /run/secrets/stt_token
      STT_MODEL_DIR: /models
      STT_HOST: 0.0.0.0
      STT_PORT: 3082
      STT_CPU_THREADS: ${STT_CPU_THREADS:-4}
```

The `STT_MODEL`, `WHISPER_SERVER`, `WHISPER_SERVER_HOST` and `WHISPER_SERVER_PORT` keys are deleted. The volume mount `${STT_MODEL_DIR:-./work/stt-models}:/models:ro` is unchanged, because the host-side variable was already named `STT_MODEL_DIR`.

- [ ] **Step 2: Raise the memory limit**

In the same service block, change `mem_limit: 2g` to `mem_limit: 3g` with a comment above it:

```yaml
    # Raised from 2g so the first real measurement is not an OOM kill; see plan Task 8.
    mem_limit: 3g
```

- [ ] **Step 3: Validate the compose file**

Run:
```sh
docker compose -f compose.yaml config -q
```
Expected: exit code 0, no output.

- [ ] **Step 4: Confirm no whisper variables survive**

Run:
```sh
grep -n "WHISPER\|STT_MODEL:" compose.yaml
```
Expected: no matches.

- [ ] **Step 5: Commit**

```sh
git add compose.yaml
git commit -m "build(stt): point compose at the GigaAM model directory"
```

---

### Task 5: Drop the whisper path from the Fabric bridge

**Files:**
- Modify: `client-bridge/src/main/java/dev/characterharness/bridge/BridgeConfig.java:12-61`
- Modify: `client-bridge/src/main/java/dev/characterharness/bridge/ClientBridge.java:163-165`
- Delete: `client-bridge/src/main/java/dev/characterharness/bridge/LocalWhisper.java`
- Modify: `client-bridge/README.md:34-38`

`BridgeConfig.load()` reads `FabricLoader.getInstance()`, so it is not unit testable. This task is therefore verified by compilation, the existing suite and an exhaustive grep, not by a new test. Do not invent one.

- [ ] **Step 1: Trim the record and the generated properties template**

In `BridgeConfig.java`, change the record header to:

```java
record BridgeConfig(String coreUrl, String token, String characterName, boolean systemChatEnabled, String systemChatServer,
                    boolean actionsEnabled, boolean observationEnabled, String actionServer, boolean sttEnabled, String voiceServer,
                    String sttUrl, String sttToken) {
```

Delete the `stt_provider=service\n`, `ffmpeg_path=/opt/homebrew/bin/ffmpeg\n`, `whisper_cli_path=\n` and `whisper_model_path=\n` segments from the `Files.writeString` template, leaving:

```java
            Files.writeString(path, "core_url=http://127.0.0.1:3000\ncharacter_name=Север\ntoken_file=\nsystem_chat_enabled=false\nsystem_chat_server=mc.agicraft.ru:25565\nactions_enabled=false\nobservation_enabled=false\naction_server=mc.agicraft.ru:25565\nstt_enabled=false\nvoice_server=mc.agicraft.ru:25565\nstt_url=http://127.0.0.1:3082\nstt_token_file=\n");
```

- [ ] **Step 2: Simplify the STT token load and drop the whisper validation**

Replace lines 44-61 of `BridgeConfig.java`, from `String sttProvider = properties.getProperty(...)` down to the closing brace of `load()`, with:

```java
        String sttUrl = normalizeSttUrl(properties.getProperty("stt_url", "http://127.0.0.1:3082").trim());
        String sttToken = "";
        if (sttEnabled) {
            String sttTokenPath = properties.getProperty("stt_token_file", "").trim();
            if (sttTokenPath.isEmpty()) throw new IOException("Set stt_token_file when STT is enabled");
            sttToken = Files.readString(Path.of(sttTokenPath).toAbsolutePath().normalize()).trim();
            if (sttToken.length() < 32) throw new IOException("STT service token file is invalid");
        }
        return new BridgeConfig(coreUrl, token, characterName, systemChatEnabled, systemChatServer, actionsEnabled, observationEnabled, actionServer, sttEnabled, voiceServer, sttUrl, sttToken);
    }
```

- [ ] **Step 3: Collapse the transcription branch**

In `ClientBridge.java`, replace:

```java
                String transcript = config.sttProvider().equals("service")
                        ? sttService.transcribe(segment.samples())
                        : new LocalWhisper(config).transcribe(segment.samples());
```

with:

```java
                String transcript = sttService.transcribe(segment.samples());
```

- [ ] **Step 4: Delete `LocalWhisper.java`**

Run:
```sh
git rm client-bridge/src/main/java/dev/characterharness/bridge/LocalWhisper.java
```

- [ ] **Step 5: Compile and run the Java tests**

Run:
```sh
cd client-bridge && ./gradlew test --rerun-tasks --console=plain
```
Expected: `BUILD SUCCESSFUL`. `BridgeConfigTest` needs no change because it only exercises static helpers, and no test referenced `LocalWhisper`.

- [ ] **Step 6: Update the README example**

In `client-bridge/README.md`, delete the `stt_provider=service`, `ffmpeg_path=/opt/homebrew/bin/ffmpeg`, `whisper_cli_path=...` and `whisper_model_path=...` lines from the properties block.

- [ ] **Step 7: Verify nothing whisper-related survives**

Run:
```sh
grep -rni "whisper\|ffmpeg\|stt_provider\|sttProvider" client-bridge/src client-bridge/README.md
```
Expected: no matches.

- [ ] **Step 8: Commit**

```sh
git add client-bridge
git commit -m "refactor(client): drop the local whisper transcription provider"
```

---

### Task 6: Repeatable STT smoke script

**Files:**
- Create: `scripts/stt-smoke.ts`

This script's job is readiness, auth rejection and one real transcription. It deliberately does not re-test the HTTP bounds: `test_main.py` already covers 413, 415, 400 and 429 exhaustively, and rejecting an oversized body before reading it makes a client-side `fetch` liable to `ECONNRESET`.

- [ ] **Step 1: Create the script**

Create `scripts/stt-smoke.ts`:

```typescript
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.STT_URL ?? 'http://127.0.0.1:3082';
const token = (await readFile(process.env.STT_TOKEN_FILE ?? 'secrets/stt_token', 'utf8')).trim();
const phrase = process.env.STT_SMOKE_PHRASE ?? 'Север, повернись налево';
const voice = process.env.STT_SMOKE_VOICE ?? 'Milena';
const MAX_AUDIO_BYTES = 768_000;

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

const ready = await fetch(`${base}/ready`);
assert.equal(ready.status, 200, 'service must report ready');
assert.deepEqual(await ready.json(), { ready: true });

const unauthorized = await fetch(`${base}/transcribe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: Buffer.alloc(200),
});
await unauthorized.arrayBuffer();
assert.equal(unauthorized.status, 401, 'missing bearer must be rejected');

const dir = await mkdtemp(join(tmpdir(), 'stt-smoke-'));
try {
  const aiff = join(dir, 'phrase.aiff');
  const pcm = join(dir, 'phrase.pcm');
  await run('say', ['-v', voice, '-o', aiff, phrase]);
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-f', 's16le', pcm]);
  const audio = await readFile(pcm);
  assert.equal(audio.length % 2, 0, 'PCM must stay 16-bit aligned');
  assert.ok(audio.length > 0, 'synthesis must produce audio');
  assert.ok(audio.length <= MAX_AUDIO_BYTES, `phrase must fit the 8s cap, got ${audio.length} bytes`);

  const started = Date.now();
  const response = await fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: audio,
  });
  assert.equal(response.status, 200, `unexpected status ${response.status}`);
  const { text } = await response.json() as { text: string };
  const elapsed = Date.now() - started;
  assert.equal(typeof text, 'string');
  assert.match(text, /север/i, `transcript must contain the wake name, got ${JSON.stringify(text)}`);
  console.log(`STT smoke passed in ${elapsed} ms. Transcript: ${text}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Typecheck the script**

Run:
```sh
npx tsc --noEmit
```
Expected: clean. `scripts/**/*.ts` is inside the tsconfig `include` list, so the new script is typechecked.

- [ ] **Step 3: Commit**

```sh
git add scripts/stt-smoke.ts
git commit -m "test(stt): add a repeatable smoke check against the live service"
```

The script needs a running service, so it is first executed in Task 8. Do not claim it passes before then.

---

### Task 7: Documentation

**Files:**
- Rewrite: `docs/reviews/stt-model-selection.md`
- Modify: `docs/integrations/minecraft-voice.md:9-22` (line 9 provider prose, plus the "Running the STT service" section)

- [ ] **Step 1: Rewrite the decision record**

Replace `docs/reviews/stt-model-selection.md` with:

````markdown
# Выбор STT-модели

Дата последнего пересмотра: 2026-10-04.

## Решение

**GigaAM v3 CTC int8** (`istupakov/gigaam-v3-onnx`, ревизия
`322c3b29492673eb7d0b434bfa9dfb8653e34d02`, MIT) через `onnx-asr==0.12.0`.
Whisper.cpp и multilingual `small-q5_1` отклонены и удалены из проекта.

## Почему

Официальная таблица GigaAM (evaluation.md) даёт для русского средний WER 9.1 у `v3_ctc`
против 21.0 у Whisper large-v3; на Common Voice 19 — 1.3 против 5.5. Независимый замер на
Common Voice RU: GigaAM CTC 8.6% WER при p50 0.08 s против 13.2% WER и 0.94 s у Whisper
small int8 (beam=1). Для короткой голосовой команды задержка значима не меньше точности.

Размер int8: `v3_ctc.int8.onnx` — 214.31 MB, что меньше 236 MB у GigaAM v2 и 181 MiB у
Whisper small-q5_1. Предобучение v3 — 700k часов против 50k у v2; на доменах callcenter,
музыка, нестандартная речь и голосовые сообщения WER ниже в среднем на 30%.

Многоязычная линейка не рассматривалась: на русском она заметно слабее (Russian CV WER 7.1
у 220M против 1.3 у v3 CTC), а многоязычность в проекте не используется — wake name и
команды только русские.

## Закрепление

| Файл | Размер | SHA-256 |
| --- | --- | --- |
| `v3_ctc.int8.onnx` | 214.31 MB | `ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd` |
| `config.json` | — | `0641fcf73f4af791c73f05083e38a658ff5dcbee3534a0c61396c10f4b97f0fe` |
| `v3_vocab.txt` | — | `a9143c30844d3c0bee3e9e927e4084774eb1b9eeaafc473b2c4521e4911a7c07` |
| `LICENSE.txt` | — | `f00de6715714c7a63d08639cdbfaa40224eefc407302614bd19f1a8b98c875aa` |

Словарь — 34 токена: `▁`, 32 кириллических символа и `<blk>`. Выход CTC: greedy-collapse,
`▁` превращается в пробел, `<blk>` отбрасывается. Регистра и пунктуации в выходе нет,
что для матчинга wake name является плюсом.

## Ограничения применимости

- Конверсия `istupakov/gigaam-v3-onnx` сторонняя. Препроцессинг корректен, потому что
  используется библиотека того же автора, но сам факт конверсии верифицирован только
  проверкой осмысленности транскрипта.
- Замеры выше публичные. Сравнения whisper small и GigaAM на живой игровой речи не
  проводилось; Whisper small может оказаться лучше на игровых командах.
- Потребление памяти контейнера: см. раздел «Измерения». До измерения порог compose
  поднят до 3g, чтобы получить число вместо неизвестности.
- Лицензии не переносятся между историческими вариантами GigaAM автоматически: важен
  конкретный checkpoint. Отдельный sherpa bundle 2024-10-24 помечен non-commercial и не
  рассматривается.

## Измерения

Заполняется по результатам Task 8 плана: потребление памяти контейнера, latency на
синтетической фразе, фактический транскрипт.

## Ссылки

- [GigaAM evaluation.md: WER по русским наборам](https://github.com/salute-developers/GigaAM/blob/main/evaluation.md).
- [GigaAM README: линейки v1–v3 и multilingual](https://github.com/salute-developers/GigaAM/blob/main/README_ru.md).
- [istupakov/gigaam-v3-onnx на закреплённой ревизии](https://huggingface.co/istupakov/gigaam-v3-onnx/tree/322c3b29492673eb7d0b434bfa9dfb8653e34d02).
- [onnx-asr: загрузка локальной модели и ресемплинг](https://istupakov.github.io/onnx-asr/usage/).
- [sherpa-onnx: явное предупреждение non-commercial для бандла GigaAM 2024-10-24](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html#sherpa-onnx-nemo-transducer-giga-am-russian-2024-10-24).
````

- [ ] **Step 2: Update the provisioning steps**

In `docs/integrations/minecraft-voice.md`, replace the `sh` code block in the "Running the STT service" section with:

````markdown
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
````

Then replace the paragraph describing the whisper.cpp build with:

```markdown
The image installs pinned `onnx-asr`, `onnxruntime` and `numpy` wheels and runs the Python service tests during the build, so a failed transcription contract fails the image build rather than the first utterance. The service binds to host `127.0.0.1:3082`, mounts the model directory read-only, and runs as an unprivileged user on a read-only root filesystem with all capabilities dropped. Point the client at it with `stt_url=http://127.0.0.1:3082` and give the test client the same token path in `stt_token_file`. `stt_provider` no longer exists: the service is the only transcription provider, so `ffmpeg`, `whisper-cli` and `whisper_model_path` are gone from the client configuration too. To reuse a model copy elsewhere, set `STT_MODEL_DIR=/absolute/path/to/models` in the ignored `.env` instead of copying the files. Checksums, measured numbers and the rejected alternatives are in [stt-model-selection.md](../reviews/stt-model-selection.md).
```

- [ ] **Step 3: Drop stale whisper references from the voice document**

Run:
```sh
grep -ni "whisper-cli\|whisper_model_path\|small-q5\|stt_provider=local" docs/integrations/minecraft-voice.md
```
Expected: no matches.

- [ ] **Step 4: Commit**

```sh
git add docs/reviews/stt-model-selection.md docs/integrations/minecraft-voice.md
git commit -m "docs: record the GigaAM v3 decision and new provisioning steps"
```

---

### Task 8: End-to-end verification and memory measurement

**Files:**
- Modify: `compose.yaml` if the measurement allows lowering `mem_limit` back to 2g
- Modify: `docs/reviews/stt-model-selection.md` to fill in the measurements

This task has no TDD cycle. It is the verification the previous seven tasks enable, and it produces the numbers the project has never had: does the container run, and does it fit.

- [ ] **Step 1: Provision the model**

Run the four `curl` commands from Task 7 Step 2.

- [ ] **Step 2: Verify the model checksum**

Run:
```sh
shasum -a 256 work/stt-models/v3_ctc.int8.onnx
```
Expected: `ceb61454e2e1a2dec5872cbac1de0fe0a4271d1148f6b26b5bda53ff30a12acd`.

- [ ] **Step 3: Build and start the service**

Run:
```sh
docker compose --profile stt up --build -d --wait stt
```
Expected: exits 0 once the healthcheck passes. On timeout run `docker compose logs stt` and expect either `stt_start_failed` for a missing model or a load error naming the missing config key.

- [ ] **Step 4: Run the smoke script**

Run:
```sh
node --experimental-strip-types scripts/stt-smoke.ts
```
Expected: `STT smoke passed in <N> ms. Transcript: <text containing север>`. If the wake name is missing, the conversion is producing garbage — stop and investigate rather than relaxing the assertion.

- [ ] **Step 5: Measure peak memory**

Run:
```sh
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep stt
```
Expected: a figure comfortably under 3g. Record the measured value in `docs/reviews/stt-model-selection.md` under "Измерения", and note that it is peak resident memory during the smoke transcription, not an idle figure.

- [ ] **Step 6: Lower the limit back if it fits**

If the measured peak is under roughly 1.6g, change `mem_limit: 3g` back to `mem_limit: 2g` in `compose.yaml`, remove the explanatory comment, restart with `docker compose --profile stt up -d --wait stt`, and re-run Step 4. If the peak exceeds 2g, keep 3g and say so in the review document.

- [ ] **Step 7: Run every suite**

Run:
```sh
node --experimental-strip-types --test tests/*.test.ts
npx tsc --noEmit
(cd apps/stt-service && python3 -m unittest test_main)
(cd client-bridge && ./gradlew test --rerun-tasks --console=plain)
```
Expected: 56 TS tests pass, typecheck clean, all Python tests pass, `BUILD SUCCESSFUL`.

- [ ] **Step 8: Commit the measurement**

```sh
git add compose.yaml docs/reviews/stt-model-selection.md
git commit -m "chore(stt): record measured container memory and finalize the limit"
```

---

## What This Plan Does Not Verify

The in-game path stays unverified, exactly as the spec states. It needs two participants on `mc.agicraft.ru` with Simple Voice Chat 2.6.24, one saying «Север ...» while the bridge runs with `stt_enabled=true` and `stt_token_file` set. Nothing in this plan exercises `VoiceAddress.extract`, the `minecraft-voice:` author namespace, `minecraft_voice_stt` provenance, or echo suppression against a live client.

The Java HTTP client is covered by `SttServiceClientTest` against a local server, which proves the wire contract but not the mod's audio capture from Simple Voice Chat.