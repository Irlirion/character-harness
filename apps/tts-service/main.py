"""Authenticated, single-generation TTS service (native MLX Qwen)."""

from __future__ import annotations

import hmac
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

MAX_TEXT_CHARS = 300
MAX_REQUEST_BYTES = 4096
MAX_WAV_BYTES = 2_000_000
MAX_AUDIO_SECONDS = 30
TRAILING_SILENCE_SECONDS = 0.3


class AudioOutOfBounds(ValueError):
    pass


class QwenVoice:
    """Resident MLX model producing bounded mono PCM16 WAV."""

    def __init__(self):
        if sys.platform != "darwin":
            raise RuntimeError("qwen_requires_native_macos")
        import mlx.core as mx
        from mlx_audio.tts.utils import load_model

        self.mx = mx
        self.reference = None
        self.reference_text = None
        profile_path = os.environ.get("QWEN_VOICE_PROFILE")
        profile = {}
        if profile_path:
            path = Path(profile_path).resolve()
            profile = json.loads(path.read_text(encoding="utf-8"))
            self.reference = str((path.parent / profile["reference_audio"]).resolve())
            self.reference_text = profile["reference_text"]
            if not Path(self.reference).is_file() or not self.reference_text:
                raise RuntimeError("qwen_reference_missing")
            profile["model"] = str((path.parent / profile["model"]).resolve())
        self.model = load_model(os.environ.get("QWEN_MODEL", profile.get(
            "model", "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
        )))
        self.speaker = os.environ.get("QWEN_VOICE", "Serena")
        self.config = SimpleNamespace(sample_rate=self.model.sample_rate)
        # Compile/evaluate kernels before publishing readiness.
        for chunk in self.chunks("Привет!"):
            mx.eval(chunk.audio)
        mx.synchronize()

    def chunks(self, text):
        if self.reference:
            return self.model.generate(
                text=text, lang_code="Russian", ref_audio=self.reference,
                ref_text=self.reference_text, temperature=0.7,
                stream=False, max_tokens=650,
            )
        return self.model.generate(
            text=text, voice=self.speaker, lang_code="Russian", stream=True,
            streaming_interval=0.32, max_tokens=400,
        )

    def synthesize_wav(self, text, wav_file):
        import numpy as np

        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(self.config.sample_rate)
        samples = 0
        for chunk in self.chunks(text):
            self.mx.eval(chunk.audio)
            if chunk.sample_rate != self.config.sample_rate:
                raise RuntimeError("qwen_sample_rate_changed")
            audio = np.asarray(chunk.audio).reshape(-1)
            samples += audio.size
            if samples > int(self.config.sample_rate * (MAX_AUDIO_SECONDS - TRAILING_SILENCE_SECONDS)):
                raise AudioOutOfBounds()
            wav_file.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
        wav_file.writeframes(bytes(int(self.config.sample_rate * TRAILING_SILENCE_SECONDS) * 2))


def load_configuration():
    token_path = Path(os.environ.get("TTS_TOKEN_FILE", "/run/secrets/tts_token"))
    token = token_path.read_text(encoding="utf-8").strip()
    if len(token.encode("utf-8")) < 32:
        raise RuntimeError("tts_token_too_short")

    return token, QwenVoice()


class TtsServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 1
    allow_reuse_address = True

    def __init__(self, address, token, voice):
        super().__init__(address, TtsHandler)
        self.token = token
        self.voice = voice
        self.generation_slot = Lock()


class TtsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        self.request.settimeout(3)
        super().setup()

    def log_message(self, _format, *_args):
        return

    def send_json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/ready":
            self.send_json(404, {"error": "not_found"})
            return
        self.send_json(200, {"ready": True})

    def do_POST(self):
        if self.path != "/synthesize":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        if not self.server.generation_slot.acquire(blocking=False):
            self.send_json(429, {"error": "busy"})
            return

        try:
            self.connection.settimeout(3)
            if self.headers.get("Transfer-Encoding"):
                self.send_json(400, {"error": "content_length_required"})
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.send_json(411, {"error": "content_length_required"})
                return
            if length < 1:
                self.send_json(400, {"error": "body_required"})
                return
            if length > MAX_REQUEST_BYTES:
                self.send_json(413, {"error": "request_too_large"})
                return
            if self.headers.get_content_type() != "application/json":
                self.send_json(415, {"error": "application_json_required"})
                return

            try:
                request = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json(400, {"error": "invalid_json"})
                return
            if not isinstance(request, dict) or set(request) != {"text"}:
                self.send_json(400, {"error": "text_request_required"})
                return
            text = request.get("text")
            if not isinstance(text, str) or not 1 <= len(text) <= MAX_TEXT_CHARS:
                self.send_json(400, {"error": "text_length_invalid"})
                return

            try:
                buffer = io.BytesIO()
                with wave.open(buffer, "wb") as wav_file:
                    self.server.voice.synthesize_wav(text, wav_file)
                data = buffer.getvalue()
                with wave.open(io.BytesIO(data), "rb") as wav_file:
                    duration = wav_file.getnframes() / wav_file.getframerate()
                if duration <= 0 or duration > MAX_AUDIO_SECONDS or len(data) > MAX_WAV_BYTES:
                    self.send_json(422, {"error": "synthesized_audio_out_of_bounds"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)
            except AudioOutOfBounds:
                self.send_json(422, {"error": "synthesized_audio_out_of_bounds"})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
                return
            except Exception as exc:
                print(f"tts_generation_failed: {type(exc).__name__}", file=sys.stderr, flush=True)
                self.send_json(500, {"error": "synthesis_failed"})
        except TimeoutError:
            self.close_connection = True
        finally:
            self.server.generation_slot.release()

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer "):
            return False
        return hmac.compare_digest(supplied[7:].encode("utf-8"), self.server.token.encode("utf-8"))


def main():
    token, voice = load_configuration()
    host = os.environ.get("TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TTS_PORT", "3081"))
    server = TtsServer((host, port), token, voice)
    print(json.dumps({"event": "tts_ready", "sample_rate": voice.config.sample_rate}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"tts_start_failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1)
