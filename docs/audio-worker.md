# Автоматический голос через Loopback

Статус 2026-10-10: постоянная очередь core, нативный Qwen3-TTS и audio worker работают на Mac. Пользователь подтвердил, что автоматическая цепочка Qwen → Loopback → Simple Voice Chat слышна на сервере. При первом неслышимом тесте оба клиента потеряли SVC-соединение после переподключения сервера; повторный вход каждого клиента восстановил связь. Исторический тест 2026-10-04 подтвердил только воспроизведение через CoreAudio.

## Запуск

На Mac нужны Node 24, Swift toolchain и FFmpeg. Worker находит FFmpeg в стандартных каталогах Homebrew; другой путь задаётся через `FFMPEG_PATH`. Docker содержит core/БД; Qwen TTS, игровой клиент и audio worker работают нативно. Для существующей установки нужен новый локальный `secrets/audio_token` (32 случайных байта в hex), отличный от owner/engine. Setup новых secrets создаёт его автоматически; уже существующие secrets не перезаписываются. TTS provider у audio worker — Qwen; macOS `say` используется только при явном `TTS_PROVIDER=say`. Если TTS service или его token недоступны, worker не подменяет выбранный голос молча.

```sh
mkdir -p work/voice-spike
swiftc native/audio/play.swift -o work/voice-spike/harness-audio-play
docker compose up --build -d core
```

### Голос Лады: русский Qwen3-TTS 1.7B

С 2026-10-11 launcher использует `characters/Lada/voice.json`: локальный MLX 8bit
файнтюн `siriusfreak/qwen3-tts-12hz-1.7b-ru-stress-cf` (revision
`c16b3af3db3095120efc1ebb73f6522442bcb3b1`) и `voice-reference.wav`.
Эталон — выбранное пользователем демо Алёны Сазоновой: 6 секунд речи и 0,5 секунды
тишины в конце. Текст эталона хранится в профиле. Модель должна лежать в
`work/qwen-tts/lada/mlx-8bit`; веса не входят в Git. Для воспроизведения конвертации
запустите `work/qwen-tts/.venv/bin/python scripts/prepare-lada-voice.py` после установки
Python-зависимостей ниже. Нужны Metal GPU, доступ к Hugging Face и место для исходных
и сконвертированных весов. `QWEN_VOICE_PROFILE` позволяет выбрать другой профиль;
`QWEN_VOICE_PROFILE='' scripts/start-qwen-tts.sh` включает прежний CustomVoice.

Сервис использует клонирование, `language=Russian`, temperature 0.7, до 650 токенов.
Вводные фразы, обрезка начала и добавление ударений в запрос автоматически не выполняются.
В конец каждого WAV добавляется 0,3 секунды тишины, входящей в общий лимит 30 секунд.
В прослушивании пользователь предпочёл короткие предложения с тире для смысловой паузы.
Файнтюн умеет следовать знакам U+0301, когда они присутствуют в тексте.
Весь WAV генерируется до ответа HTTP; готовые голоса CustomVoice остаются доступны
при прямом запуске `main.py` без `QWEN_VOICE_PROFILE`.

### Предыдущая установка Qwen3-TTS 0.6B / Serena

Qwen работает нативно на Apple Silicon через MLX, вне Docker. Проверенная установка: MacBook Pro M1 Pro с 16 GB памяти, macOS 27.0.1, Python 3.12 и `mlx==0.32.3`; совместимость с другими моделями Mac и версиями macOS отдельно не подтверждена. Постоянный процесс
загружает `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` и прогревает модель
до публикации `/ready`. Голос по умолчанию — Serena, язык — русский.
Сервис сохраняет тот же контракт `/synthesize`: bearer-authenticated JSON
`{"text":"..."}` → готовый WAV mono PCM16 24 kHz. Worker переводит WAV в 48 kHz
и воспроизводит его существующим Swift player. Воспроизведение начинается после
синтеза всей реплики; потокового playback пока нет.

Установка (Python 3.12, нативный arm64):

```sh
python3.12 -m venv work/qwen-tts/.venv
work/qwen-tts/.venv/bin/python -m pip install -r apps/tts-service/requirements-qwen.txt
# Создать token, если secrets/tts_token ещё отсутствует:
node --experimental-strip-types scripts/setup-tts-secret.ts
```

Сервис по умолчанию слушает `127.0.0.1:3081`. Для другого порта задайте
`TTS_PORT` и такой же порт в `TTS_URL` worker.

```sh
scripts/start-qwen-tts.sh
```

В другом терминале запустить один audio worker:

```sh
TTS_PROVIDER=qwen \
TTS_URL=http://127.0.0.1:3081 \
TTS_TOKEN_FILE=secrets/tts_token \
AUDIO_TOKEN_FILE=secrets/audio_token \
node --experimental-strip-types apps/audio-worker/main.ts
```

`QWEN_VOICE` фиксирует голос (по умолчанию Serena; например, Vivian), `QWEN_MODEL` — путь
или ID CustomVoice модели, `QWEN_PYTHON` — Python окружения. Launcher хранит кеш
в `work/qwen-tts/hf`; первый запуск скачивает веса, последующие используют кеш.
При необходимости `HF_HOME` можно переопределить. Запускать следует из нативного
терминала; Metal GPU нужен и при загрузке, и при генерации.

