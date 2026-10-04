"""Loopback-only, bounded HTTP wrapper around a resident whisper.cpp server."""

from __future__ import annotations

import hmac
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_AUDIO_BYTES = 768_000  # mono PCM16 at 48 kHz for eight seconds
MAX_TRANSCRIPT_CHARS = 1000
BACKEND_TIMEOUT_SECONDS = 18
BACKEND_STARTUP_TIMEOUT_SECONDS = 60


class SttService:
    def __init__(self, token: str, backend_url: str, ffmpeg: str = "ffmpeg", backend=None):
        if len(token.encode("utf-8")) < 32:
            raise RuntimeError("stt_token_too_short")
        self.token = token
        self.backend_url = backend_url.rstrip("/")
        self.ffmpeg = ffmpeg
        self.backend = backend
        self.inference_slot = threading.Lock()
        self.restart_requested = threading.Event()

    def is_ready(self) -> bool:
        if self.restart_requested.is_set() or self.backend is None:
            return False
        if self.backend.poll() is not None:
            self.restart_requested.set()
            return False
        try:
            with urllib.request.urlopen(f"{self.backend_url}/health", timeout=0.5) as response:
                ready = response.status == 200 and json.loads(response.read(4096)).get("status") == "ok"
                if not ready:
                    self.restart_requested.set()
                return ready
        except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, OSError):
            self.restart_requested.set()
            return False

    def transcribe(self, audio: bytes) -> str:
        with tempfile.TemporaryDirectory(prefix="stt-") as temp_dir:
            wav_path = Path(temp_dir) / "speech.wav"
            command = [
                self.ffmpeg,
                "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:0",
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav_path),
            ]
            try:
                subprocess.run(
                    command,
                    input=audio,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=5,
                    check=True,
                )
                with wave.open(str(wav_path), "rb") as pcm:
                    if pcm.getnchannels() != 1 or pcm.getframerate() != 16000 or pcm.getsampwidth() != 2:
                        raise RuntimeError("stt_resample_format_invalid")
                    if not 0 < pcm.getnframes() <= 128_000:
                        raise RuntimeError("stt_resample_duration_invalid")
                wav_bytes = wav_path.read_bytes()
            except (OSError, subprocess.SubprocessError, wave.Error) as exc:
                raise RuntimeError("stt_audio_conversion_failed") from exc

            boundary = "----character-harness-stt-boundary"
            body = b"".join((
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\n".encode(),
                b"Content-Type: audio/wav\r\n\r\n",
                wav_bytes,
                b"\r\n",
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n".encode(),
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nru\r\n".encode(),
                f"--{boundary}--\r\n".encode(),
            ))
            request = urllib.request.Request(
                f"{self.backend_url}/inference",
                data=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=BACKEND_TIMEOUT_SECONDS) as response:
                    if response.status != 200:
                        raise RuntimeError("stt_backend_failed")
                    result = json.loads(response.read(32_768))
            except urllib.error.HTTPError as exc:
                if exc.code >= 500 or exc.code == 408:
                    self.restart_requested.set()
                    raise RuntimeError("stt_backend_unavailable") from exc
                raise RuntimeError("stt_backend_failed") from exc
            except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, OSError) as exc:
                self.restart_requested.set()
                raise RuntimeError("stt_backend_unavailable") from exc
            text = result.get("text") if isinstance(result, dict) else None
            if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT_CHARS or len(text.encode("utf-8")) > 4000:
                raise RuntimeError("stt_backend_response_invalid")
            return text


class SttServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 1
    allow_reuse_address = True

    def __init__(self, address, service: SttService):
        super().__init__(address, SttHandler)
        self.service = service


class SttHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        self.request.settimeout(3)
        super().setup()

    def log_message(self, _format, *_args):
        # Request metadata can be correlated with a voice turn; never log it or recognized text.
        return

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def do_GET(self):
        if self.path != "/ready":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.server.service.is_ready():
            self.send_json(503, {"ready": False})
            return
        self.send_json(200, {"ready": True})

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_json(404, {"error": "not_found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        if not self.server.service.is_ready():
            self.send_json(503, {"error": "not_ready"})
            return
        if not self.server.service.inference_slot.acquire(blocking=False):
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
            if length < 2:
                self.send_json(400, {"error": "audio_required"})
                return
            if length > MAX_AUDIO_BYTES:
                self.send_json(413, {"error": "audio_too_large"})
                return
            if length % 2:
                self.send_json(400, {"error": "pcm16_alignment_invalid"})
                return
            if self.headers.get_content_type() != "application/octet-stream":
                self.send_json(415, {"error": "application_octet_stream_required"})
                return
            audio = self.rfile.read(length)
            if len(audio) != length:
                self.send_json(400, {"error": "audio_body_incomplete"})
                return
            try:
                text = self.server.service.transcribe(audio)
            except RuntimeError as exc:
                code = 504 if str(exc) == "stt_backend_unavailable" else 502
                self.send_json(code, {"error": str(exc)})
                return
            self.send_json(200, {"text": text})
        except (TimeoutError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True
        finally:
            self.server.service.inference_slot.release()

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer "):
            return False
        return hmac.compare_digest(
            supplied[7:].encode("utf-8"),
            self.server.service.token.encode("utf-8"),
        )


def read_token(path: Path) -> str:
    token = path.read_text(encoding="utf-8").strip()
    if len(token.encode("utf-8")) < 32:
        raise RuntimeError("stt_token_too_short")
    return token


def wait_for_backend(process: subprocess.Popen, backend_url: str):
    deadline = time.monotonic() + BACKEND_STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("whisper_server_exited_during_startup")
        try:
            with urllib.request.urlopen(f"{backend_url}/health", timeout=1) as response:
                if response.status == 200 and json.loads(response.read(4096)).get("status") == "ok":
                    return
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            time.sleep(0.2)
    raise RuntimeError("whisper_server_startup_timeout")


def main():
    token = read_token(Path(os.environ.get("STT_TOKEN_FILE", "/run/secrets/stt_token")))
    model = Path(os.environ.get("STT_MODEL", "/models/ggml-small-q5_1.bin"))
    binary = os.environ.get("WHISPER_SERVER", "/usr/local/bin/whisper-server")
    host = os.environ.get("WHISPER_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("WHISPER_SERVER_PORT", "3083"))
    threads = int(os.environ.get("STT_CPU_THREADS", "4"))
    if host != "127.0.0.1" or not model.is_absolute() or not model.is_file():
        raise RuntimeError("stt_configuration_invalid")
    backend_url = f"http://{host}:{port}"
    command = [binary, "--host", host, "--port", str(port), "-m", str(model), "-l", "ru", "-t", str(threads), "-p", "1", "-ng"]
    backend = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    server = None
    try:
        wait_for_backend(backend, backend_url)
        service = SttService(token, backend_url, backend=backend)
        bind_host = os.environ.get("STT_HOST", "0.0.0.0")
        bind_port = int(os.environ.get("STT_PORT", "3082"))
        server = SttServer((bind_host, bind_port), service)

        def stop_server_when_backend_fails():
            service.restart_requested.wait()
            if service.restart_requested.is_set():
                server.shutdown()

        threading.Thread(target=stop_server_when_backend_fails, daemon=True).start()

        def request_shutdown(_signal, _frame):
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, request_shutdown)
        signal.signal(signal.SIGINT, request_shutdown)
        print(json.dumps({"event": "stt_ready", "model": "small-q5_1", "language": "ru"}), flush=True)
        server.serve_forever(poll_interval=0.25)
        if service.restart_requested.is_set():
            raise RuntimeError("whisper_backend_failed_restart_required")
    finally:
        if server is not None:
            server.server_close()
        if backend.poll() is None:
            backend.send_signal(signal.SIGTERM)
            try:
                backend.wait(timeout=2)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=2)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"stt_start_failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1)
