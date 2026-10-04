# Автоматический голос через Loopback

Статус 2026-10-04: реализованы постоянная очередь core и native audio worker на Mac. Тестовый job завершился после прямого воспроизведения CoreAudio в Character Harness Voice; пользователь подтвердил слышимость автоматической фразы на сервере. Ранее ручной путь через QuickTime был слышен на сервере.

## Запуск

На Mac нужны Node 24 и Swift toolchain. Docker содержит core/БД; игровой клиент и audio worker работают нативно. Для существующей установки нужен новый локальный secrets/audio_token (32 случайных байта в hex), отличный от owner/engine. Setup новых secrets создаёт его автоматически; уже существующие secrets не перезаписываются.

```sh
mkdir -p work/voice-spike
swiftc native/audio/play.swift -o work/voice-spike/harness-audio-play
docker compose up --build -d core
AUDIO_TOKEN_FILE=secrets/audio_token node --experimental-strip-types apps/audio-worker/main.ts
```

В отдельном терминале:

```sh
node --experimental-strip-types scripts/speak.ts 'Привет! Север на связи.'
```

Loopback Character Harness Voice должен быть включён с Pass-Thru, соединённым с выходами. Клиент SVC использует это устройство как микрофон, VOICE, disabled=false и muted=false. QuickTime больше не нужен: native helper выбирает CoreAudio device UID по точному уникальному имени и подаёт PCM прямо в устройство. Системный output не переключается. Не воспроизводить другие файлы QuickTime, пока он остаётся дополнительным источником этого Loopback устройства. Тестовый экземпляр не захватывает физический микрофон.

## Управление

Owner API:

- POST /owner/speech: request_id и text (1–300 символов).
- GET /owner/speech/:id: состояние.
- POST /owner/speech/:id/cancel: отмена конкретного задания.
- POST /owner/pause: отзыв полномочий; воркер останавливает активный child process.

Bearer берётся из secrets/owner_token локально, не вставляется в документацию/переписку. Audio worker использует отдельный secrets/audio_token и не имеет доступа к owner/MCP API.

## Семантика

Очередь хранится в PostgreSQL, до трёх актуальных заданий; expiry 60 секунд, playback до 30 секунд, один активный claim. Повтор request_id с тем же текстом возвращает прежнее задание; другой текст даёт conflict. Истёкшее claimed/playing задание становится unknown и не выдаётся повторно. Pending при отмене/устаревании не воспроизводится. Epoch общий с turn: новая выдача engine turn может отозвать прежнюю речь; будущий scene revision отделяется от turn epoch перед непрерывным диалогом.

Worker синтезирует локально macOS say/Milena и воспроизводит WAV через Swift AudioQueue. Это первая реализация TTS adapter; Piper и STT пока не подключены. Аудиофайл удаляется после попытки. Процессы запускаются без shell interpolation. Каждые 250 мс worker проверяет разрешение; сетевой timeout 2 секунды, при недоступности core прекращает воспроизведение. Это ограниченная задержка реакции, не мгновенная распределённая отмена. На shutdown активный child получает SIGTERM. Остаток уже отправленного аудио SVC нельзя гарантированно отозвать.

Completed означает завершение локального воспроизведения, не гарантированную слышимость всеми игроками. На crash между воспроизведением и отчётом результат unknown; не обещается exactly-once для внешнего аудио. Worker пока запускать в одном экземпляре. Postgres lease/claim не заменяет управление несколькими воспроизводящими процессами при сетевых разделениях.

## Проверки

Docker build включает typecheck и policy tests. При остановленном audio worker на demo БД:

```sh
docker compose exec -T core node --experimental-strip-types scripts/speech-smoke.ts
```

Smoke проверяет роли токенов, idempotency/conflict, один active claim, правильную последовательность playing/completed, pause fencing, отмену, лимит очереди и отсутствие повторной выдачи unknown. Использует синтетические задания; не запускать с работающим worker, иначе они могут прозвучать.

## Следующий срез

Codex engine с отдельным login и ограниченными действиями; client bridge для игровых обращений и ответа через эту очередь. Автономный диалог и STT ещё не реализованы. На данный момент речь инициируется owner API.
