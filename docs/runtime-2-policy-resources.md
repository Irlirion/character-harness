# Runtime 2.0: допуск контента и ресурсы

Статус на 2026-10-18: третий инфраструктурный срез. Добавлены durable policy grants,
проверка точного input/output, одноразовый старт и консервативный учёт ресурсов.
Production autonomous execution по-прежнему выключен: профиль и семантический
проверяющий компонент автоматически не устанавливаются. Платные API не подключены.

Продолжает [engine protocol](runtime-2-engine-protocol.md). Требования контента:
[OpenAI + базовый профиль ЕС](superpowers/specs/2026-10-18-agent-content-policy.md).
Это механизм исполнения политики, а не сертификация соответствия праву или гарантия
отсутствия блокировки. Полный семантический классификатор в этом срезе не реализован.

## Проверка перед inference

1. Core проверяет действующий operator profile: version, review interval, enabled,
   provider eligibility, точные engine/model и заданные ограничения ресурсов.
2. Выбирает готовую activity без claim и собирает предварительный model context.
3. Локально проверяет известные форматы секретов и размер сериализованного payload.
   Наличие секрета запрещает передачу reviewer; отсутствие совпадения не даёт allow.
4. ContentReviewer проверяет весь подготовленный запрос: input, persona, системные
   инструкции и схему единственного инструмента. Он возвращает allow/deny/needs_review,
   rule_id, policy_version и hash проверенного payload. Ошибка, неверная привязка
   и timeout дают needs_review; checker без ограничения времени не ожидается вечно.
5. Под character lock core повторно проверяет исходные данные и актуальность policy,
   резервирует ресурсы и сохраняет grant в той же транзакции, что и claim/wakeup/turn.
6. Engine получает исходный одобренный model_input и сверяет hash со своими
   инструкциями, инструментом и выбранной моделью. Перед inference запрашивает
   одноразовый `/engine/work_start`. Повтор такого старта запрещён.

SHA-256 связывает допуск с содержимым; это не цифровая подпись внешнего эксперта.
Доверие основано на operator-controlled code, БД и недоступном модели engine bearer.
Указание моделью «одобрено» или передача extra approval fields в tool/API не дают прав.

Заблокированный input не тратит turn/resource reservation. Hold сохраняет причину,
policy version, activity version и hash без копии исходного текста. Он не запускает
бесконечные повторные проверки и не мешает следующей независимой activity. Новая
версия политики допускает новую проверку, но не обходит локальный запрет секретов.
Исходные objective и безопасный checkpoint остаются сохранёнными.

## Проверка результата

После структурного разбора checkpoint/decision проходит output review. В reviewer
не передаются lease credentials; approval относится к точным checkpoint/decision,
а core дополнительно связывает commit с полным payload, turn и его полномочиями.

Grant должен быть started, не просрочен и принадлежать этому character/audience.
В транзакции commit повторно проверяются текущая policy version/hash и output hash.
Смена политики во время review запрещает запись. Отклонённый output не становится
checkpoint: сохраняются только hash, rule_id и состояние блокировки. После recovery
работа остаётся на hold вместо повторного расхода модели на тот же запрещённый шаг.

Exact replay уже сохранённого решения возвращает квитанцию без повторной семантической
проверки и без новой inference, пока сохраняются соответствующие epoch и policy.
Изменённый payload, другая версия политики или grant не являются replay.

## Версии и отзыв

Миграция `013-runtime-authorization` добавляет policy profiles/current pointer,
input/output holds, model grants и минимальный policy audit. Версия профиля неизменяема:
повтор установки идентичного профиля допустим, другая конфигурация под тем же version
отклоняется. Установка доступна только через внутренний operator composition API;
нет HTTP/MCP метода или owner toggle для обхода запретов.

`main.ts` подключает реальный default-deny RuntimePolicyGate, но не создаёт профиль
и не предоставляет allow reviewer. Оба feature flags остаются false по умолчанию.
При отсутствии/истечении профиля новые claims закрыты; при отсутствии reviewer
даже подходящий input получает needs_review. Тестовые allow policies живут только
в fixtures и не используются production main.

Проверка lease включает действующий grant. Pause, смена epoch, policy revision,
блокировка grant и expiry запрещают новый start/commit и приводят к отмене adapter turn.
Уже выданный permit и фактически принятый провайдером вызов невозможно атомарно
отозвать через PostgreSQL: engine прерывает его best effort, а резерв сохраняется.

