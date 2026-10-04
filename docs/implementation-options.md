# Варианты реализации MVP

Дата: 2026-10-04. Техническое ревью разработчика. Код отсутствует; ниже предложения, а не подтверждение работающей совместимости. Документ не заменяет принятые ADR: изменение топологии требует согласования остальных спецификаций.

## Вывод

Рекомендуется модульный TypeScript-монолит в двух application-контейнерах: доверенный core с адаптерами и MCP, отдельный engine с Pi SDK. PostgreSQL — третий постоянный сервис. Для первой версии достаточно одного scheduler и одного engine-процесса на активного персонажа; контейнер engine можно закреплять за экземпляром через конфигурацию Compose.

Главный технический риск сейчас — границы сессий, действий и полномочий. Количество пакетов, векторная БД и сложная оркестрация этот риск не устраняют. Начинать следует со сквозного наблюдения и проверяемого действия, затем добавлять постоянство и мастерскую.

## Сравнение вариантов

| Вариант | Простота | Надёжность | Изоляция | Переносимость движков |
|---|---|---|---|---|
| A. Один harness-контейнер, workers, stdio MCP + PostgreSQL | Самый короткий прототип | Отдельные процессы локализуют часть сбоев; рестарт контейнера останавливает всё | Engine shell/fs потенциально доступны volumes и секреты контейнера | Общий MCP сохранён, но запуск gateway привязан к supervisor |
| B. Core с адаптерами + отдельный engine + PostgreSQL | Небольшой дополнительный HTTP-контракт | Engine перезапускается независимо; подключения среды живут в core | Engine не получает внешние auth-volumes и DB credentials | MCP поверх Streamable HTTP, EngineAdapter поверх отдельного управляющего API |
| C. Core, engine, Telegram и Minecraft отдельными сервисами + PostgreSQL | Больше конфигурации и восстановления | Адаптеры можно обновлять и масштабировать отдельно | Секреты разделены между сервисами | Хорошая; требует дополнительных transport-контрактов |

A допустим для лабораторного сценария на тестовых аккаунтах при отключённых встроенных shell/fs tools и контролируемых расширениях. Отдельный worker не создаёт границу файлового доступа. Для пользовательского Telegram-аккаунта и последующего подключения coding-engine рекомендован B. C отложить до реальной потребности в независимом масштабировании или более строгой изоляции Telegram от Minecraft.

## Топология B

```text
Telegram MTProto ─┐
                 ├─ core container ── PostgreSQL
Minecraft Java ──┘   supervisor
                     adapter workers
                     scheduler + operations + memory
                     MCP gateway (Streamable HTTP)
                           ↑ authenticated calls
                     engine container
                     Pi SDK + EngineAdapter
                     isolated session/workspace volume
                           ↓ model API
```

Core направляет decision input в engine через небольшой внутренний управляющий API. Engine вызывает только MCP capabilities core. Это два разных протокола: MCP предоставляет инструменты, управляющий API запускает и отменяет turns. Core не выполняет второй LLM tool loop.

Compose-сервисы: `core`, `engine-<instance>`, `postgres`, одноразовые `migrate` и `telegram-login`, необязательный тестовый `minecraft`. Начать с одного экземпляра; второй подключить явно, без автоматической генерации контейнеров runtime. Если позднее нужны сотни экземпляров, пересмотреть launcher.

DB доступна только core. Telegram auth-volume монтируется только core/login, Minecraft auth — core, sessions/workspace — соответствующему engine. Секрет модельного провайдера нужен engine и остаётся его собственной доверительной границей. Отдельный engine не объявляется полной защитой от вредоносного кода. Production-образ без Docker socket, без host home mounts, без общих пользовательских настроек Pi/Codex. API владельца привязать к localhost хоста.

Engine credential связывается с конкретным character instance; при нескольких экземплярах не использовать единый токен, позволяющий переключать персонажа аргументом. Core дополнительно проверяет audience, аккаунт, task ownership и ограничения действия. Рекомендуется ограничивать доступ engine к сетевым адресам core firewall/сетевыми правилами: Docker network сам по себе не запрещает обращаться к другим HTTP endpoints core.

