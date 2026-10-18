# Постоянный runtime и граница автономии агента

Дата: 2026-10-18. Подход: Spec-Driven Development (SDD).
Статус: спецификация перехода; слой хранения, engine protocol и механизм policy/resources реализованы в ветке, автономный режим не включён.
Точный поставленный объём и проверки: [policy/resources](../../runtime-2-policy-resources.md), [engine protocol](../../runtime-2-engine-protocol.md), [слой постоянного состояния](../../runtime-2-foundation.md).
База проектирования: `main` на `dea77f8`.
Источник требований: [RFC: Agent Autonomy Boundary](../../rfc/agent-autonomy-boundary.md).

## Назначение и границы

Character Harness предоставляет агенту постоянную среду исполнения: хранение работы,
пробуждения, контекст, память, инструменты и ограниченные ресурсы. Агент выбирает
собственные цели, приоритеты и действия. Core не создаёт персонажу мотивацию,
не ранжирует его цели по собственной полезности и не подменяет намерение.

RFC сохранён как исходный proposed-документ. Примеры API и пути в нём — входные
проектные предложения. Конкретные обязательства реализации задаёт эта спецификация;
ссылки RFC на состояние кода не заменяют проверку актуального репозитория.

Документ покрывает целевой runtime и выделяет независимо поставляемый MVP.
Выбор Jev-подобных моделей, конкретная интеграция UnionClef, workers и исполнение
самописного кода не входят в MVP. Их добавление не является условием первого запуска.

## Исходное состояние

- Pi и Codex используют ограниченные ходы и получение входа через `/engine/input`.
- `characters` хранит pause, epoch и lease. Principal содержит character и audience.
- `operations` уже служит журналом replay для записей памяти; таблицу нельзя
  переименовать или переиспользовать с несовместимой семантикой.
- Minecraft actions, наблюдения, social memory staging и завершение ответа имеют
  собственные контракты и проверки. Их гарантии сохраняются при обобщении.
- Telegram, voice и image jobs уже имеют отдельные очереди/состояния. Завершение
  ответа или фоновой картинки не должно завершать постоянную деятельность.
- [Persistent agents](../../persistent-agents.md) и
  [Capability workshop](../../capability-workshop.md) описывают предложения.
  Responsibility и «рабочий планировщик» из этих документов не становятся
  обязательным глобальным планировщиком или источником целей.

## Обязательные инварианты

1. Только агент изменяет self-цель. Поручение владельца имеет явные origin,
   requested_by и журнал изменений. Внешний текст не получает authority владельца.
2. Истинность внешнего результата определяется наблюдением/квитанцией адаптера.
   Текст модели «готово» не подтверждает внешнее действие.
3. Все чтения, записи, пробуждения и вызовы проходят проверку scope и актуальных
   прав вне модели. Каталог инструментов, навык и checkpoint не выдают полномочия.
4. Pause владельца запрещает новые ходы и эффекты, отзывает leases и повышает epoch.
   Возобновить работу может только доверенный owner control.
5. Бюджет и очередь ограничивают исполнение, сохраняя цель и причину блокировки.
6. Raw events и аудит не редактируются агентом. Интерпретации отделены от фактов.
7. Отсутствие работы не вызывает модель. Планировщик может опрашивать БД.
8. Данные аудитории не переходят в другую аудиторию через workspace, summaries,
   pins, checkpoints, поиск или уведомления без явного разрешения политики.

## Объекты хранения

В публичных контрактах `agent_id` соответствует существующему `character_id`.
Все идентификаторы объектов разрешаются сервером в рамках principal; знание UUID
не даёт доступа. Время хранится в UTC, сроки проверяются по серверным часам.