Legacy MCP недоступен во время runtime turn. Старые memory/action transactions
дополнительно отклоняют runtime marker. Новые grants не выдают игровых, сетевых,
файловых или messaging прав и не изменяют исходную цель агента.

## Ресурсы и наблюдаемость

Ограничения обязательны в operator profile; отсутствие значения не значит unlimited.

| Поле | Фактическая гарантия |
| --- | --- |
| max_input_chars / max_output_chars | Предел длины сериализованного проверяемого payload в UTF-16 units; не token count провайдера |
| max_model_ms | Не более 75 секунд; после start сервер сокращает срок grant, поздний commit запрещён, adapter также имеет таймер |
| max_dispatches_24h | Предел числа grant reservations на персонажа за скользящие 24 часа, включая выданные, но не использованные |
| reserved_tokens | Консервативный резерв учётных token units на grant; не доказанный hard cap генерации модели |
| token_budget_24h | Новые grants разрешены, пока сумма max(reserved, observed) плюс новый резерв помещается в бюджет |

Ресурсы считаются по персонажу через все аудитории и все версии policy. Рестарт,
отмена, неизвестный исход и смена policy не возвращают резерв автоматически.
При известном большем расходе учитывается большее значение; последующие меньшие
и неизвестные показания не уменьшают счётчик. Просроченное окно перестаёт участвовать
в проверке, goal/checkpoint при этом не удаляются.

`max_dispatches_24h` ограничивает разрешённые runtime sessions, а не внутренние
HTTP retries/LLM steps SDK. Денежный расход и лимит подписки жёстко не гарантируются:
для этого нужен подтверждённый механизм контроля самого провайдера. Если одна сессия
превысит резерв, фактические показания блокируют последующие выдачи при исчерпании
бюджета; неизвестный расход остаётся покрыт резервом без автоматического возврата.

Pi передаёт `getSessionStats().tokens.total`; Codex читает thread/tokenUsage/updated
для точных threadId/turnId из ephemeral session. Значение поступает от адаптера,
не из tool arguments модели. Это engine-observed telemetry, а не сверенный биллинг.
При отсутствии/потере телеметрии observed_tokens остаётся null. Фиксирование расхода
после pause/expiry разрешено: оно не запускает модель и не публикует данные.
Контракт уведомления сверялся с локальной схемой и
[App Server documentation](https://learn.chatgpt.com/docs/app-server).

| Endpoint | Назначение |
| --- | --- |
| POST /engine/next_work | Теперь принимает request_id, engine, model; возвращает immutable approved context и grant metadata |
| POST /engine/work_start | turn/lease + grant_id/input_hash/engine/model; ровно один разрешённый старт |
| POST /engine/work_usage | Scoped monotonic total_tokens или null + source; не снимает бюджет и не меняет activity |
| GET /owner/runtime-policy | Текущий профиль, общий ресурсный счётчик и bounded scoped grants без model_input/lease secrets |

Существующие role authentication, rate limits, запрет browser Origin и no-store
действуют для новых маршрутов. Owner API только читает policy state. В аудит не
копируются prompts, responses и известные секреты.

## Проверки и оставшийся объём

Проверены default deny, eligibility/expiry, timeout/failure reviewer, secret checks
до reviewer, review hash/version binding, изменение источника во время review,
immutable profile versions, параллельные reservations, одноразовый start, потеря
start response без inference, server expiry, restart/window budgets, monotonic usage,
отклонённый output без checkpoint и без повторного модельного цикла, смена policy
во время output review, exact receipt replay и совместимость с обоими adapters.

Семантический reviewer, workflow разбора needs_review, проверка реального account/
provider eligibility, полный retention/deletion процесс и live native-tool validation
ещё требуют реализации/проверки. Новые проверки охватывают planning activities;
они не превращают существующие Telegram/voice/image pipelines в модерируемые.
Проверка медиа, disclosure, дальнейшие права и публикация — отдельные gates.

Следующий практический срез — подключение reviewer и operator workflow с проверками
применимости и privacy, используя существующий Codex engine без нового платного API,
если выбранный способ интеграции это допускает. До этого live autonomous execution
остаётся закрыт. Самописные навыки, self-origin bootstrap и внешние operations пока
не включаются.

## Проверка среза

Полный набор: 169 тестов, без пропусков; проверка типов пройдена. Обновление базы с миграции 012 до 013 и повторный запуск всех 14 миграций проверены в отдельной временной схеме: существующие данные сохранены. Живые вызовы моделей не выполнялись.

Подключение reviewer bridge и очередь повторной оценки описаны в [четвёртом срезе](runtime-2-review-workflow.md).
