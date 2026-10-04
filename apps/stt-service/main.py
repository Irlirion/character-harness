"""Loopback-only, bounded HTTP wrapper around in-process GigaAM v3 CTC transcription."""

from __future__ import annotations

import hmac
import json
import numpy as np
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MIN_AUDIO_BYTES = 2880  # 30 ms at CAPTURE_SAMPLE_RATE, clear of the GigaAM v3 analysis window
MAX_AUDIO_BYTES = 768_000  # mono PCM16 for eight seconds at CAPTURE_SAMPLE_RATE
MAX_TRANSCRIPT_CHARS = 1000
CAPTURE_SAMPLE_RATE = 48000
PCM_FULL_SCALE = 32768.0


class Recognizer:
    """Transcribes bounded float32 PCM to text. Only GigaamRecognizer implements it."""

    def is_loaded(self) -> bool:
        raise NotImplementedError

    def transcribe(self, samples, sample_rate: int) -> str:
        raise NotImplementedError


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
            if length < MIN_AUDIO_BYTES:
                self.send_json(400, {"error": "audio_too_short"})
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
                self.send_json(502, {"error": str(exc)})
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


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"stt_start_failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
