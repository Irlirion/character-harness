# Запуск в Docker

Статус: core/PostgreSQL, Pi profile и Codex profile запускаются в Docker. На Mac отдельно работают Prism Minecraft client, UnionClef и нативные Qwen3-TTS/audio workers. Для UnionClef core использует `compose.unionclef.yaml` и отдельный MCP token-файл.

## Базовая топология

- core: доверенный Linux-контейнер Node.js 24, control plane, MCP HTTP и будущие адаптеры сред.
- engine: отдельный контейнер Pi, который не получает credentials БД или игровых аккаунтов; обращается к core через аутентифицированный MCP HTTP.
- codex-engine: отдельный profile container, isolated Codex app-server login, ограниченные MCP tools и отдельный `codex_data` volume.
- postgres: отдельный контейнер PostgreSQL 18 с постоянным volume.
- migrate: одноразовый запуск того же образа приложения для миграций БД.
- Minecraft: UnionClef MCP на локальном Prism client, без project-owned Fabric companion и без server addon.
- Audio: native Node/Swift worker на Mac, Loopback и клиентский SVC.
- TTS: native macOS Python/MLX service на `127.0.0.1:3081`; модель прогревается до readiness. Piper и отдельный TTS Docker image больше не входят в runtime.

Для Docker core и engines Node.js на хосте не нужен. На Mac native audio worker требует Node 24 и Swift toolchain; native game client управляется через PrismLauncher. Первый игровой срез использует Codex subscription через собственный device login.

Codex CLI/runtime поставляется через закреплённый пакет; авторизация хранится в отдельном `codex_data`, вход на хосте не копируется. Проверена модель `gpt-6-luna`; недоступная модель приводит к ошибке запуска без fallback.

## Постоянные данные

PostgreSQL хранит персонажей, события, память, ответы и речь. Отдельные `engine_data`/`codex_data` volumes хранят изолированное runtime-состояние. Telegram-сессия пока отсутствует. Конфигурация персонажа монтируется read-only; секреты не находятся в образе или репозитории.

Удаление и пересоздание контейнера сохраняет биографию и сессии. Удаление volumes является отдельной разрушительной операцией. Резервная копия должна включать БД и файловое состояние с согласованной контрольной точкой.

## Сеть и готовность

PostgreSQL доступен по имени сервиса postgres в сети Compose; порт БД не публикуется по умолчанию. core и engine имеют исходящий доступ к Telegram, модельному API и игровому серверу. API управления публикуется только на localhost хоста.

Внутри контейнера localhost означает сам контейнер. Для тестового Minecraft адрес — имя сервиса minecraft. Для внешнего сервера — DNS/IP. Для сервера на хосте используется host.docker.internal: на Docker Desktop он доступен штатно, на Linux задаётся host-gateway mapping.

PostgreSQL healthcheck предшествует migrate; core запускается после успешных миграций. Проект отдельно реализует reconnect и backoff: порядок запуска Compose не заменяет восстановление после runtime-сбоев. Health API различает живой процесс, готовую БД и состояния адаптеров, включая auth_required.

## Остановка и перезапуск

Контейнер использует init и обрабатывает SIGTERM: останавливает Codex app-server child и закрывает подключения. Core fencing отзывает turn при pause/смене epoch; stale results не сохраняются. После запуска просроченная речь истекает, внешние эффекты со status unknown автоматически не повторяются.

## Мастерская

Доверенные workers приложения работают в core. Сгенерированный код выполняется в отдельном одноразовом контейнере с ограниченными CPU/памятью/PID, непривилегированным пользователем, read-only rootfs, временной рабочей областью и выключенной сетью по умолчанию.

Агент и core не получают Docker socket, privileged или произвольный доступ к файловой системе хоста. Запусками управляет отдельный runner вне агентного контейнера. Runner принимает ограниченные задания, выбирает заранее разрешённый образ и mounts, не принимает произвольные Docker-флаги. Для первой версии runner может быть локальным служебным процессом оператора; его автоматизация — отдельный этап. Основной агент полностью работает в Docker и без runner; генерация кандидатов допустима, их исполнение до готовности runner недоступно.

Контейнерные лимиты уменьшают риски, но не объявляются абсолютной границей защиты для недоверенного кода. При расширении модели угроз используется отдельный хост/VM.

## Критерии готовности

1. На чистом хосте с Docker/Compose образ собирается и runtime запускается без локальных Node.js/Pi.
2. Telegram авторизуется через одноразовый контейнер и восстанавливает сессию.
3. Minecraft подключается к тестовому и внешнему серверу.
4. Пересоздание harness сохраняет память, задачи и историю персонажа.
5. Завершение процесса во время действия приводит к сверке, а не слепому повтору.
6. Секреты отсутствуют в образе, Git и логах.

Источники: [готовность сервисов Compose](https://docs.docker.com/compose/how-tos/startup-order/), [секреты Compose](https://docs.docker.com/compose/how-tos/use-secrets/).

## Постоянная доступность

Для поведения по образцу Dots Compose разворачивается на постоянно доступном сервере. Локальный Docker не обеспечивает работу после выключения хоста. Wakeups и обязанности сохраняются в PostgreSQL; restart восстанавливает ожидания.

## Simple Voice Chat

Minecraft chat ingress и voice STT передаются отдельным Fabric client companion; UnionClef MCP остаётся единственным исполнителем игровых действий. В Compose используйте bridge token и STT profile. Game voice output идёт через native audio worker, Loopback и Simple Voice Chat. Healthy контейнеры не доказывают, что клиент подключён или игрок услышал звук; это отображается отдельно в панели и требует live-проверки.

Запуск и текущий статус: [development](development.md). Для MCP Minecraft запускайте Compose с [UnionClef overlay](unionclef-migration.md). Полный Telegram/social MVP не готов.
