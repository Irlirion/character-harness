# Первый кодовый срез

Статус: Docker-сборка, миграция и MCP/SQL smoke проверены; live Pi пока не проверен. См. [финальное ревью](final-review.md).

Персонаж по умолчанию — Лада из `characters/Lada/personalities.yml`. Core загружает YAML напрямую, а оба engine получают прежний контракт persona. Выбор другого пакета и переход с существующей установки описаны в [персонажах](characters.md).

## Локальные проверки без зависимостей

```sh
node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types scripts/setup-secrets.ts
docker compose config --quiet
```

setup-secrets создаёт локальные случайные credentials в игнорируемой secrets/ и отказывается перезаписывать существующие файлы. model_api_key оставляется пустым до запуска live Pi. Ключи не выводятся.

## Сборка и MCP smoke

Основной путь проверки использует Node 24 внутри Docker:

```sh
docker compose up --build -d core
docker compose exec -T core node --experimental-strip-types scripts/smoke.ts
```

Сборка выполняет typecheck и policy-тесты; зависимости фиксируются pnpm-lock.yaml и устанавливаются с --frozen-lockfile --ignore-scripts. Smoke использует смонтированные секреты, проверяет MCP и PostgreSQL без LLM. Запускать без engine profile на demo БД: он меняет pause/epoch и создаёт тестовые заметки и ответы.

Для разработки на хосте нужен Node 24. Если локальный Corepack не распознаёт подпись pnpm, можно использовать `npx --yes pnpm@10.11.0 install --frozen-lockfile --ignore-scripts`, затем аналогично `typecheck` и `test`; отключать проверку подписей не требуется.

## Live Pi

Записать ключ выбранного провайдера в secrets/model_api_key локальным редактором. Выбрать PI_PROVIDER и PI_MODEL из доступного каталога Pi и запустить:

```sh
PI_PROVIDER=your-provider PI_MODEL=your-model docker compose --profile agent up --build -d
```

Переменные — placeholders, не готовые имена моделей. Engine имеет собственный model credential, но не DB/Telegram/Minecraft credentials. Секреты не передаются через demo events.

Owner API принимает синтетическое социальное событие на POST /owner/events с bearer из secrets/owner_token:

```json
{"source_key":"demo-1","author_id":"test-player","text":"Привет, Лада! Мы вчера строили мост."}
```

GET /owner/replies показывает сохранённый ответ. Источник является текстом участника, а не подтверждением того, что агент действительно строил мост. Персонаж не должен выдумывать участие. /owner/status показывает неготовность реальных адаптеров.

В runtime доступны /owner/pause, /owner/resume и /owner/status. Engine token не даёт доступ к ним. Все браузерные Origin пока запрещены; веб-панель не реализована. /health выдаёт только liveness, /ready проверяет БД и требует engine token.

## Codex и клиент Minecraft

Codex runtime и изолированный device login: [Codex engine](codex-engine.md). Модель по умолчанию `gpt-6-luna`; `codex-check.ts` сверяет точное имя в аккаунтном каталоге и не выбирает резервную модель. `scripts/bridge-check.ts` проверяет отдельный bridge token и UUID validation. Client-only Fabric bridge собирается через `client-bridge/gradlew build`; инструкции установки — в [bridge README](../client-bridge/README.md). Для старых установок bridge token создаётся отдельным скриптом, без перезаписи остальных secret-файлов.

При запущенных core, Codex engine и audio worker можно выполнить синтетический полный цикл:

```sh
docker compose exec -T core node --experimental-strip-types scripts/codex-e2e.ts
```

Сценарий вставляет synthetic event и ждёт сохранённый ответ и `speech_state=completed`; фраза может прозвучать через подключённый SVC клиент.

## Ограничения

Первый срез сохраняет личные непроверенные заметки только в фиксированной audience. Нет межаудиторной публикации и привязки реальных пользователей. После трёх неудач событие остаётся необработанным для ручного разбора; ответ с неизвестным результатом не объявляется успешным. Привязка токена и один экземпляр конфигурируются Compose; динамический запуск множества персонажей отложен.

Telegram, STT, движение и инициативные обязанности не реализованы. Синтетический игровой event уже получил ответ Codex и completed speech job; реальное адресованное сообщение ожидает перезапуска тестового Fabric клиента и ручной проверки в игре.

Социальная память первой версии описана в [плане](social-continuity-plan.md) и [ADR 0008](decisions/0008-social-memory.md). Миграции 006–007 добавляют scoped storage и per-turn staging; оба engine используют общий bounded input, MCP proposal/list tools и memory rules. Minecraft CHAT пересылает видимые user messages, а opt-in GAME parser остаётся привязан к pinned server и public demo audience. Engine-local `turn_finish` выбирает естественный reply или explicit silence; тишина обрабатывается атомарно без записи reply/speech и показывается в bounded history. `/owner/inspect-context` показывает текущую реконструкцию без claim/inference. После миграции 007 перезапусти engine adapters: незавершённые pre-migration claims не имеют active event marker и должны быть обработаны заново после истечения lease. Live inference не проверялся.
