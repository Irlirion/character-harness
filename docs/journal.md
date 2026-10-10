# Журнал работы

## 2026-10-10 — план социальной непрерывности

- После сравнения с agent-workplace подготовлен `social-continuity-plan.md`: компактное состояние, отношения, обязательства, completion delta и просмотр контекста.
- Первый сценарий — узнавание собеседника и продолжение разговорного обещания после перезапуска; самостоятельные wakeups выделены в следующий срез.
- План предложен к реализации. Runtime, данные и рабочие контейнеры не менялись.

## 2026-10-10 — социальная память, первый storage срез

- Добавлены контракты `memory_delta` и ADR 0008: channel-scoped identities, sourced facts/relationship notes/commitments и aggregate working-state version.
- Миграция 006 добавляет пять таблиц социальной памяти и сохраняет completion payload/result для replay detection. Миграция аддитивна.
- `/engine/complete` принимает optional delta. Schema/provenance/scope/version reject остаются отдельными от успешного ответа; запись delta ограничена savepoint внутри общей completion transaction. Старый payload остаётся валиден.
- Добавлены unit и PostgreSQL regression tests: savepoint rollback после частичной записи, reply сохраняется при memory rejection, scope/source/epoch и version fencing, commitments, channel isolation, speech queue rollback и replay dedup. Проверены в Node 24.21.0: `tsc --noEmit`, 59/59 tests, 0 skipped, включая обе PG integration suites на изолированной БД. Рабочие контейнеры и credentials не менялись.
- Сборка контекста, новые engine adapters и live inference остаются следующими этапами.

## 2026-10-10 — social memory в input и engine staging

- Оба adapters теперь используют один bounded `turn_input` с audience-scoped facts, отношениями, открытыми обязательствами, provenance и aggregate version. Omitted commitments доступны через MCP `memory_social_list`; сырые внешние author IDs остаются только в доверенной стороне core.
- Добавлены `memory_stage_delta`, общие `characters/memory-rules.md` и fencing active event/epoch. Stage привязан к текущему turn и применяется только в completion transaction; pause/defer/reclaim очищают черновики под character lock. Codex передаёт epoch при defer.
- `/owner/inspect-context` показывает текущую реконструкцию pending event без claim, inference или persona. Добавлены HTTP/MCP и PostgreSQL roundtrip regressions для staging, immutable commitment origin/evidence, scope и inspection.
- Миграция 007 требует перезапуска engine adapters при выкладке: старые in-flight events не имеют active event marker. Live inference не запускался.
- Проверка завершена: Node 24.21.0 `tsc --noEmit`, полный suite 64/64 pass, 0 skipped, включая обе PostgreSQL integration suites на изолированной БД. Live inference не проверялся.

## 2026-10-10 — полный Minecraft chat intake и typed silence

- CHAT bridge пересылает все видимые signed user messages после filter mask и пропускает сообщения собственной учётной записи. GAME system parser принимает user text из pinned `<nickname>` формы только при прежнем explicit opt-in и public demo scope.
- Оба adapters обязаны завершать модельный turn локальным typed `turn_finish`: естественный reply до 300 символов или explicit silence. Core атомарно завершает silent event, не создавая reply/speech; completion payload поддерживает replay conflict detection. Последние десять завершённых событий включают маркер наблюдаемого молчания.
- Сохранены admission budgets 100 pending / 10 events per author per minute. Превышения отвергаются core и не ставятся в очередь; inference не запускается при отсутствии pending messages.
- Добавлены Java parser, turn decision, HTTP и PostgreSQL tests. Node 24.21.0 `tsc --noEmit` и полный suite прошли: 66/66, 0 skipped, включая PG silent completion/sourced memory/replay regressions. Финальная Java21 Gradle build/test с cross-path dedup прошла: BUILD SUCCESSFUL, 9 задач выполнено. Live inference и новая политика в запущенной игре не проверялись.

## 2026-10-10 — Лада вместо Севера

- Добавлен отдельный YAML-пакет интернет-персоны Лады с SCP, AI и тёплой иронией; финальный текст проверен отдельными модельными диалогами.
- Core нормализует YAML и прежний JSON в один контракт `{id, name, persona}`. Личность не получает новых инструментов или полномочий.
- Defaults Compose и Fabric bridge переведены на Ладу, пакет `sever.json` удалён. Память прежней identity не переносится и не удаляется автоматически.
- Изменения подготовлены поверх актуальной main, сохранив ранее принятые ограничения трафика, проверки origin/token и обновления зависимостей.
- Прошли Docker frozen-lockfile build/typecheck (55 тестов без БД), отдельный PostgreSQL admission test, isolated Lada startup/identity isolation и MCP/SQL smoke; Fabric Gradle build/test также завершён успешно. Рабочие контейнеры и credentials не менялись.

## 2026-10-03

