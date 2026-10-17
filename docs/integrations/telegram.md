# Интеграция Telegram

Дата решения: 2026-10-17. Транспорт — **Telegram Bot API**. Пользователь выбрал
бота вместо ранее запланированного пользовательского аккаунта Teleproto/MTProto.
Первый срез адаптера реализован; живые текстовые ответы проверены в личке и группе. Контракт:
[спецификация Telegram MVP с диаграммами](../superpowers/specs/2026-10-17-telegram-mvp.md).

## Первый сценарий

Одна личка и одна тестовая группа. В личке пользователь первым пишет боту.
В группе Лада сама выбирает ответить или промолчать; для получения обычной
переписки Privacy Mode отключается через BotFather, затем бот повторно добавляется
в группу. Самостоятельное участие ограничивается бюджетами core.

Память и локальная история разделены по чатам. Telegram-личность не связывается
автоматически с Minecraft по имени или username. Работа со сторонними ботами,
callback-кнопками, файлами и голосовыми сообщениями в первый срез не входит.

## Подключение и полномочия

Владелец создаёт бота через BotFather и задаёт token как секрет worker.
Телефон, пользовательская сессия и api_id/api_hash не нужны. Один worker на бота;
идентичность проверяется через getMe. Binding связывает bot_id + chat_id с
character_id и отдельной audience_id. Bindings и паузу контролирует owner.
Модель не получает token и не может менять целевой чат.

## Получение и история

Worker использует long polling getUpdates. Публичный webhook не нужен; наличие
активного webhook — явная ошибка конфигурации. Update сохраняется или явно
помечается проигнорированным до подтверждения следующего offset. Offset устойчив
к рестарту; дедупликация использует bot_id/update_id и ключ сообщения внутри чата.

История — журнал полученных сообщений после подключения чата. Произвольная
история Telegram не запрашивается. Updates хранятся Telegram не дольше 24 часов;
после длительного разрыва возможны невосстановимые пропуски. Неполнота наблюдений
отражается явно. Сообщения ботов и собственные отправки не будят персонажа в MVP.

## Ответы и доставка

Финальное решение Pi/Codex — reply(text) или silence. Core завершает событие
транзакционно; для reply создаёт outbox, для silence ничего не отправляет.
MCP предоставляет telegram_read_history только для локального журнала текущего
чата. Отдельный telegram_send_message в MVP не публикуется.

SendMessage выполняет worker после проверки pause, binding, deadline и бюджетов.
HTTP 429 с retry_after сохраняется как ожидание без повторного LLM turn.
У sendMessage нет клиентского ключа идемпотентности: при неоднозначном результате
ставится unknown без автоматического повтора. Внутренний operation_id защищает
журнал core, но не предотвращает внешний дубль при повторной отправке.
Sent означает приём Telegram, а не прочтение сообщения.

## Проверки

Спецификация содержит критерии TG-01…TG-18: контекст и права, reply/silence,
устойчивый offset, групповые бюджеты, доставка, pause, рестарт, секреты и ошибки.
Автоматические тесты используют подставной транспорт и тестовую PostgreSQL.
Живые проверки выполняются отдельно на выделенном боте и разрешённых тестовых чатах.

