SHELL := /bin/sh

COMPOSE := docker compose
GUI_DOMAIN := gui/$(shell id -u)
LAUNCH_AGENTS := $(HOME)/Library/LaunchAgents
QWEN_AGENT := $(LAUNCH_AGENTS)/org.characterharness.qwen-tts.plist
AUDIO_AGENT := $(LAUNCH_AGENTS)/org.characterharness.audio-worker.plist

.PHONY: start stop status

start:
	@test -f "$(QWEN_AGENT)" || { echo "Missing $(QWEN_AGENT); install the Qwen LaunchAgent first." >&2; exit 1; }
	@test -f "$(AUDIO_AGENT)" || { echo "Missing $(AUDIO_AGENT); install the audio worker LaunchAgent first." >&2; exit 1; }
	$(COMPOSE) --profile stt up --build -d
	@set -eu; \
	for agent in "$(QWEN_AGENT)" "$(AUDIO_AGENT)"; do \
		label=$$(/usr/libexec/PlistBuddy -c 'Print :Label' "$$agent"); \
		if ! launchctl print "$(GUI_DOMAIN)/$$label" >/dev/null 2>&1; then \
			launchctl bootstrap "$(GUI_DOMAIN)" "$$agent"; \
		fi; \
	done

stop:
	@set -eu; \
	for agent in "$(AUDIO_AGENT)" "$(QWEN_AGENT)"; do \
		if test -f "$$agent"; then \
			label=$$(/usr/libexec/PlistBuddy -c 'Print :Label' "$$agent"); \
			launchctl bootout "$(GUI_DOMAIN)" "$$agent" 2>/dev/null || true; \
		fi; \
	done
	$(COMPOSE) --profile agent --profile stt stop

status:
	$(COMPOSE) --profile agent --profile stt ps
	@launchctl list | grep 'org\.characterharness\.' || true
