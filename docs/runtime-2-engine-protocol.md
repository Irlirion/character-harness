# Runtime 2.0: подключение движков к activities

Статус на 2026-10-18: второй инфраструктурный срез реализован и проверен с fake
моделями. Новые live модельные ходы и production autonomous execution не включены.
Допуск и ресурсы добавлены в [третьем срезе](runtime-2-policy-resources.md).
Продолжает [слой постоянного состояния](runtime-2-foundation.md) и реализует часть
этапа 1 [общей спецификации](superpowers/specs/2026-10-18-agent-autonomy-runtime.md).

## Что добавлено

Pi и Codex умеют получать готовую activity, собирать отдельный контекст, принять
одно решение через `activity_decide` и сохранить checkpoint в core. Источником
постоянного состояния служит PostgreSQL, а не история модельной сессии.

Движки сначала получают социальное событие прежним `/engine/input`. Только если
события нет и включён opt-in, опрашивают `/engine/next_work` для activities.
Протокол социальных событий пока не перенесён в общий envelope. Обе очереди
сериализуются существующим character lease и epoch; один исполнитель не может
получить одновременно действующие права для social turn и activity turn.

Activity-ход получает objective, origin, остаток бюджета ходов, ответ владельца,
последний checkpoint, audience и причину пробуждения. Lease token, epoch, version
и invocation ID формирует и хранит адаптер; модель не может подменить их аргументами.
Raw DB create_payload, аудит и чужие разговоры в activity context не включаются.

Единственный динамический инструмент — `activity_decide` с checkpoint и одним
из решений `continue`, `wait_until`, `request_input`, `complete`. Он принимает
решение локально, а успешное сохранение подтверждает только core после завершения
модельного хода. Повтор инструмента, неизвестные поля и отсутствие решения — ошибка.
Свободный текст «готово» и chat `turn_finish` не завершают activity.

Это ход для локального планирования. Он не получает MCP, движение, сообщения,
генерацию изображений, workspace writes или новый memory tool. Completion означает
результат локального планирования, а не проверенный эффект во внешнем мире.

## HTTP-контракт

При `RUNTIME_STORAGE_ENABLED=true` core регистрирует owner storage и эти endpoints.
Используется существующий engine bearer, общий engine rate budget, запрет Origin и
`Cache-Control: no-store`. Scope фиксирует core, клиент не передаёт audience/character.

| Endpoint | Вход | Результат |
| --- | --- | --- |
| `POST /engine/next_work` | `{request_id}` | `{work:null,reason}` или scoped activity/turn/checkpoint/persona/wake_reason |
| `POST /engine/work_lease` | `{turn_id,epoch,lease_token}` | `{valid}` по актуальным pause, epoch, active turn, статусу и сроку |
| `POST /engine/work_decision` | WorkDecision из общей spec | Сохранённое состояние либо 409/400 без частичной записи |

`request_id` сохраняется consumer при потере claim response. Известный успешный
ответ завершает попытку polling и меняет request_id. На idle/blocked модель не
вызывается. Потерянный ответ на decision допускает один повтор того же payload
с тем же invocation ID; inference ради этого не повторяется. Если результат
повтора неизвестен, состояние проверяется при дальнейшем восстановлении, без
слепого повторного исполнения внешних действий.

Перед inference и перед commit проверяется lease; во время модели — раз в секунду.
Недоступность проверки, pause, смена epoch, истечение срока и shutdown прерывают ход.
Модельный deadline — до 75 секунд и не позднее чем за 10 секунд до конца lease.
Ошибочный/прерванный ход не освобождает потраченный turn budget автоматически.
Зависшая модель не удерживает consumer после отмены: её результат игнорируется.

Codex использует ephemeral thread, read-only sandbox, approval never и один dynamic
tool. Проверяются threadId/turnId каждого вызова; неизвестные server requests
отклоняются. Существующая изолированная конфигурация отключает native capabilities.
Pi использует отдельную in-memory session, пустой resource loader и единственный
custom tool; автоматические model retries для activity-хода выключены.
Контракты dynamic tool и notifications сверены с JSON-схемами установленного Codex.
Это не заменяет отдельную live-проверку поведения native tool restrictions.

## Проверка допуска остаётся закрытой

В `main.ts` теперь подключён [default-deny policy gate](runtime-2-policy-resources.md).
Без operator profile и reviewer новые модельные ходы закрыты. Boolean preflight
заменён привязанными допусками и одноразовым start; флагов обхода нет.

Встроенные fixture policies разрешают работу только в тестах с fake providers.
Перед production enable отдельно нужны provider eligibility, проверка входных
данных до передачи модели, проверка output, привязка допуска к версии policy и
payload, resource accounting и критерии
[контент-политики](superpowers/specs/2026-10-18-agent-content-policy.md).

Два независимых флага, оба по умолчанию false:

- `RUNTIME_STORAGE_ENABLED` в core: хранение и закрытый protocol surface.
- `RUNTIME_ENGINE_ENABLED` в Pi/Codex: попытка опроса activity-протокола после social
  queue. Сам по себе флаг не разрешает inference. Если core ещё старый или storage
  выключен, новый запрос завершается ошибкой; fallback на незащищённый путь нет.

Legacy MCP закрывается во время активного runtime turn. Запись старой памяти и
постановка Minecraft action дополнительно проверяют runtime marker в той же
транзакции, что и эффект: отсутствие инструмента в контексте не считается границей
авторизации. Старый social lease не возрождается после нового runtime claim.

## Проверки и следующие границы

На Node 24.19.0 и временной PostgreSQL полный набор: 153 теста, все прошли,
пропущенных нет. Typecheck проходит. Проверены:

- idle/blocked без inference, повтор claim, потеря commit response без повторной модели;
- отзыв lease, deadline, shutdown, malformed output и отсутствие commit после отмены;
- Pi и Codex tool isolation, ID fencing, повтор решения, quota failure и поздний ответ;
- реальный stdio RPC через fake Codex child process;
- HTTP + PostgreSQL: Pi → checkpoint/wait → независимый social turn → Codex resume;
- закрытая default policy, scope isolation и невозможность применить runtime lease
  к legacy memory/Minecraft tools.

Платные API и живые модели не использовались; рабочий инстанс не перезапускался.
Hy-Memory не подключён. Новая SQL-миграция сверх 012 для этого среза не нужна.

Policy/input/output gates и учёт модельных ресурсов добавлены в третьем срезе.
Семантический reviewer и условия live pilot ещё не подключены. Bootstrap, self-origin activities,
event/operation waits, generic operations и workspace/context остаются следующими
частями общей spec. Структурированная память через существующий Codex engine ещё
не добавлена: пока сохраняется checkpoint работы.
