#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export TTS_PROVIDER=qwen
export TTS_HOST="${TTS_HOST:-127.0.0.1}"
export TTS_PORT="${TTS_PORT:-3081}"
export TTS_TOKEN_FILE="${TTS_TOKEN_FILE:-secrets/tts_token}"
export QWEN_VOICE="${QWEN_VOICE:-Serena}"
export HF_HOME="${HF_HOME:-$PWD/work/qwen-tts/hf}"
exec "${QWEN_PYTHON:-$PWD/work/qwen-tts/.venv/bin/python}" apps/tts-service/main.py