| Объект | Обязательные данные |
| --- | --- |
| Activity | id, character_id, scope, origin (`self/owner/external_event`), requested_by, objective, status, version, budget_ref, checkpoint_ref, created_at, updated_at |
| Turn | id, activity_id, engine, epoch, lease_token, lease_until, start/end, outcome, usage |
| Wakeup | id, activity_id, kind, condition, dedup_key, state, available_at, attempts, consumed_by_turn_id |
| Checkpoint | id, activity_id, version, scope, agent-authored state, source_refs, pins, pending_operation_ids, created_by_turn_id |
| Runtime operation | id, activity_id, capability/version, invocation_id, payload_hash, scope, epoch, authority_revision, deadline_at, lease, external_ref, status, evidence_ref |
| Audit | actor, origin, object/version, transition, reason, trace_id, timestamp; секреты и полные приватные payload не пишутся в обычные логи |

Activity scope содержит допустимые audience/environment references и agent-private
данные. Он не даёт автоматического доступа к объединённой истории каналов.
В MVP одна деятельность привязана к одной аудитории либо к agent-private scope;
перенос приватных данных в канал требует отдельного разрешённого output context.

Использовать новые таблицы `runtime_activities`, `runtime_turns`, `runtime_wakeups`,
`runtime_checkpoints`, `runtime_operations` и журнал переходов. Имена миграций
выбираются после последней миграции целевой ветки; на этой базе последняя — 011.
FK и ограничения не допускают checkpoint/wakeup/operation другого персонажа или
деятельности. Дедуп-ключи и invocation_id уникальны в соответствующем scope.

## Жизненный цикл и конкуренция

Статусы Activity: `ready`, `running`, `waiting_time`, `waiting_event`,
`waiting_operation`, `needs_input`, `completed`, `failed`, `cancelled`.
Pause — override персонажа, а не потеря статуса деятельности.
Бюджетная блокировка хранится отдельно как `blocked_reason` и, если известно,
`retry_after`; без доступного бюджета деятельность не claim-ится.

| Переход | Условие и атомарный результат |
| --- | --- |
| create → ready | Допустимые scope, origin и бюджет; идемпотентная запись цели |
| ready → running | Claim work, резервирование бюджета, создание turn и lease |
| running → ready | Решение continue либо восстановление истёкшего turn |
| running → waiting_* | Checkpoint, условие и wakeup записаны одной транзакцией |
| running → needs_input | Сохранены вопрос, причина и условие разрешённого ответа |
| waiting_* → ready | Срок/событие/результат подходит и wakeup ещё не потреблён |
| needs_input → ready | Пришёл разрешённый ответ; чужой текст не снимает блокировку |
| running → completed/failed | Явное решение и evidence для заявленных внешних результатов |
| любой нетерминальный → cancelled | Решение агента в своих правах либо owner cancel |

Терминальный объект не открывается повторным wakeup. Для новой работы создаётся
новая activity со ссылкой на предыдущую. Owner может отменить работу, но изменение
self-цели оформляет новым поручением или явно атрибутированной ревизией, а не
скрытой правкой. Агент видит автора, старое и новое значение.

MVP допускает один активный модельный turn на персонажа, сохраняя текущую
сериализацию epoch. Независимые external jobs могут продолжаться с собственными
разрешениями. Параллельные turns потребуют отдельного контракта конфликтов и leases.

Claim блокирует строку персонажа и подходящую work-запись в транзакции, проверяет
pause/epoch/budget, создаёт turn и потребляет wakeup. Повтор HTTP-запроса возвращает
тот же claim по request_id. CAS по activity.version исключает потерю обновления.
Два engine не получают одно право на исполнение. Ожидаемое внешнее действие
не перезапускается из-за окончания lease модельного хода.

При crash после claim истёкший turn получает outcome `interrupted`; нетерминальная
activity становится ready для восстановления. Перед любым повтором эффектов
обязательна сверка runtime operations. Wakeup уже завершённого turn не запускается
повторно; новый recovery wakeup имеет отдельный dedup_key.

## Runtime API MVP

Пути ниже — предлагаемый новый контракт. Старый `/engine/input` сохраняется за
legacy mode; один источник работы нельзя одновременно claim-ить двумя протоколами.
Gateway получает principal и origin из аутентификации, а не из аргументов модели.

