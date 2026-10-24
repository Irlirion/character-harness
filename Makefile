SHELL := /bin/sh
.DEFAULT_GOAL := help

COMPOSE := docker compose
BUILD_FLAGS ?= --build
NATIVE_SERVICES := sh scripts/native-services.sh

.PHONY: help start stop status

help:
	@echo "make start — start services manually; make stop — stop; make status — inspect"

start:
	$(NATIVE_SERVICES) check
	$(COMPOSE) --profile stt up $(BUILD_FLAGS) -d
	$(NATIVE_SERVICES) start

stop:
	@native_failed=0; compose_failed=0; \
	$(NATIVE_SERVICES) stop || native_failed=1; \
	$(COMPOSE) --profile agent --profile stt stop || compose_failed=1; \
	test "$$native_failed" -eq 0 && test "$$compose_failed" -eq 0

status:
	$(COMPOSE) --profile agent --profile stt ps
	$(NATIVE_SERVICES) status
