import http.client
import json
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path

from main import SttServer, SttService, MAX_AUDIO_BYTES, read_token


TOKEN = "t" * 40


class FakeService:
    token = TOKEN

    def __init__(self, transcribe=None):
        self.inference_slot = threading.Lock()
        self.transcribe = transcribe or (lambda _audio: "Север здесь.")

    def is_loaded(self):
        return True

    def is_ready(self):
        return True


class SttServiceTest(unittest.TestCase):
    def setUp(self):
        self.server = SttServer(("127.0.0.1", 0), FakeService())
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def post(self, body, *, token=TOKEN, content_type="application/octet-stream", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        request_headers = {"Authorization": f"Bearer {token}", "Content-Type": content_type}
        request_headers.update(headers or {})
        conn.request("POST", "/transcribe", body=body, headers=request_headers)
        response = conn.getresponse()
        result = (response.status, response.read())
        conn.close()
        return result

    def test_authentication_is_checked_before_reading_body(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Authorization", "Bearer invalid")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", "768000")
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 401)
        self.assertEqual(json.loads(response.read()), {"error": "unauthorized"})
        conn.close()

    def test_audio_length_format_and_pcm_alignment_are_bounded(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", str(MAX_AUDIO_BYTES + 1))
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 413)
        self.assertEqual(json.loads(response.read())["error"], "audio_too_large")
        conn.close()
        status, body = self.post(b"123")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "pcm16_alignment_invalid")
        status, body = self.post(b"12", content_type="audio/wav")
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(body)["error"], "application_octet_stream_required")

    def test_valid_pcm_returns_only_transcript_json(self):
        status, body = self.post(b"\x00\x00" * 100)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"text": "Север здесь."})

    def test_busy_request_is_rejected_without_queueing_or_body_read(self):
        entered = threading.Event()
        release = threading.Event()
        self.server.service.transcribe = lambda _pcm: (entered.set(), release.wait(2), "готово")[-1]
        result = []

        first = threading.Thread(target=lambda: result.append(self.post(b"\x00\x00" * 100)))
        first.start()
        self.assertTrue(entered.wait(2))

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        conn.putrequest("POST", "/transcribe")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "application/octet-stream")
        conn.putheader("Content-Length", "768000")
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 429)
        self.assertEqual(json.loads(response.read()), {"error": "busy"})
        conn.close()
        release.set()
        first.join(timeout=3)
        self.assertFalse(first.is_alive())
        self.assertEqual(result[0][0], 200)

    def test_token_file_is_minimum_length(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text(TOKEN + "\n", encoding="utf-8")
            self.assertEqual(read_token(token_file), TOKEN)
            token_file.write_text("short", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "stt_token_too_short"):
                read_token(token_file)


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

        service = SttService(TOKEN, CapturingRecognizer())
        text = service.transcribe(struct.pack("<hhh", -32768, 0, 32767))

        self.assertEqual(text, "север здесь")
        self.assertEqual(captured["sample_rate"], 48000)
        self.assertEqual(captured["samples"].dtype.name, "float32")
        self.assertAlmostEqual(float(captured["samples"][0]), -1.0, places=6)
        self.assertAlmostEqual(float(captured["samples"][1]), 0.0, places=6)
        self.assertAlmostEqual(float(captured["samples"][2]), 32767 / 32768, places=6)


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
            body=b"\x00\x00" * 100,
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

    def test_unloaded_recognizer_is_never_ready(self):
        class DarkRecognizer:
            def is_loaded(self):
                return False

            def transcribe(self, _samples, _sample_rate):
                raise AssertionError("must not transcribe while unloaded")

        self.assertEqual(self.readiness(self.serve(DarkRecognizer())), (503, {"ready": False}))

    def test_empty_audio_is_refused_before_recognition(self):
        reached = threading.Event()

        class WatchfulRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                reached.set()
                return "север"

        service = SttService(TOKEN, WatchfulRecognizer())
        with self.assertRaisesRegex(RuntimeError, "stt_audio_required"):
            service.transcribe(b"")
        self.assertFalse(reached.is_set())

    def test_empty_transcript_is_passed_through(self):
        class SilentRecognizer:
            def is_loaded(self):
                return True

            def transcribe(self, _samples, _sample_rate):
                return ""

        self.assertEqual(self.transcribe(self.serve(SilentRecognizer())), (200, {"text": ""}))


if __name__ == "__main__":
    unittest.main()