- Создана папка проекта `~/code/character-harness`.
- Зафиксированы требования из обсуждения и направление архитектуры вокруг автономных персонажей.
- Описаны адаптеры, исполнение, память, контекст, мастерская возможностей и контур оценки.
- Подготовлены этапы реализации и первое архитектурное решение.
- Реализация и испытания ещё не начаты. Hermes и OpenClaw указаны как ориентиры пользователя, без утверждений об их внутренней архитектуре.

### Движок агента

- По требованию пользователя движком выбран Pi Agent или Codex; конкретный первый вариант пока не определён.
- Добавлен контракт EngineAdapter и распределение ответственности между движком и внешним харнесом.
- Проверены первичные документы Pi SDK и официальные документы Codex SDK/app-server. Интеграция ещё не реализована; экспериментальные возможности требуют проверки версии.

### Стек и интеграции

- Выбран TypeScript/Node.js 24 LTS, pnpm, Pi SDK первым движком, PostgreSQL, Zod, Fastify, Pino и Vitest.
- Описаны процессы, доставка событий, операции и Minecraft через Mineflayer/pathfinder.
- Пользователь подтвердил Telegram через пользовательские аккаунты: выбран Teleproto/MTProto для общения и взаимодействия с ботами.
- Добавлены документы стека, интеграций и ADR 0003. Код ещё не реализован.

- При проверке обнаружена архивация GramJS; окончательный выбор Telegram-библиотеки — поддерживаемый форк Teleproto. Описаны login-flow, кнопки ботов, FLOOD_WAIT и восстановление.

### Docker

- Пользователь потребовал работу в Docker. Добавлены спецификация развёртывания и ADR 0004.
- Ядро, движок и адаптеры размещаются в контейнере harness, PostgreSQL — в отдельном сервисе. Сессии и данные сохраняются в volumes.
- Мастерская не получает Docker socket; отдельный runner исполняет ограниченные задания.
- Dockerfile/Compose пока не созданы: исполняемое ядро ещё отсутствует.

### Общий MCP-шлюз

- Пользователь подтвердил общий MCP gateway для Minecraft, Telegram, памяти и мастерской.
- Добавлены спецификация и ADR 0005, согласованы архитектура, движки, Docker и план.
- Определены привязка персонажа, асинхронные операции, восстановление и обновление каталога.
- Код пока не реализован; поддержка конкретных MCP-версий проверяется прототипом.

## 2026-10-04

- Пользователь выбрал Dots OpenAI как ориентир поведения. Проверено официальное описание продукта.
- Добавлены постоянные обязанности, scheduler пробуждений, межканальная идентичность, политика уведомлений и критерии качества.
- Обновлены архитектура, Docker и минимальный план реализации; добавлен ADR 0006. Закрытая архитектура Dots не предполагается известной.

### Социальный приоритет MVP

- Пользователь определил основную цель: социальный вау-эффект для других участников Minecraft и Telegram.
- Обновлены требования, README и roadmap; продакт-субагенту поручено переработать эпики. Ресерчеру памяти передано уточнение про отношения и публичные совместные события.
- Образ персонажа, демо-сценарий и критерии пилота пока предложения, не подтверждённые требования.

### Голос Minecraft

- Пользователь потребовал речь в Minecraft и выбрал Simple Voice Chat.
- Добавлена спецификация TTS → серверный voice bridge, MCP minecraft_speak, Docker-сеть и критерии spike.
- Серверный addon/plugin необходим для предложенного пути; loader и TTS пока не выбраны. Приём речи игроков пока отдельное предложение.

### Начало реализации

- Финальное ревью принято как основа: core/engine раздельно, MCP HTTP, личная память, audience-scoped контекст и epoch fencing.
- Добавлен первый кодовый срез: Docker/Compose, SQL, core, Pi bridge, demo social events, память и контроль.
- 4 policy-теста и compose config прошли. npm ENOTFOUND и выключенный Docker daemon блокируют install/typecheck/runtime smoke.
- По запросу пользователя GPT-6 Astra проводит независимое стратегическое ревью.

- Пользователь включил Docker. Повторная проверка и compose build блокируются sandbox-доступом к ~/.docker/run/docker.sock (operation not permitted). Это ограничение инструмента, а не результат сборки проекта.

### Docker runtime проверен

- Пользователь включил Full access; доступ к Docker и registry работает.
- Создан pnpm-lock.yaml, сборка переведена на frozen lockfile; исправлены две ошибки TypeScript.
- На Node 24 в Docker прошли typecheck, 4 policy-теста, миграция PostgreSQL и MCP/SQL smoke, включая lease, pause, stale epoch и сохранение ответа.
- Проверены импорт Pi SDK и in-memory session; вызовы модели не выполнялись. Core и PostgreSQL оставлены запущенными; engine не включён.
- Astra завершила независимое ревью в docs/astra-review.md. Следующий предлагаемый срез — совместная социальная сцена с голосом и продолжением в Telegram; параметры пилота и STT остаются открытыми.

### Голос без server addon

