# Character Harness

Харнес для автономных персонажей, которые действуют в Minecraft, Telegram и других средах, сохраняют память и расширяют свои возможности.

Последний аудит состояния кода: 2026-11-07 — [обзор проекта](docs/reviews/current-state-review.md). Minecraft подключается напрямую к UnionClef MCP; custom Fabric companion удалён. Полный живой социальный цикл не подтверждён: UnionClef пока не отдаёт входящие игровые chat/voice события, адрес сервера и ID переподключения. Локальная read-only веб-панель владельца открывается на `http://localhost:3000/`; для входа нужен `OWNER_TOKEN`.

Главная цель MVP — социальный вау-эффект для участников Minecraft-сервера и Telegram: узнаваемый персонаж с памятью, характером и уместной инициативой.

## Основная идея

Личность определяет поведение, харнес обеспечивает исполнение, мастерская расширяет возможности. Одно ядро запускает разные пакеты персонажей; каждый экземпляр имеет собственную историю, цели и память.

Движок исполнения: Pi Agent или Codex через заменяемый адаптер. Выбор движка отделён от личности и памяти.

Core, база и движки запускаются через Docker + Compose; состояние хранится в постоянных volumes. Компоненты, которым нужны локальное аудиооборудование или macOS MLX, работают нативно на Mac.

Продуктовый ориентир — Dots: один постоянный персонаж в разных каналах, работа между разговорами, длительные обязанности и самостоятельное пробуждение.

Telegram Bot API MVP: личка, одна группа с выбором reply/silence, социальная память по чатам и постоянная очередь доставки. [Подключение Telegram](docs/integrations/telegram.md).

## Начало разработки

Инструкции запуска и проверки: [development](docs/development.md). Состояние ревью и ограничения: [final review](docs/final-review.md).

## Документация

- [Безопасность и ограничения нагрузки](SECURITY.md)
- [Требования и границы](docs/requirements.md)
- [Постоянные агенты по образцу Dots](docs/persistent-agents.md)
- [Архитектура](docs/architecture.md)
- [Общий MCP-шлюз](docs/mcp-gateway.md)
- [Запуск в Docker](docs/docker.md)
- [Стек первой версии](docs/technology-stack.md)
- [Автоматический голос через Loopback](docs/audio-worker.md)
- [UnionClef Minecraft MCP](docs/unionclef-migration.md)
- [Интеграция Telegram](docs/integrations/telegram.md)
- [Движки Pi Agent и Codex](docs/engines.md)
- [Codex runtime и вход через подписку](docs/codex-engine.md)
- [Персонажи и адаптация](docs/characters.md)
- [Персоналия Лады](characters/Lada/personalities.yml)
- [Память и контекст](docs/memory-context.md)
- [Создание навыков и инструментов](docs/capability-workshop.md)
- [Оценка и улучшение](docs/evaluation.md)
- [Продуктовые эпики](docs/product-plan.md)
- [Независимое ревью Astra](docs/astra-review.md)
- [Варианты реализации](docs/implementation-options.md)
- [Варианты памяти](docs/memory-options.md)
- [План реализации](docs/roadmap.md)
- [Обзор текущего состояния и незакрытые риски](docs/reviews/current-state-review.md)
- [Архитектурные решения](docs/decisions/0001-character-runtime.md)
- [Журнал работы](docs/journal.md)

## Работа с проектом

Запуск и остановка сервисов одной командой: [`make start` / `make stop`](docs/local-services.md).

Обсуждения, принятые решения и открытые вопросы фиксируются в документации. Предложения отделяются от подтверждённых требований. При изменении архитектуры обновляются соответствующие документы и журнал; существенные решения оформляются отдельным ADR в `docs/decisions/`.
