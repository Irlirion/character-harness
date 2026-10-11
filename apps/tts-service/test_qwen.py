"""WAV contract checks without downloading a model or requiring a GPU."""
import io
import unittest
import wave
from types import SimpleNamespace

import numpy as np

from main import AudioOutOfBounds, QwenVoice


class QwenWavTest(unittest.TestCase):
    def test_clone_uses_reference_and_russian_without_preset_speaker(self):
        voice = QwenVoice.__new__(QwenVoice)
        voice.reference = '/reference.wav'
        voice.reference_text = 'Эталон.'
        calls = []
        voice.model = SimpleNamespace(generate=lambda **kw: calls.append(kw))
        voice.chunks('Ильсур, привет!')
        self.assertEqual(calls[0]['ref_audio'], '/reference.wav')
        self.assertEqual(calls[0]['ref_text'], 'Эталон.')
        self.assertEqual(calls[0]['lang_code'], 'Russian')
        self.assertNotIn('voice', calls[0])
        self.assertFalse(calls[0]['stream'])

    def voice(self, chunks):
        voice = QwenVoice.__new__(QwenVoice)
        voice.mx = SimpleNamespace(eval=lambda _: None)
        voice.config = SimpleNamespace(sample_rate=24000)
        voice.chunks = lambda _: iter(chunks)
        return voice

    def chunk(self, audio, sample_rate=24000):
        return SimpleNamespace(audio=np.array(audio), sample_rate=sample_rate)

    def test_chunks_are_joined_as_clipped_mono_pcm16(self):
        voice = self.voice([self.chunk([-2, 0]), self.chunk([0.5, 2])])
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            voice.synthesize_wav('Привет', wav)
        with wave.open(io.BytesIO(buffer.getvalue())) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
            np.testing.assert_array_equal(samples[:4], [-32767, 0, 16383, 32767])
            self.assertEqual(len(samples) - 4, 7200)
            self.assertFalse(np.any(samples[4:]))

    def test_generation_stops_when_audio_exceeds_limit(self):
        voice = self.voice([self.chunk(np.zeros(24000 * 31))])
        with wave.open(io.BytesIO(), 'wb') as wav:
            with self.assertRaises(AudioOutOfBounds):
                voice.synthesize_wav('Привет', wav)

    def test_sample_rate_change_is_rejected(self):
        voice = self.voice([self.chunk([0], sample_rate=22050)])
        with wave.open(io.BytesIO(), 'wb') as wav:
            with self.assertRaisesRegex(RuntimeError, 'qwen_sample_rate_changed'):
                voice.synthesize_wav('Привет', wav)


if __name__ == '__main__':
    unittest.main()