| Интерфейс | Запрос / результат |
| --- | --- |
| `POST /engine/next_work` | request_id, engine capabilities → claim либо `work: null` с retry_after |
| Claim | activity, turn_id, epoch, lease_token, lease_until, wake_reason, scoped context, allowed tools, remaining budget |
| `POST /engine/work_decision` | invocation_id, turn_id, epoch, lease_token, expected_version, checkpoint, discriminated decision → committed version |
| `activity.create` | objective, разрешённый scope, budget_ref, invocation_id → self activity |
| `activity.inspect/list` | Только разрешённые объекты, состояния и причины блокировки |
| `activity.cancel` | id, expected_version, reason; отмена собственных действий без повышения прав |
| Owner control | pause/resume/cancel и attributable assignment через owner authentication |

Decision — строгое объединение: `continue`, `wait_until(at)`,
`wait_event(filter, after_cursor)`, `wait_operation(id)`, `request_input(question)`,
`complete(result, evidence_refs)`. Лишние и несовместимые поля отклоняются.
Checkpoint и decision коммитятся вместе. Повтор того же invocation_id и payload
возвращает сохранённый результат; другой payload даёт `invocation_conflict`.
Просроченный lease, epoch, version или permission revision запрещает мутацию.

Reply/silence и выбор канала остаются отдельным решением. Публикация требует
актуального channel/binding scope; autonomous wakeup сам по себе не разрешает
отправку. Обработка входящего social event и outbox сохраняют текущую дедупликацию.
Ошибка доставки не повторяет модельный ход и не завершает другую activity.

## Пробуждения и первый автономный запуск

MVP поддерживает at_time, on_event, on_operation_result и external_message.
Event filters типизированы и ограничены разрешёнными источниками; произвольный код
и SQL не принимаются. Регистрация ожидания и проверка событий после after_cursor
атомарны: событие между последним наблюдением и регистрацией не теряется.
Результат уже завершившейся operation немедленно делает работу готовой.

После owner enable создаётся один durable bootstrap wakeup без входящего сообщения.
Он предлагает агенту решить, нужна ли работа, и допускает отказ/сон без новой цели.
Автоматические «рефлексии», Minecraft-проекты и периодические мотивационные циклы
в core не создаются. Следующие таймеры задаёт агент либо явное поручение владельца.

Просроченные таймеры объединяются по dedup_key; не воспроизводится очередь каждого
пропущенного тика. Минимальный интервал, предел pending wakeups, очередь, retries,
backoff и дневные бюджеты задаются доверенной конфигурацией и доступны агенту.
Перед enable конфигурация лимитов обязательна; отсутствие лимита не значит unlimited.
Индекс due wakeups и ограниченный batch позволяют обслуживать сон без LLM.

## Внешние операции и отзыв права

Capability manifest задаёт side effects, retry/replay policy, idempotency,
cancellation guarantee, deadline, status и reconciliation. Состояния operation:
`queued/running/completed/failed/cancelled/unknown`.

Перед dispatch сохраняются invocation и намерение, проверяются свежие права и бюджет.
Повтор отправки допустим только с подтверждённой внешней идемпотентностью либо
доказанным отсутствием эффекта. Timeout/потеря ответа дают unknown; это не failure,
не success и не повод слепо повторить. Evidence содержит источник и observed_at.

Pause/отзыв binding повышает authority revision, отменяет queued work и пытается
остановить running effects. Уже принятый внешней системой эффект может завершиться;
такой результат фиксируется и сверяется без права на новые действия/уведомления.
После рестарта запрет действует до dispatch и delivery. Старый token не оживает
после owner resume. Очередь после resume проходит новые claims и проверки.

Существующие client actions и image jobs сначала подключаются через mapping
legacy ID → runtime operation с одним исполнителем и одним источником статуса.
Текущий image budget и проверка перед фактическим вызовом генератора обязательны;
activity budget не заменяет их. Ограничения Telegram delivery и voice сохраняются.

