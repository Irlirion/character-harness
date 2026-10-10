"""Contract tests run in the TTS image build stage with a fake Piper model."""

import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


class TtsServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="tts-service-test-")
        cls.root = Path(cls.temp.name)
        module = cls.root / "modules" / "piper"
        module.mkdir(parents=True)
        cls.token = "t" * 64
        cls.token_file = cls.root / "tts_token"
        cls.token_file.write_text(cls.token + "\n", encoding="utf-8")
        cls.model = cls.root / "model.onnx"
        cls.model.write_bytes(b"fixture model")
        cls.model.with_suffix(".onnx.json").write_text("{}", encoding="utf-8")
        cls.loaded = cls.root / "model_loaded"
        cls.started = cls.root / "generation_started"
        (module / "__init__.py").write_text("", encoding="utf-8")
        (module / "voice.py").write_text("\n".join([
            "import os, time",
            "class Config:",
            "    sample_rate = 22050",
            "class PiperVoice:",
            "    config = Config()",
            "    @staticmethod",
            "    def load(model_path, config_path=None):",
            "        open(os.environ['TTS_TEST_LOADED'], 'a').write('loaded\\n')",
            "        return PiperVoice()",
            "    def synthesize_wav(self, text, wav_file):",
            "        wav_file.setnchannels(1); wav_file.setsampwidth(2); wav_file.setframerate(22050)",
            "        if text == 'hold':",
            "            open(os.environ['TTS_TEST_STARTED'], 'w').close()",
            "            time.sleep(0.8)",
            "        if text == 'too_long_audio':",
            "            wav_file.writeframes(b'\\0\\0' * 22050 * 31)",
            "        else:",
            "            wav_file.writeframes(b'\\0\\0' * 128)",
        ]), encoding="utf-8")

        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = {
            **os.environ,
            "PYTHONPATH": str(cls.root / "modules"),
            "PIPER_MODEL": str(cls.model),
            "TTS_TOKEN_FILE": str(cls.token_file),
            "TTS_TEST_LOADED": str(cls.loaded),
            "TTS_TEST_STARTED": str(cls.started),
            "TTS_HOST": "127.0.0.1",
            "TTS_PORT": str(cls.port),
        }
        source = Path(__file__).with_name("main.py")
        cls.process = subprocess.Popen([sys.executable, str(source)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError(f"test_tts_service_exited_{cls.process.returncode}")
            try:
                with urllib.request.urlopen(cls.base + "/ready", timeout=0.2) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(0.03)
        else:
            raise RuntimeError("test_tts_service_not_ready")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "process", None):
            cls.process.terminate()
            try:
                cls.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=2)
        if getattr(cls, "temp", None):
            cls.temp.cleanup()

    def request(self, text, *, token=True, body=None, timeout=3):
        data = body if body is not None else json.dumps({"text": text}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.base + "/synthesize", data=data, headers=headers, method="POST")
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as response:
            return response

    def test_authentication_precedes_body_validation(self):
        response = self.request("", token=False, body=b"not json")
        self.assertEqual(response.status, 401)

    def test_request_size_text_shape_and_audio_duration_are_bounded(self):
        too_large = self.request("", body=b"x" * 5000)
        self.assertEqual(too_large.status, 413)
        too_long = self.request("x" * 301)
        self.assertEqual(too_long.status, 400)
        extra_field = self.request("hi", body=b'{"text":"hi","output_wav":"/tmp/x"}')
        self.assertEqual(extra_field.status, 400)
        too_long_audio = self.request("too_long_audio")
        self.assertEqual(too_long_audio.status, 422)

    def test_busy_generation_is_not_queued_and_client_timeout_does_not_break_service(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=0.15)
        payload = json.dumps({"text": "hold"}).encode("utf-8")
        connection.request("POST", "/synthesize", body=payload, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
        })
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not self.started.exists():
            time.sleep(0.01)
        self.assertTrue(self.started.exists())
        with self.assertRaises((TimeoutError, OSError)):
            connection.getresponse()
        connection.close()

        busy = self.request("next")
        self.assertEqual(busy.status, 429)
        time.sleep(0.9)
        success = self.request("Привет, Север.")
        self.assertEqual(success.status, 200)
        self.assertEqual(success.headers.get_content_type(), "audio/wav")
        wav = success.read()
        self.assertEqual(wav[:4], b"RIFF")
        self.assertEqual(wav[8:12], b"WAVE")
        self.assertGreater(len(wav), 44)

    def test_voice_is_loaded_once_for_resident_service(self):
        self.assertEqual(self.loaded.read_text(encoding="utf-8").strip().splitlines(), ["loaded"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
