"""Authenticated, single-generation Piper service for the local audio worker."""

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

MAX_TEXT_CHARS = 300
MAX_REQUEST_BYTES = 4096
MAX_WAV_BYTES = 2_000_000
MAX_AUDIO_SECONDS = 30


def load_configuration():
    token_path = Path(os.environ.get("TTS_TOKEN_FILE", "/run/secrets/tts_token"))
    token = token_path.read_text(encoding="utf-8").strip()
    if len(token.encode("utf-8")) < 32:
        raise RuntimeError("tts_token_too_short")

    model_path = Path(os.environ.get("PIPER_MODEL", "/models/ru_RU-dmitri-medium.onnx"))
    if not model_path.is_absolute() or not model_path.is_file():
        raise RuntimeError("piper_model_missing")

    from piper.voice import PiperVoice

    voice = PiperVoice.load(model_path, config_path=Path(f"{model_path}.json"))
    return token, voice


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
    host = os.environ.get("TTS_HOST", "0.0.0.0")
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
