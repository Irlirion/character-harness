# Character Harness

Харнес для автономных персонажей, которые действуют в Minecraft, Telegram и других средах, сохраняют память и расширяют свои возможности.

Статус: начат первый кодовый срез core/MCP/Pi/PostgreSQL. Docker-сборка, миграции и MCP/SQL smoke прошли; автоматический голос через native клиент/Loopback проверен на сервере; игровой bridge и автономный диалог ещё не реализованы. Название рабочее.

Главная цель MVP — социальный вау-эффект для участников Minecraft-сервера и Telegram: узнаваемый персонаж с памятью, характером и уместной инициативой.

## Основная идея

Личность определяет поведение, харнес обеспечивает исполнение, мастерская расширяет возможности. Одно ядро запускает разные пакеты персонажей; каждый экземпляр имеет собственную историю, цели и память.

Движок исполнения: Pi Agent или Codex через заменяемый адаптер. Выбор движка отделён от личности и памяти.

Обязательный способ запуска — Docker + Compose; состояние хранится в постоянных volumes.

Продуктовый ориентир — Dots: один постоянный персонаж в разных каналах, работа между разговорами, длительные обязанности и самостоятельное пробуждение.

## Начало разработки

Инструкции запуска и проверки: [development](docs/development.md). Состояние ревью и ограничения: [final review](docs/final-review.md).

## Документация

- [Требования и границы](docs/requirements.md)
- [Постоянные агенты по образцу Dots](docs/persistent-agents.md)
- [Архитектура](docs/architecture.md)
- [Общий MCP-шлюз](docs/mcp-gateway.md)
- [Запуск в Docker](docs/docker.md)
- [Стек первой версии](docs/technology-stack.md)
- [Автоматический голос через Loopback](docs/audio-worker.md)
- [Голос Minecraft: Simple Voice Chat](docs/integrations/minecraft-voice.md)
- [Интеграция Minecraft](docs/integrations/minecraft.md)
- [Интеграция Telegram](docs/integrations/telegram.md)
- [Движки Pi Agent и Codex](docs/engines.md)
- [Персонажи и адаптация](docs/characters.md)
- [Память и контекст](docs/memory-context.md)
- [Создание навыков и инструментов](docs/capability-workshop.md)
- [Оценка и улучшение](docs/evaluation.md)
- [Продуктовые эпики](docs/product-plan.md)
- [Независимое ревью Astra](docs/astra-review.md)
- [Варианты реализации](docs/implementation-options.md)
- [Варианты памяти](docs/memory-options.md)
- [План реализации](docs/roadmap.md)
- [Архитектурные решения](docs/decisions/0001-character-runtime.md)
- [Журнал работы](docs/journal.md)

## Работа с проектом

Обсуждения, принятые решения и открытые вопросы фиксируются в документации. Предложения отделяются от подтверждённых требований. При изменении архитектуры обновляются соответствующие документы и журнал; существенные решения оформляются отдельным ADR в `docs/decisions/`.
