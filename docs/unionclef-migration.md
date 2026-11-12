# Minecraft через UnionClef MCP

Проект использует гибридную клиентскую схему. UnionClef MCP выполняет игровые действия; Fabric client companion передаёт чат, STT и наблюдения server session, а также выполняет ограниченный поворот камеры. Приём системного чата включён только для `mc.agicraft.ru:25565`; имена в нём не подтверждают личность игрока. Поворот через companion включён только на тестовом сервере. После установки UnionClef и companion перезапустите выбранный Prism instance.

## Установка

Закреплённый upstream: [3ndetz/unionclef](https://github.com/3ndetz/unionclef), `v0.95.63`, Minecraft `1.21.11` / Fabric / Java 21. Артефакт проверяется по SHA256 перед установкой. Выполните dry run и примените изменения к выделенному тестовому instance:

```sh
node --experimental-strip-types scripts/setup-bridge-secret.ts
node --experimental-strip-types scripts/setup-stt-secret.ts
node --experimental-strip-types scripts/download-stt-model.ts
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft'
node --experimental-strip-types scripts/setup-unionclef.ts '/absolute/path/to/instance/minecraft' --apply
```

Скрипт включает аутентифицированный MCP endpoint на `127.0.0.1:25350`, создаёт отдельный локальный token-файл, устанавливает UnionClef и пересобранный companion jar, а прежние jar/config предварительно складывает в `minecraft/character-harness-backups`. В properties включаются signed chat, системный чат для тестового сервера, STT и наблюдения; `actions_enabled` включён для поворота; внутренние UnionClef flags выключены. Существующий корректный локальный `core_url` сохраняется; для новой установки используется порт 3000. Остальные properties companion задаются скриптом заново. Возможности break/place остаются настройкой UnionClef/Tungsten.

## Подключение core

Для Docker Compose используйте token-файл из выбранного Minecraft instance как Docker secret. Значение token не копируйте в `.env`, команды логирования или чат:

```sh
UNIONCLEF_MCP_TOKEN_PATH='/absolute/path/to/instance/minecraft/config/character-harness-unionclef-mcp.token' \
  docker compose -f compose.yaml -f compose.unionclef.yaml --profile stt up -d core stt
```

Оверлей соединяет core с `http://host.docker.internal:25350/mcp`, включает ограничения для тестового мира и подключает локальный STT service. Без него Minecraft MCP считается не настроенным. Панель раз в пять секунд показывает результат read-only вызовов `tools/list` и `getGameState`, число опубликованных инструментов, позицию и число игроков; отдельная карточка показывает свежий сигнал companion и readiness чата/голоса.

## Граница возможностей upstream

Проверенная версия UnionClef предоставляет полный MCP-каталог и `getGameState`, но не сообщает core адрес подключённого сервера или UUID сессии/переподключения. Companion передаёт server/session scope для inbound chat/STT и наблюдений отдельно от MCP действий. Поэтому:

- панель может показать, что MCP доступен и клиент находится в мире, но не может подтвердить, что это ожидаемый сервер;
- прямые наблюдения помечаются как локальные и непроверенные;
- вызов `ConnectToServer` заблокирован; смена сервера делается вручную владельцем;
- session fencing inbound chat/STT не является server/session fencing для MCP действий;
- входящий voice STT требует Simple Voice Chat, разрешённого сервера и готового локального STT service;
- native Qwen TTS/audio worker остаётся отдельным сервисом, и его heartbeat не доказывает, что игрок услышал звук.

Для полного автономного игрового цикла остаются live-проверки chat/reply/reconnect и STT/SVC пути. Пауза персонажа и epoch проверки core продолжают ограничивать вызовы.

## Панель

Откройте `http://localhost:3000/`, введите `OWNER_TOKEN` и нажмите «Подключить». Карточка UnionClef показывает MCP статус, карточка игрового чата/голоса — состояние companion, server session и readiness STT/SVC. Исторические миграции таблиц bridge сохранены для совместимости базы.
