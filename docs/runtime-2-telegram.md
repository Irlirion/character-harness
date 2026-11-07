# Runtime 2.0 через Telegram

Управление доступно в привязанном личном чате после отдельного разрешения владельца.
`POST /owner/telegram/runtime-control` принимает `binding_id` (UUID) и `enabled`
(boolean), требует owner token и общий owner rate limit. Группа не может получить
это право. Миграция 015 ставит `runtime_control=false` всем существующим bindings;
обычная привязка чата сама по себе не делегирует управление runtime.

Команды:

- `/task Составь план безопасного строительства дома` — создать activity, до 5 ходов.
- `/tasks` — последние 10 задач только этого чата.
- `/status [ID]` — состояние и проверенный уточняющий вопрос.
- `/result [ID]` — проверенный итог или checkpoint, до 2000 символов.
- `/answer [ID] Деревянный дом 10 на 10` — ответить на вопрос activity.
- `/cancel [ID]` — отменить задачу.
- `/help_tasks` — справка.

Без ID выбирается последняя подходящая задача из последних 20: для answer —
needs_input, для cancel — незавершённая, для status/result — последняя. Более старую
задачу можно указать по полному UUID. Просмотр результата происходит по запросу;
автоматических сообщений о завершении нет. Обычный разговор с ботом сохраняется,
но не создаёт скрытых persistent activities.

## Авторизация и обработка

Условия команды: актуальный polling lease, новое и свежее Telegram-сообщение,
включённый binding с runtime_control, private chat и numeric from.id == chat.id.
Имена, упоминания, пересланный текст и модельные рассуждения не предоставляют прав.
Существующий normalizeUpdate исключает bots, sender_chat, automatic forwards и forum.
Команды в группах/неавторизованных привязках не запускают ни задачи, ни модельный ответ.
Сохраняется предел 10 private inputs в минуту и стандартные outbox rate/lease limits.

Activity, сообщение, update offset и receipt/outbox коммитятся одной транзакцией.
Повтор update/message не повторяет side effect. Ошибка поздней записи откатывает
создание activity и acknowledgment. Командные social events отмечаются processed,
поэтому legacy engine не отвечает на ту же команду вторично.

Приватная audience binding сохраняется в activity и model_input. Новый audience gate
добавляет только разрешённые сервером private scopes, поддерживает claim replay и
по turn ID выводит scope для start/lease/decision/usage; engine body не выбирает audience.
Один character lease и общие бюджеты действуют для всех scopes. Отключённый binding
не может продолжать inference; поздняя usage accounting допускается по старому
credential без права действий. Отзыв runtime_control меняет revision и epoch.

## Выдача результата

Question/result берутся только из durable state с finished grant и актуальной
проверенной политикой; выдача фиксируется в outbox вместе с activity version,
checkpoint turn, profile version/hash и hash полного текстового сообщения.
Перед claim worker повторно проверяются эти связи, scope, enabled/runtime_control,
binding revision, срок политики и text hash. Отзыв, смена политики, изменение
activity или подмена текста отменяют выдачу. Секреты дополнительно блокируются локально.
Отправка использует прежний bounded Telegram outbox; unknown delivery не ретраится
как новая отправка. Создание задачи не обещает доставку или выполнение внешних действий.

Профиль reviewer должен отдельно разрешать выдачу проверенного результата по
явному запросу владельца в том же private binding; approval локального planning
не даёт права произвольной публикации. Старый профиль не переносится на новый
rules hash без смены версии.

Проверки: PostgreSQL tests покрывают explicit delegation, private/group/sender scope,
replay/rollback, question/answer/result, engine audience routing, revoke/expired leases,
policy/payload delivery revocation и command rate cap. Живые Telegram-сообщения
в тестах не отправляются.