Источники: [Bot API](https://core.telegram.org/bots/api),
[Privacy Mode](https://core.telegram.org/bots/features#privacy-mode),
[создание бота](https://core.telegram.org/bots#how-do-i-create-a-bot).

## Запуск реализации

Нужны Node 24, Docker/Compose и существующие secrets core/engine. Новые файлы
готовятся без перезаписи:

```sh
node --experimental-strip-types scripts/setup-telegram-secrets.ts
```

Создайте отдельного бота через BotFather. В локальный файл
`secrets/telegram_bot_token` запишите token; в чат с агентом его присылать не нужно.
Для группы отключите Privacy Mode через BotFather и повторно добавьте бота в группу.
Бот не требует прав администратора. Первый контакт в личке начинает пользователь.

Запуск Telegram и core с миграциями (существующий локальный compose.override.yaml
этой командой не подхватывается; нужные локальные настройки подключайте явным `-f`):

```sh
docker compose -f compose.yaml -f compose.telegram.yaml --profile telegram up --build -d core telegram
```

Добавьте используемый engine, например Codex, с его существующим login:

```sh
docker compose -f compose.yaml -f compose.telegram.yaml --profile telegram --profile codex up --build -d codex-engine
```

Pi запускается аналогично с профилем `agent` и сервисом `engine`.
Не запускайте оба engine одновременно для одной демонстрации без необходимости.

После старта напишите боту в личку и отправьте текст в тестовую группу. Пока чаты
не подключены, ответа не будет. Владелец увидит только идентификаторы замеченных
чатов, без сохранённой переписки из неподключённых чатов:

```sh
node --experimental-strip-types scripts/telegram.ts status
node --experimental-strip-types scripts/telegram.ts bind BOT_ID PRIVATE_CHAT_ID private
node --experimental-strip-types scripts/telegram.ts bind BOT_ID GROUP_CHAT_ID group
```

Замените BOT_ID и CHAT_ID значениями из status. Допускается одна активная личка и
одна группа. После привязки отправьте новое сообщение; старое не становится
поручением задним числом. Ответ в группе может быть silence — это штатное решение.
Бюджет групповых решений — до 20 в час, инициативных ответов — до двух за 10 минут.

Отключение чата и ручное разрешение неизвестной доставки:

```sh
node --experimental-strip-types scripts/telegram.ts bind BOT_ID GROUP_CHAT_ID group disabled
node --experimental-strip-types scripts/telegram.ts resolve DELIVERY_ID sent MESSAGE_ID
node --experimental-strip-types scripts/telegram.ts resolve DELIVERY_ID cancelled
# Только после ручной проверки чата: повтор может создать дубль.
node --experimental-strip-types scripts/telegram.ts resolve DELIVERY_ID retry
```

Status показывает очередь, pending events, auth/configuration errors и разрывы
наблюдения. Тексты сообщений и token в нём не выводятся. Глобальная пауза владельца
остаётся `/owner/pause`; она отменяет очередь, но не отзывает запрос, уже ушедший в Telegram.

Worker использует один активный polling lease на бота. При активном webhook
нужно самостоятельно решить, отключать ли старую интеграцию: новый worker не удаляет
webhook автоматически. `auth_required` требует проверки/замены token и перезапуска.

## Автоматическая проверка

```sh
pnpm typecheck
pnpm test
# Для транзакционных тестов задайте URL отдельной тестовой БД:
TEST_DATABASE_URL=postgresql://test_user:test_password@127.0.0.1:5432/harness_test pnpm test
```

PostgreSQL-тесты создают и удаляют только собственные временные schemas. Без
TEST_DATABASE_URL они пропускаются. CI использует PostgreSQL 18. Локальная проверка выполнена на Node 24 и временной PostgreSQL 14. Живые ответы
исходного Telegram MVP проверены в личке и группе; объединённая версия дополнительно
проверяется с социальной памятью и Minecraft-контрактами.


## Совместимость с main и существующей установкой

Telegram использует ту же систему социальной памяти, что Minecraft: sourced facts,
отношения, обязательства и working state. MCP применяет audience текущего события;
сохранение staged memory и завершение Telegram-события выполняются одной транзакцией.
Групповой пакет относится к последнему автору события; факты других участников
нельзя приписывать текущему собеседнику. Автоматической связи людей между чатами нет.

Миграция 010 расширяет main после 007-social-memory, 008-memory-staging и
009-reply-channel. Номер 007 раннего отдельного Telegram-прототипа не используется
для новых установок. При переносе БД этого прототипа сначала выполняются миграции
социальной памяти; существующий active_event_id сохраняется. Таблицы Telegram
создаются с IF NOT EXISTS для сохранения раннего журнала. Объединение разных баз
между собой не выполняется автоматически.
