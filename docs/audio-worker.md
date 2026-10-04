# Автоматический голос через Loopback

Статус 2026-10-04: реализованы постоянная очередь core и native audio worker на Mac. Тестовый job завершился после прямого воспроизведения CoreAudio в Character Harness Voice; пользователь подтвердил слышимость автоматической фразы на сервере. Ранее ручной путь через QuickTime был слышен на сервере.

## Запуск

На Mac нужны Node 24 и Swift toolchain. Docker содержит core/БД и отдельный локальный TTS service; игровой клиент и audio worker работают нативно. Для существующей установки нужен новый локальный `secrets/audio_token` (32 случайных байта в hex), отличный от owner/engine. Setup новых secrets создаёт его автоматически; уже существующие secrets не перезаписываются. TTS provider у audio worker — Piper; macOS `say` используется только при явном `TTS_PROVIDER=say`. Если TTS service или его token недоступны, worker не подменяет выбранный голос молча.

```sh
mkdir -p work/voice-spike
swiftc native/audio/play.swift -o work/voice-spike/harness-audio-play
docker compose up --build -d core
AUDIO_TOKEN_FILE=secrets/audio_token node --experimental-strip-types apps/audio-worker/main.ts
```

### TTS service / Piper Dmitri

Синтез работает отдельным HTTP service в Docker; audio worker сохраняет контроль над очередью, pause fence и локальным воспроизведением. Service привязан к host `127.0.0.1:3081` и находится в отдельной Compose bridge-сети, изолированной от core и базы данных. Он принимает только bearer-authenticated JSON с текстом до 300 символов, допускает один активный синтез и отвечает `429` без очереди на занятый запрос. Сервис загружает голос при старте и отдаёт WAV mono PCM16 22.05 kHz; native worker переводит его в 48 kHz PCM16 перед Swift player.

Создать отдельный TTS token (скрипт откажется перезаписать существующий файл), затем скачать зафиксированный Dmitri voice в ignored local directory:

```sh
node --experimental-strip-types scripts/setup-tts-secret.ts
mkdir -p work/tts-models
curl -fL 'https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx' -o work/tts-models/ru_RU-dmitri-medium.onnx
curl -fL 'https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx.json' -o work/tts-models/ru_RU-dmitri-medium.onnx.json
PIPER_MODEL_DIR="$PWD/work/tts-models" docker compose --profile tts up --build -d --wait tts
```

Чтобы использовать исходную копию модели в macOS user cache, укажи в ignored `.env` `PIPER_MODEL_DIR=/absolute/path/to/voices/dmitri` вместо копирования в `work/tts-models`. Файлы модели не входят в Docker build context; compose монтирует только выбранную директорию read-only.

Запустить native audio worker с отдельным TTS bearer:

```sh
TTS_PROVIDER=piper \
TTS_URL=http://127.0.0.1:3081 \
TTS_TOKEN_FILE=secrets/tts_token \
AUDIO_TOKEN_FILE=secrets/audio_token \
node --experimental-strip-types apps/audio-worker/main.ts
```

Каждый запрос к TTS ограничен пятью секундами на стороне audio worker; отмена, pause или истечение срока прерывают HTTP-запрос и не дают WAV попасть в player. Закрытие клиента не останавливает уже начатый вычислительный вызов Piper внутри TTS container, но вход ограничен 300 символами, ответ — 30 секундами и 2 MB. Пока этот вызов заканчивается, новая заявка получает `429` и не накапливается в очереди. TTS container запускается без root, с read-only root filesystem, без Linux capabilities и с памятью до 768 MB.

Перед распространением приложения с Piper runtime учитывайте GPL-3.0-or-later код engine и отдельно проверьте лицензию checkpoint: в карточке Dmitri указана CC0 лицензия датасета, но нет отдельного условия для весов. Выбранный голос и альтернативы сравнивались в [отчёте по выбору TTS](reviews/tts-voice-selection.md).

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

Worker запрашивает Piper service либо, при явном `TTS_PROVIDER=say`, локальный macOS say/Milena и воспроизводит WAV через Swift AudioQueue. Аудиофайл удаляется после попытки. Каждые 250 мс worker проверяет разрешение; сетевой timeout core 2 секунды, запрос к TTS истекает через 5 секунд. При недоступности core или отмене worker прекращает текущую фазу и не начинает playback. Это ограниченная задержка реакции, не мгновенная распределённая отмена; остаток уже отправленного аудио SVC нельзя гарантированно отозвать.

Completed означает завершение локального воспроизведения, не гарантированную слышимость всеми игроками. На crash между воспроизведением и отчётом результат unknown; не обещается exactly-once для внешнего аудио. Worker пока запускать в одном экземпляре. Postgres lease/claim не заменяет управление несколькими воспроизводящими процессами при сетевых разделениях.

## Проверки

Docker build включает typecheck и policy tests. При остановленном audio worker на demo БД:

```sh
docker compose exec -T core node --experimental-strip-types scripts/speech-smoke.ts
```

Smoke проверяет роли токенов, idempotency/conflict, один active claim, правильную последовательность playing/completed, pause fencing, отмену, лимит очереди и отсутствие повторной выдачи unknown. Использует синтетические задания; не запускать с работающим worker, иначе они могут прозвучать.

## Следующий срез

Codex engine с отдельным login и ограниченными действиями, а также client-only Fabric bridge для игровых обращений и локального показа ответов реализованы. Синтетическое событие прошло Codex→reply→completed speech job. Живой игровой цикл ждёт перезапуска тестового экземпляра с bridge и обращения игрока. Автономный диалог и STT ещё не реализованы.