Timeout HTTP-запроса — 30 секунд.
Лимиты сервиса общие: 300 символов, 30 секунд аудио, 2 MB WAV, одна генерация;
при занятости — `429` без очереди. Отмена/пауза обрывает запрос worker и
блокирует playback, но начатый синтез в сервисе заканчивается самостоятельно.
Ошибки русского ударения остаются ограничением исходной модели: знаки ударения
автоматически не добавляются.

В отдельном терминале:

```sh
node --experimental-strip-types scripts/speak.ts 'Привет! Лада на связи.'
```

Loopback Character Harness Voice должен быть включён с Pass-Thru, соединённым с выходами. Клиент SVC использует это устройство как микрофон, VOICE, disabled=false и muted=false. QuickTime больше не нужен: native helper выбирает CoreAudio device UID по точному уникальному имени и подаёт PCM прямо в устройство. Системный output не переключается. Не воспроизводить другие файлы QuickTime, пока он остаётся дополнительным источником этого Loopback устройства. Тестовый экземпляр не захватывает физический микрофон.

## Ручной запуск на этом Mac

Живая установка находится в `/Users/irlirion/code/character-harness`.
Qwen и audio worker запускаются только вручную через `make start`; остановка — `make stop`.
Локальные задания лежат в `work/local-services/launchagents`, вне каталога автозагрузки macOS.
`KeepAlive=false`, `RunAtLoad=false`: после выхода процесса или нового входа в систему повторного запуска нет.
Qwen получает `HF_HUB_OFFLINE=1` и использует локальный кеш `work/qwen-tts/hf`;
веса должны быть заранее скачаны. Запуск ждёт готовности TTS до старта worker.
Не запускайте второй worker вручную одновременно с заданием.

Подробности, смена порта ядра и перезапуск после обновления: [локальные сервисы](local-services.md).

Логи сервиса: `work/qwen-tts/service.log` и `service.error.log`.
Логи worker: `work/voice-spike/audio-worker.log` и `audio-worker.error.log`.

## Управление

Owner API:

- POST /owner/speech: request_id и text (1–300 символов).
- GET /owner/speech/:id: состояние.
- POST /owner/speech/:id/cancel: отмена конкретного задания.
- POST /owner/pause: отзыв полномочий; воркер останавливает активный child process.

Bearer берётся из secrets/owner_token локально, не вставляется в документацию/переписку. Audio worker использует отдельный secrets/audio_token и не имеет доступа к owner/MCP API.

## Семантика

Очередь хранится в PostgreSQL, до трёх актуальных заданий; expiry 60 секунд, playback до 30 секунд, один активный claim. Повтор request_id с тем же текстом возвращает прежнее задание; другой текст даёт conflict. Истёкшее claimed/playing задание становится unknown и не выдаётся повторно. Pending при отмене/устаревании не воспроизводится. Epoch общий с turn: новая выдача engine turn может отозвать прежнюю речь; будущий scene revision отделяется от turn epoch перед непрерывным диалогом.

Worker запрашивает Qwen service либо, при явном `TTS_PROVIDER=say`, локальный macOS say/Milena и воспроизводит WAV через Swift AudioQueue. Аудиофайл удаляется после попытки. Каждые 250 мс worker проверяет разрешение; сетевой timeout core 2 секунды, запрос к TTS истекает через 30 секунд. При недоступности core или отмене worker прекращает текущую фазу и не начинает playback. Это ограниченная задержка реакции, не мгновенная распределённая отмена; остаток уже отправленного аудио SVC нельзя гарантированно отозвать.

Completed означает завершение локального воспроизведения, не гарантированную слышимость всеми игроками. На crash между воспроизведением и отчётом результат unknown; не обещается exactly-once для внешнего аудио. Worker пока запускать в одном экземпляре. Postgres lease/claim не заменяет управление несколькими воспроизводящими процессами при сетевых разделениях.

Если задание стало `completed`, но звук не слышен, проверьте SVC-соединение у обоих клиентов: в клиентских логах должны быть подтверждены `Server acknowledged authentication` и `Server acknowledged connection check`. После переподключения сервера клиентам может потребоваться выйти и войти снова. Также проверьте, что слушатель находится в нужной SVC-группе и в пределах дистанции слышимости.

## Проверки

Docker build включает typecheck и policy tests. При остановленном audio worker на demo БД:

```sh
docker compose exec -T core node --experimental-strip-types scripts/speech-smoke.ts
```

Smoke проверяет роли токенов, idempotency/conflict, один active claim, правильную последовательность playing/completed, pause fencing, отмену, лимит очереди и отсутствие повторной выдачи unknown. Использует синтетические задания; не запускать с работающим worker, иначе они могут прозвучать.

## Граница проверки

Путь owner speech → Qwen → Loopback → Simple Voice Chat подтверждён пользователем
на слух. Эта проверка не подтверждает полный цикл от игрового сообщения через
LLM до озвученного ответа. Инструкции других компонентов: [Fabric bridge](../client-bridge/README.md)
и [локальный STT](superpowers/specs/2026-10-04-gigaam-v3-stt-service-design.md).