MCP поддерживает stdio и Streamable HTTP; для межконтейнерного подключения используем второй. Сервер должен проверять Origin и авторизацию по правилам транспорта. Точную версию protocol/SDK фиксировать после smoke test. [Спецификация транспорта MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Pi и альтернативный Codex

Pi SDK документирует `createAgentSession`, `SessionManager`, явную настройку инструментов и ресурсов. MCP в SDK подключается через extension/resource loader, с `bindExtensions`; CLI-настройка сама не переносится. `SessionManager` определяет восстановленную историю. Начать с встроенного MCP extension на закреплённой версии; резервный вариант — customTools bridge к MCP client, без копирования policy. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

В рабочем игровом engine разрешить только одобренные tools; отключить встроенные bash/write/edit и неконтролируемое discovery ресурсов. В мастерской создавать отдельную сессию с иными инструментами. MCP resources, динамическое изменение каталога и tool-search не нужны для первого сценария: небольшой явный каталог проще проверить.

Codex подключать после готового Pi-среза. Official OpenAI documentation описывает app-server как собственный JSON-RPC протокол с threads, событиями и подтверждениями; это не MCP-сервер. `dynamicTools` экспериментальны, поэтому переносимость строить на внешнем MCP. Для batch-автоматизации документация рекомендует SDK; выбор SDK/app-server проверить spike по отмене и событиям, а не объявлять их взаимозаменяемыми. [Codex App Server](https://learn.chatgpt.com/docs/app-server), [миграция удалённого Codex MCP server](https://learn.chatgpt.com/docs/mcp-server).

Проектный EngineAdapter: `open`, `run`, `interrupt`, `inspect`, `close`, `capabilities`. Реальный SDK API спрятан внутри него. В capabilities явно указать управление историей, compaction, steering, tool catalog refresh и доступность usage. Версии engine, настроек, персонажа и каталога записывать в turn.

## Контракты и данные

Использовать TypeScript strict/ESM, Zod на границах и версионированный JSON. SQL-миграции и node-postgres достаточны. PostgreSQL — источник состояния; engine files являются отдельной историей, не второй копией задач.

| Объект | Минимальные поля |
|---|---|
| event | id, source, source_event_key, character_id, audience_id, observed_at, received_at, payload, schema_version |
| turn | id, character_id, audience_id, task_id, engine_session_id, context_snapshot_id, lease_epoch, status |
| operation | id, invocation_id, character_id, binding_id, resource_key, executor_epoch, deadline, status, evidence |
| wakeup | id, character_id, responsibility_id, due_at/event_condition, dedupe_key, status |
| memory | id, character_id, audience_scope, source_event_ids, confidence, valid_until, content |
| session binding | character_id, audience_id, purpose, engine_type, engine_ref, context_version |

Отдельные таблицы: characters, bindings, responsibilities, tasks, events/inbox, outbox, operations, wakeups, turns, context_snapshots, memories, engine_sessions, skill_versions. Полезные ограничения БД: уникальность внешнего события в источнике, уникальность invocation в заданной области, один активный конфликтующий turn и один владелец игрового ресурса. Не вводить event sourcing всего мира: журнал нужен для аудита и доставки, текущее состояние хранится явно.

Изменяющий MCP-call получает invocation key от адаптера движка, если стабильный tool-call id доступен. Повторное использование key с другими аргументами отклоняется. Потеря ответа без стабильного key означает сверку через operation, а не дедупликацию по тексту аргументов.

## Сессии, аудитории и контекст

Один персонаж имеет общую идентичность, но отдельные engine sessions по `audience_id + purpose`. Приватный Telegram-диалог, групповой чат, публичный Minecraft-чат и фоновая задача не разделяют сырую историю. Поиск памяти фильтруется по аудитории; разрешённые факты передаются между контекстами явно.

Фильтр memory_search не очищает уже загруженную engine history. Поэтому разделение сессий обязательно до первой работы с личными сообщениями. Сессии мастерской также отдельные.

Не подавать каждый новый snapshot поверх бесконечной старой истории. MVP использует краткую сессию на задачу внутри одной аудитории: начальный snapshot, затем дельты с source ids. На контрольной границе новая сессия получает актуальный snapshot и разрешённую сводку; старая архивируется. Длительные внешние операции принадлежат core и переживают замену сессии. Никакого прямого изменения `agent.state.messages` для замены сохранённой истории.

Snapshot сохраняет курсор событий, state version, memory ids, policy/catalog versions, бюджет и незавершённые операции. Перед первым действием core сверяет критичные предусловия с актуальным состоянием. События после курсора доставляются в следующем turn либо прерывают текущий по явным правилам.

## Scheduler, операции и reconnect

Один scheduler опрашивает просроченные wakeups, NOTIFY только ускоряет пробуждение. В транзакции забирает задачу, увеличивает монотонный fencing epoch и выдаёт lease. Продление lease не заменяет epoch: старый worker после паузы может ожить. Core и исполнитель отклоняют команды с устаревшим epoch. Для Minecraft один worker владеет ресурсом движения и отменяет прежний навык перед принятием нового владельца.

При временной недоступности core worker перестаёт принимать новые опасные действия по истечении lease; локальная безопасная остановка сохраняется. Fencing защищает будущие команды, но не отменяет уже совершённый внешний эффект.

Состояния операции: accepted → running → succeeded/failed/cancelled; unknown/reconciling для неопределённого результата. accepted фиксируется в БД до передачи исполнителю. Отмена turn, отмена HTTP/MCP-запроса и отмена навыка различаются. Pause/cancel/status владельца исполняются core без LLM. Завершение операции создаёт event и wakeup в одной транзакции.

Telegram: один writer на аккаунт, курсоры и message ids сохраняются; игнорировать собственные исходящие updates для предотвращения эхо. Протокол Telegram описывает восстановление пропущенных updates, а sendMessage имеет random_id для предотвращения повторной отправки. Сохранить random_id до отправки и проверить, позволяет ли закреплённый Teleproto управлять им и восстановлением updates. Нельзя обещать exactly-once при потере ответа и неограниченных рестартах. [Telegram updates](https://core.telegram.org/api/updates), [messages.sendMessage](https://core.telegram.org/method/messages.sendMessage).

Teleproto README подтверждает сохранение StringSession, вход пользовательского аккаунта и поток updates, но не доказывает нужное поведение catch-up и callback после reconnect. Кнопки ботов имеют разные типы; явно разрешить callback/text, URL и Mini Apps отложить. Логи примеров с печатью session string в проект не переносить. [Teleproto](https://github.com/sanyok12345/teleproto).

Minecraft: фиксировать версию тестового сервера; после spawn дождаться готовности данных, заново прочитать позицию, inventory и загруженное окружение. В ходе разрыва обычный клиент не получает историю игрового чата: записать gap event, пометить пропущенный период и не считать ввод пользователя полученным. Навык сверяется с текущим миром и перепланируется; повтор добычи/строительства не производится вслепую. Mineflayer предоставляет клиентские наблюдения, чат и игровые действия, а также Microsoft/offline auth; сочетание серверной версии и pathfinder проверить отдельно. [Mineflayer](https://github.com/PrismarineJS/mineflayer).

Reconnect всех уровней: bounded exponential backoff с jitter, auth_required отдельно от временной ошибки, timeout каждого вызова, health по сервисам. Engine restart восстанавливает закреплённую audience session либо новую сессию из snapshot. Каталог MCP перечитывается, операции остаются в core.

## Мастерская в MVP

Первый тип кандидата — чистая функция JSON → JSON, например расчёт материалов. Без сети, секретов и внешних capabilities. Выполняется ограниченным runner в заранее выбранном образе, с fixtures и таймаутом. Нет произвольных dependencies/install hooks на первом этапе. До готовности runner доступна генерация кандидата и ручная проверка, но инструмент не активируется автоматически.

Для составных действий использовать ограниченный декларативный план, который исполняет доверенный интерпретатор core через policy. Контейнер без сети не сможет вызывать capabilities core; нельзя одновременно обещать network=none и такой доступ. HTTP broker для сгенерированного кода — следующий этап, не обязательный MVP.

Runner не находится внутри agent с Docker socket. Автоматизация запуска — отдельный доверенный сервис оператора с фиксированными образами/параметрами. Регистрация версии независима от создавшей её сессии; rollout и rollback сохраняются в реестре.

## Вертикальные срезы

1. **Docker + persisted fake-world.** Core, PostgreSQL, Pi engine, MCP read и одна изменяющая операция с проверяемым эффектом. Готовность: рестарт engine не повторяет действие, чужой персонаж не имеет доступа, логи связываются по turn/operation.
2. **Telegram пользовательский аккаунт.** Владелец пишет, персонаж отвечает, pause/status обходят LLM. Готовность: повтор updates не даёт второго ответа; restart и flood-wait испытаны; личная история не появляется в групповом контексте.
3. **Minecraft наблюдение + один навык.** Inventory, navigate или collect на тестовом сервере. Готовность: cancel реально останавливает действие, reconnect даёт актуальный snapshot, потеря чата обозначается явно.
4. **Общая задача Telegram → Minecraft → Telegram.** Например принести фиксированный ресурс и сообщить подтверждённый inventory delta. Готовность: crash после accepted и потеря результата не вызывают ложного успеха или слепого повтора.
5. **Постоянная обязанность и два персонажа.** Wakeup, ожидание ответа, смена контекста, независимые бюджеты/память. Готовность: stale worker отклонён по epoch, paused не просыпается сам, polling модели отсутствует при ожидании.
6. **Чистый инструмент мастерской и второй движок.** Сначала кандидат расчёта материалов, затем Codex на той же fake-world задаче. Готовность: тестируемая польза кандидата, rollback; конформанс EngineAdapter без требования идентичного текста моделей.

Тесты должны проверять последствия сбоев и границы доступа. Строительство укрытия оставить расширенным сценарием: оно сразу требует нескольких ещё не проверенных навыков.

## Spikes до закрепления зависимостей

| Spike | Критерий успешности / решение при неуспехе |
|---|---|
| Pi SDK + MCP HTTP | Открыть каталог, выполнить read/write, abort и reconnect; иначе использовать customTools MCP bridge |
| Pi context/session | Resume, архивирование/смена сессии и snapshot дают ожидаемую историю без чужой аудитории; иначе task-local sessions без resume |
| Teleproto account | Login/save/restore, offline catch-up, сохранённый random_id, callback и flood-wait на тестовом аккаунте; иначе изменить Telegram adapter или сузить операции |
| Mineflayer server matrix | Закреплённые server/pathfinder версии: observe, navigate, cancel, reconnect; иначе сузить поддержку до проверенной версии |
| Lease/fencing | Приостановленный старый worker после выдачи нового epoch не совершает новое действие; иначе не разрешать takeover до остановки старого executor |
| Docker amd64/arm64 | Сборка и smoke test каждого заявленного target; непроверенные архитектуры не объявлять поддерживаемыми |
| Codex adapter | MCP, turn events, interrupt, auth и session audience isolation; экспериментальные функции не становятся обязательными core API |

Lockfile, image tags/digests и отчёт spike фиксируются после фактических запусков. Этот обзор проверил документацию первичных источников, но не установил библиотеки и не выполнил эти испытания.

## Минимальные изменения существующего проекта

До реализации: заменить единый application-container на B в Docker/stack/MCP ADR; добавить audience session bindings, epoch fencing и snapshot lifecycle в контракты; сузить первый workshop до pure computation/declarative plans. Redis, Kubernetes, распределённый брокер, vector memory, автоматическая установка произвольных зависимостей и автономное самоизменение ядра можно отложить.

Открыто: точная версия Pi и MCP extension; Teleproto update persistence/random_id/callback; целевой Minecraft server/auth; способ запуска чистых кандидатов; Codex SDK versus app-server после spike. Эти вопросы не блокируют fake-world срез и структуру контрактов.