## Следующие этапы: workspace, контекст, возможности и навыки

**Workspace/context.** Scoped API для files/notes/checkpoints с quota и revision;
никакого произвольного host path, secrets, symlink escape или редактирования policy.
Контекст собирается по activity/turn с source, audience, observed_at и freshness.
Pins и обязательства не теряются молча: при нехватке окна возвращается явная ошибка
либо запрос на уменьшение контекста. Summary хранит ссылки на доступные исходники;
retention может удалить источник, что явно отражается в inspect. Внешний текст
и документы остаются данными, не инструкциями authority.

**Memory.** Raw evidence, agent interpretations и corrections имеют разные типы.
Search/propose/commit/correct/explain_sources сохраняют staging и audience isolation.
Consolidation предлагает merges, сохраняет supersession и показывает противоречия.
Автоматическая эвристика не уничтожает семантическую память без восстановления.

**Capabilities/environment.** Search/describe и полный разрешённый каталог с
пагинацией доступны агенту; shortlist не меняет права. Проверка каждого вызова
обязательна после discovery. Адаптер реализует observe/subscribe/execute/status/
cancel/reconcile, сообщает ограничения свежести и покрытия наблюдения.
UnionClef вводится отдельно: observe/inventory/navigation/status/stop;
command passthrough, произвольные GUI/key actions и PvP не включаются по умолчанию.
Minecraft social/voice путь сохраняется до прохождения интеграционных проверок.

**Skills.** Версионированные manifest, schemas, preconditions, permissions, limits,
progress, cancellation, fixtures, validation и rollback. Самописный код работает
в изолированном runner. Разрешения — пересечение agent policy и skill manifest,
а не их объединение. Shared promotion требует отдельной authority и тестов.

**Models.** Pi/Codex получают один runtime contract; смена engine не меняет
identity, память и права. Выбор модели по capability/budget виден в trace.
Делегирование и отдельные worker budgets — необязательный последующий срез.

## Контент, правила провайдера и базовый профиль ЕС

Обязательное дополнение: [Политика контента и допустимого использования](2026-10-18-agent-content-policy.md).
Его проверки включаются уже в MVP до автономного запуска: допуск подключения OpenAI,
privacy перед отправкой провайдеру, проверка действий и output до dispatch/delivery,
AI disclosure, retention/удаление данных и запрет обхода отказов. Policy version
и payload hash входят в допуск внешнего эффекта. Owner не может разрешить нарушение.
Неизменяемость raw events означает запрет правок агентом; законные процедуры удаления
оператором охватывают также источники, summaries и checkpoints.
Профиль РФ отдельно не вводится. Цель — снижение риска, без гарантии отсутствия
нарушений или блокировки аккаунта.

## Поставка и откат

| Этап | Результат и gate |
| --- | --- |
| 0. Контракты | Схемы, trace IDs, baseline текущих reply/memory/actions/pause/Telegram/images tests; без нового поведения |
| 1. MVP execution | Activity, checkpoint, wakeup, bootstrap, next_work, оба engine; restart/pause/idempotency/budget tests и gate C01–C12 контент-политики |
| 2. Workspace/context | Scoped storage, pins, provenance, compaction; leakage и recall tests |
| 3. Capabilities/environment | Registry, gateway authorization, operation reconciliation; adapter включается отдельно |
| 4. Skills/memory | Sandbox, correction/consolidation, validation, version rollback |
| 5. Cooperation | Отдельная spec полномочий и бюджетов workers, если потребуется |

Additive migrations и flags по персонажу/подсистеме. Переход legacy → runtime
только после drain/reconciliation текущих claims; event сохраняет один processing
owner. Откат выключает новые claims, сохраняет activities/checkpoints/journal и
разрешает только status/reconcile/cancel незавершённых effects. Legacy engine
возвращается после освобождения leases; ожидающие autonomous activities остаются
сохранёнными и видимыми владельцу. Откат не выполняет внешние операции повторно.