- Пользователь сообщил о Loopback и разрешил голосовой тест. Создан отдельный PrismLauncher instance Character Harness Voice Test, запущенный как SeverTest, и отдельное Loopback-устройство Character Harness Voice.
- На mc.agicraft.ru:25565 подключение SVC успешно; пользователь подтвердил слышимость тестового TTS через QuickTime/Loopback/SVC. Сервер не модифицировался.
- Следующий срез — автоматическая аудиоочередь на Mac; STT и управление клиентом пока не реализованы.

### Автоматическое воспроизведение голоса

- Реализованы speech_jobs (migration 002), owner speech API, отдельный audio token, bounded queue, claim, cancel и pause fencing.
- Добавлены macOS worker с локальным say/Milena и Swift CoreAudio player, выбирающий Character Harness Voice без переключения системного output. QuickTime для воспроизведения больше не нужен.
- Пользователь подтвердил слышимость автоматически отправленной фразы на сервере. Этот результат подтверждает audio transport, а не автономный диалог или STT.
- Инструкция и ограничения: docs/audio-worker.md.

### Репозиторий разработки

- Пользователь указал https://github.com/Irlirion/character-harness как репозиторий проекта.
- Remote на момент проверки не содержит refs; локальный проект до этого не был Git checkout.
- Локальные credentials, рабочее аудио, node_modules и данные исключены из версионирования.

### Codex и игровой client bridge

- Добавлены Codex app-server runtime с изолированным ChatGPT device login, ограниченным MCP каталогом и закреплённой моделью `gpt-6-luna`. Authenticated `model/list` подтвердил доступность модели; inference не переходит на account default.
- Исправлен turn-fence endpoint, добавлена атомарная запись ответа вместе со speech job и короткой речевой репликой. Синтетический event прошёл реальный Codex turn и native audio worker до `completed`; это не новая проверка слышимости вторым игроком.
- Реализован client-only Fabric bridge для 1.21.11/Fabric API 0.141.6. Он принимает адресованное сообщение с UUID из server chat context через отдельный token, возвращает локальный ответ и подтверждает его доставку. Server addon не нужен.
- Выполнены Docker Node24 typecheck/policy/RPC/model tests, isolated auth/model check, bridge auth/UUID validation check и Fabric Gradle build. Живой игровой event ожидает перезапуска отдельного test instance и проверки игроком.

## 2026-10-10 — безопасность публичного репозитория

- Включены GitHub secret scanning/push protection, Dependabot, приватные security reports и расширенный CodeQL. Ветка main защищена обязательными Node/Java checks и PR; Actions закреплены SHA и используют read-only token.
- Fastify обновлён до 5.12.5, MCP SDK — до 1.31.0. Добавлены отдельные бюджеты HTTP по ролям, атомарное ограничение очереди PostgreSQL до 100 событий на персонажа и до 10 новых событий автора за минуту. Дубликаты сохраняют прежний результат без нового допуска.
- Клиенты core допускают только loopback HTTP или Compose core:3000 и отказываются от HTTP redirects. Создание bridge secret выполняется атомарно без предварительного access.
- Добавлены regression-тесты rate limiting, адресов/redirects, MCP roundtrip и конкурентного допуска в настоящей PostgreSQL; CI запускает отдельный тестовый PostgreSQL. Миграция 005 добавляет индексы. Параметры и ограничения описаны в SECURITY.md.

### Плановые обновления Dependabot

- Объединены предложения #4, #6, #7, #9, #14, #15, #16 и #17: обновлены пять GitHub Actions с сохранением SHA-закрепления, MCP SDK до 1.32.1, Pi Agent до 1.0.4 и pg/@types/pg до 8.23.1. Совместимость проверяется на общем наборе изменений через CI и Docker build.
- Runtime и CI остаются на Node 24. Dependabot Docker major updates для node исключены; предложение Node 25 несовместимо с engines. Переходы Gradle 9, JUnit 6 и TypeScript 7 оставлены для отдельного ревью.

### Крупные обновления инструментов сборки

- Предложения Dependabot #8, #10 и #11 объединены для общей проверки: Gradle wrapper 9.8.0, JUnit Jupiter 6.1.3 и TypeScript 7.0.2. SHA256 distribution и wrapper JAR Gradle сверены с официальными значениями; TypeScript 7 проходит текущую конфигурацию без изменений исходного кода.
- Обновления проверяются через Node/PostgreSQL и Java CI, CodeQL, Docker Node24 build и изолированную Java21-сборку bridge. Runtime остаётся Node 24/Java 21.
- Новое предложение #20 с @types/node 26 не соответствует runtime Node 24. Major-обновления @types/node исключены в Dependabot; обычные обновления в линии 24 остаются доступны.
- В общий набор включены появившиеся предложения #21–23: Codex 0.160.1, rate-limit 11.2.0 и Zod 4.6.5. Проверка типов и HTTP/MCP regression-тесты проверяют совместимость с Fastify 5 и текущими схемами; Java21-сборка и все 8 JUnit-тестов прошли.
