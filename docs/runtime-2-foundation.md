# Runtime 2.0: слой постоянного состояния

Статус на 2026-10-18: реализован первый инфраструктурный срез в отдельной ветке.
Подключение движков добавлено следующим [срезом протокола](runtime-2-engine-protocol.md).
Это часть этапа 1 [спецификации](superpowers/specs/2026-10-18-agent-autonomy-runtime.md),
а не готовый автономный runtime. Рабочий инстанс не обновлён.

## Что работает

- Миграция `012-runtime-activities`: activities, turns, checkpoints, wakeups,
  сохранённые решения и аудит переходов. Существующая таблица `operations` не меняется.
- Поручения владельца с фиксированными origin/requested_by; модель не может
  подставить автора или аудиторию в owner API.
- Транзакционные claim/decision в storage API: один активный turn на персонажа,
  replay claim/decision, CAS version, checkpoint и ожидание одним commit.
- Таймер, continue с минимальным интервалом, needs_input, ответ владельца,
  локальное завершение и отмена. Завершение не является доказательством внешнего эффекта.
- Восстановление прерванного turn с тем же objective и последним checkpoint.
- Смена epoch/owner pause атомарно прерывает runtime turns через DB trigger,
  создаёт recovery wakeup и сохраняет цель. Старый lease не возобновляется.
- Изоляция по character/audience и составные FK для checkpoints/turns/wakeups.
- Ограничения первого среза: до 100 открытых activities на персонажа, 1–100 turns
  на activity (по умолчанию 10), до 100 runtime claims за скользящие 24 часа,
  lease 90 секунд, continue/wait не раньше чем через 60 секунд, checkpoint до
  16000 символов. Неуспешный/прерванный claim не возвращает бюджет автоматически.

Бюджет ограничивает число резервирований runtime turns; это не token/cost budget.
Модельные вызовы в данном срезе вообще не запускаются.

## Включение owner storage

После миграции установить `RUNTIME_STORAGE_ENABLED=true` для core; в Compose флаг
передаётся из окружения. По умолчанию false. Значения кроме true/false отвергаются.
`/owner/status` сообщает `runtime.storage_enabled` и `autonomous_execution: false`.
Это включает owner API хранения и закрытый engine protocol — не модель, scheduler
или внешние действия.
Отключение флага скрывает маршруты, сохраняя записи. Для отката остаётся новая
схема: удалять миграцию с данными не требуется. Перед откатом с будущего исполняющего
runtime потребуется отдельно drain/reconcile, как описано в общей spec.

Все маршруты требуют существующий owner bearer token, запрещают browser Origin,
используют общий owner rate budget и возвращают `Cache-Control: no-store`.
Аудитория фиксируется конфигурацией core; доступ к произвольным Telegram bindings
через эти маршруты ещё не предоставлен.

| Маршрут | Контракт |
| --- | --- |
| `POST /owner/activities` | `{invocation_id, objective, max_turns?}`; повтор с тем же payload не создаёт вторую activity |
| `GET /owner/activities?limit=20&offset=0` | Scoped список, limit 1–100, offset 0–10000; включает budget blocked_reason |
| `GET /owner/activities/:id` | Activity и последний checkpoint |
| `POST /owner/activities/:id/input` | `{expected_version, text}`; только для needs_input, без снятия owner pause |
| `POST /owner/activities/:id/cancel` | `{expected_version}`; отменяет pending wakeups и отзывает текущий runtime turn |

Конфликт версии возвращает 409; клиент перечитывает activity. Ошибки схемы — 400,
неверная роль/token — 401, неверная audience/character — scoped not-found (409).
Пауза запрещает новые поручения и input; чтение и отмена остаются доступны.

## Что ещё не включено

`RuntimeStore.claim/decide` подключены к защищённому engine protocol в
[следующем срезе](runtime-2-engine-protocol.md). В штатном main разрешающая policy
отсутствует: новые модельные ходы не запускаются. Bootstrap, self-origin activities
и внешние tools для activity всё ещё не включены. Социальные события оба engine
обрабатывают прежним event-to-reply протоколом.

Нет event/operation waits, generic operation journal/reconciliation, provider и
content gates, workspace/context pins, нового memory backend или skill sandbox.
Следующий срез должен добавить эти гарантии поэтапно и затем подключить engine.
[Контент-политика](superpowers/specs/2026-10-18-agent-content-policy.md) остаётся
обязательным gate перед production enable автономного режима. Текущий флаг хранения
не является прохождением этого gate и не меняет безопасность legacy output.

Hy-Memory не установлен; отдельный платный модельный API для памяти не добавлен.
План: agent-authored факты и опыт через существующий движок; источники и audience
проверяет core. Новый способ формирования памяти пока не реализован.

## Проверки

Полный Node-набор запущен на Node 24.19.0 с изолированной PostgreSQL:
153 теста прошли на этапе подключения протокола; актуальные проверки третьего среза описаны в [policy/resources](runtime-2-policy-resources.md), пропущенных нет. Typecheck также проходит. Runtime покрыт HTTP
проверками ролей, scope, лимита, выключенного флага и отсутствия engine routes;
PostgreSQL проверками конкурентных claims, replay, budgets, crash/recovery,
rollback после вставки checkpoint, owner pause/resume, cancel, needs_input,
составных FK и сосуществования с legacy lease. Внешние сервисы и модели не вызывались.

Тесты входят в обычный `pnpm test`; PostgreSQL-сценарии требуют отдельную тестовую
БД через `TEST_DATABASE_URL`. Схемы создаются уникальными и удаляются после тестов.
На production DATABASE_URL тесты запускать нельзя.