Изменения затронут `apps/core/{app,main}.ts`, оба engine, storage/migrations;
новые модули — runtime, workspace, context, capabilities, environments и skills.
Разделение модулей не требует выделения отдельных сервисов, кроме isolated runner.
При реализации обновляются persistent-agents, capability-workshop и architecture,
с явной пометкой shipped/planned для каждого этапа.

## Приёмка и наблюдаемость

| ID | Сценарий и проверяемый результат | Gate |
| --- | --- | --- |
| A01 | Bootstrap без сообщения: агент создаёт self activity, ставит таймер и продолжает с тем же checkpoint; может выбрать сон | MVP |
| A02 | Crash после claim, до/после decision commit: восстановление не теряет состояние и не дублирует committed wakeup | MVP |
| A03 | Два engine одновременно claim-ят работу: один turn, один budget reservation; повтор request_id возвращает тот же claim | MVP |
| A04 | Reply/silence Telegram и завершение image job не завершают постороннюю activity | MVP |
| A05 | Во время сна модель не вызывается; flood/continue loop ограничены очередью, backoff и бюджетом | MVP |
| A06 | Pause во время turn и после restart блокирует stale dispatch/decision/delivery; resume не оживляет старый lease | MVP |
| A07 | Бюджет исчерпан: цель/checkpoint сохранены, причина видна, completion не сфабрикован | MVP |
| A08 | Event или operation result между observe и wait не теряется; replay wakeup не создаёт второй turn | MVP |
| A09 | Unknown external outcome не запускает автоматический повтор; success требует подтверждённого evidence | MVP для подключённых effects |
| A10 | Чужой activity ID, audience, checkpoint, source_ref и forged owner origin отклоняются | MVP и каждый этап |
| A11 | Полный allowed catalog доступен; отозванный после discovery capability запрещён при вызове | Этап 3 |
| A12 | Pins и source refs переживают compaction; недоступность retained source показана явно | Этап 2 |
| A13 | Raw events неизменяемы, interpretation не выдаётся за observation, corrections сохраняют provenance | Этапы 2/4 |
| A14 | Skill не получает дополнительных прав через runner/network/files или вложенный вызов | Этап 4 |
| A15 | UnionClef/иной адаптер подтверждает результат извне; legacy voice/chat проходит regression | Этап 3 |
| A16 | Rollback сохраняет pending work, не запускает двойной consumer и не повторяет эффект | Каждый этап |
| A17 | В core отсутствуют persona-specific цели и обязательные мотивационные расписания | Каждый этап |

Проверки используют управляемые часы, fake engines/adapters и PostgreSQL для
транзакций, гонок, уникальности и восстановления. Unit mocks недостаточны для claims.
Pi и Codex проходят одинаковые contract-сценарии. Реальные outbound действия
не требуются для проверки MVP; адаптер включается после отдельного end-to-end gate.

Метрики: verified completion по origin, tokens/cost на verified activity, intervention,
wakeup lateness, queue age, expired leases, unknown/reconciled outcomes, duplicate
side effects, cancellation latency, pin omission, provenance coverage, leaks и
unauthorized calls. Trace связывает activity/turn/wakeup/operation/evidence.
Сравнения проводятся на одинаковых сценариях и модели; количество созданных целей
и вызовов не считается улучшением. Допуск: ноль утечек и неавторизованных эффектов,
прохождение матрицы этапа и отсутствие регрессии baseline. Численные performance
пороги устанавливаются по baseline этапа 0 до production enable.

Реализован интерфейс reviewer bridge и очередь повторной оценки; семантический reviewer и live pilot остаются закрыты: [четвёртый срез](../../runtime-2-review-workflow.md).

Добавлен отдельный Codex reviewer bridge с закреплёнными binary/config/model и
проверками протокола. Живая аттестация и semantic evals ещё не выполнены:
[пятый срез](../../runtime-2-codex-reviewer.md).
