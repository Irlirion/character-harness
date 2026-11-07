# Minecraft через UnionClef MCP

Проект использует установленный UnionClef как единственный Minecraft runtime. Custom Fabric companion и его bridge HTTP endpoints удалены. Скрипт установки включает authenticated MCP и удаляет companion jar/config из выбранного Prism instance, предварительно сохраняя их в backup. После установки нужен перезапуск только этого экземпляра.

## Установка

Закреплённый upstream: [3ndetz/unionclef](https://github.com/3ndetz/unionclef), `v0.95.63`, Minecraft `1.21.11` / Fabric / Java 21. Артефакт проверяется по SHA256 перед установкой. Выполните dry run и примените изменения к выделенному тестовому instance:

```sh
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft'
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft' --apply
```

Скрипт включает аутентифицированный MCP endpoint на `127.0.0.1:25350`, создаёт отдельный локальный token-файл, ставит только UnionClef и складывает удалённые bridge jar/config в `minecraft/character-harness-backups`. Прочие игровые настройки сохраняются. Установщик оставляет включёнными возможности break/place, настроенные в Tungsten.

## Подключение core

Для Docker Compose используйте token-файл из выбранного Minecraft instance как Docker secret. Значение token не копируйте в `.env`, команды логирования или чат:

```sh
UNIONCLEF_MCP_TOKEN_PATH='/absolute/path/to/instance/minecraft/config/character-harness-unionclef-mcp.token' \
  docker compose -f compose.yaml -f compose.unionclef.yaml up -d core
```

Оверлей соединяет core с `http://host.docker.internal:25350/mcp`. Без него Minecraft MCP считается не настроенным. Панель раз в пять секунд показывает результат read-only вызовов `tools/list` и `getGameState`, число опубликованных инструментов, позицию и число игроков.

## Граница возможностей upstream

Проверенная версия UnionClef предоставляет полный MCP-каталог и `getGameState`, но не сообщает core адрес подключённого сервера, UUID сессии/переподключения, устойчивые ID входящих сообщений или поток Simple Voice Chat. Поэтому:

- панель может показать, что MCP доступен и клиент находится в мире, но не может подтвердить, что это ожидаемый сервер;
- прямые наблюдения помечаются как локальные и непроверенные;
- вызов `ConnectToServer` заблокирован; смена сервера делается вручную владельцем;
- входящий игровой чат, STT и голосовые ответы в Minecraft недоступны после удаления companion;
- native Qwen TTS/audio worker остаётся отдельным сервисом, но его heartbeat не доказывает, что игрок услышал звук.

Для полного автономного игрового цикла upstream должен добавить достоверный server/session status и события чата/голоса с устойчивыми идентификаторами. До этого агент получает MCP-инструменты при активном мире, но не просыпается от сообщений Minecraft сам по себе. Пауза персонажа и epoch проверки core продолжают ограничивать вызовы.

## Панель

Откройте `http://localhost:3000/`, введите `OWNER_TOKEN` и нажмите «Подключить». Карточка UnionClef показывает прямой MCP статус; отметка о недоступном server/session identity видна явно. Исторические миграции таблиц bridge сохранены, чтобы обновления существующей базы данных оставались последовательными; текущий core эти таблицы и маршруты не использует.
