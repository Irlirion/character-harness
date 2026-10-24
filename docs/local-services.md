# Управление локальными сервисами

На этом Mac сервисы проекта запускаются одной командой через `make`:

```sh
make start
make stop
make status
```

`make start` поднимает Docker Compose с core, PostgreSQL, Codex engine, Telegram
и STT, затем запускает пользовательские LaunchAgents Qwen TTS и audio worker.
Compose автоматически читает `compose.override.yaml`, если он есть. Для нативных
сервисов должны быть установлены `~/Library/LaunchAgents/org.characterharness.qwen-tts.plist`
и `~/Library/LaunchAgents/org.characterharness.audio-worker.plist`; MLX-модель и
Python-окружение TTS должны быть подготовлены по инструкции [audio worker](audio-worker.md).

`make stop` выгружает audio worker и TTS LaunchAgents, затем останавливает
контейнеры Compose, включая необязательные профили. Данные PostgreSQL и runtime
остаются в Docker volumes. Команда не удаляет контейнеры, образы, секреты или
модельные файлы. Повторный `make start` снова загружает LaunchAgents и запускает
Compose.

`make status` показывает состояние контейнеров и зарегистрированные LaunchAgents.
Если нужно применить изменения к коду нативного сервиса, выполните `make stop`,
а затем `make start`.

Для ручной работы с отдельным сервисом см. [запуск в Docker](docker.md) и
[инструкцию audio worker](audio-worker.md).
