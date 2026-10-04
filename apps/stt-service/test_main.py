import http.client
import io
import json
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

from main import SttServer, SttService, MAX_AUDIO_BYTES, read_token


TOKEN = "t" * 40


class FakeService:
    token = TOKEN

    def __init__(self, transcribe=None):
        self.inference_slot = threading.Lock()
        self.transcribe = transcribe or (lambda pcm: "Север здесь.")

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


class TranscriptionPipelineTest(unittest.TestCase):
    def test_resamples_to_wav_and_posts_fixed_russian_multipart(self):
        captured = {}

        def fake_ffmpeg(args, **kwargs):
            self.assertEqual(kwargs["input"], b"\x01\x00" * 4800)
            self.assertEqual(args[args.index("-ar") + 1], "48000")
            output_path = Path(args[-1])
            with wave.open(str(output_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\x00\x00" * 1600)
            captured["wav_path"] = output_path
            return mock.Mock(returncode=0)

        class FakeResponse(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_args): self.close()

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse('{"text":"Север, вижу цель."}'.encode("utf-8"))

        service = SttService(TOKEN, "http://127.0.0.1:3083", ffmpeg="ffmpeg")
        with mock.patch("main.subprocess.run", side_effect=fake_ffmpeg), mock.patch(
            "main.urllib.request.urlopen", side_effect=fake_urlopen
        ):
            text = service.transcribe(b"\x01\x00" * 4800)

        self.assertEqual(text, "Север, вижу цель.")
        self.assertEqual(captured["timeout"], 18)
        self.assertIn("multipart/form-data; boundary=", captured["request"].get_header("Content-type"))
        multipart = captured["request"].data
        self.assertIn(b'name="file"; filename="speech.wav"', multipart)
        self.assertIn(b'name="language"\r\n\r\nru', multipart)
        self.assertIn(b'name="response_format"\r\n\r\njson', multipart)
        self.assertFalse(captured["wav_path"].exists(), "temporary resampled audio must be deleted")


if __name__ == "__main__":
    unittest.main()
