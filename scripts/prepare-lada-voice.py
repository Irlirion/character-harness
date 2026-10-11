"""Download the pinned Russian checkpoint and convert it for native MLX TTS."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "work/qwen-tts/hf"))

from huggingface_hub import snapshot_download
from mlx_audio.convert import convert

if __name__ == "__main__":
    source = snapshot_download(
        "siriusfreak/qwen3-tts-12hz-1.7b-ru-stress-cf",
        revision="c16b3af3db3095120efc1ebb73f6522442bcb3b1",
        allow_patterns=["*.json", "*.txt", "model.safetensors", "speech_tokenizer/*"],
        ignore_patterns=["lora/*", "meter/*", "scripts/*", "eval/*"],
    )
    convert(hf_path=source, mlx_path=str(ROOT / "work/qwen-tts/lada/mlx-8bit"),
            quantize=True, q_bits=8, q_group_size=64, model_domain="tts")
