# Character Harness

Харнес для автономных персонажей, которые действуют в Minecraft, Telegram и других средах, сохраняют память и расширяют свои возможности.

Статус 2026-10-04: Docker core/MCP/PostgreSQL и native audio worker проверены; Codex изолированно вошёл через ChatGPT подписку; authenticated `model/list` подтвердил закреплённую `gpt-6-luna`; синтетическое событие прошло Codex→reply→completed speech job. Client-only Fabric bridge собран и добавлен в отдельный Prism test instance. Для игровых сообщений через SYSTEM/GAME предусмотрен отдельный opt-in adapter только для `mc.agicraft.ru:25565` и `demo-public`; никнейм сохраняется как недоверенная личность. Живое адресованное сообщение игрока доставлено bridge в core и принято как `minecraft_system_chat` для `demo-public`; полный цикл от живого сообщения до озвученного ответа не завершён, потому что лимит подписки ChatGPT был исчерпан. Server addon не нужен.

Главная цель MVP — социальный вау-эффект для участников Minecraft-сервера и Telegram: узнаваемый персонаж с памятью, характером и уместной инициативой.

## Основная идея

Личность определяет поведение, харнес обеспечивает исполнение, мастерская расширяет возможности. Одно ядро запускает разные пакеты персонажей; каждый экземпляр имеет собственную историю, цели и память.

Движок исполнения: Pi Agent или Codex через заменяемый адаптер. Выбор движка отделён от личности и памяти.

Обязательный способ запуска — Docker + Compose; состояние хранится в постоянных volumes.

Продуктовый ориентир — Dots: один постоянный персонаж в разных каналах, работа между разговорами, длительные обязанности и самостоятельное пробуждение.

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
- [Голос Minecraft: Simple Voice Chat](docs/integrations/minecraft-voice.md)
- [Интеграция Minecraft](docs/integrations/minecraft.md)
- [Интеграция Telegram](docs/integrations/telegram.md)
- [Движки Pi Agent и Codex](docs/engines.md)
- [Codex runtime и вход через подписку](docs/codex-engine.md)
- [Fabric client bridge](client-bridge/README.md)
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
- [Архитектурные решения](docs/decisions/0001-character-runtime.md)
- [Журнал работы](docs/journal.md)

## Работа с проектом

Обсуждения, принятые решения и открытые вопросы фиксируются в документации. Предложения отделяются от подтверждённых требований. При изменении архитектуры обновляются соответствующие документы и журнал; существенные решения оформляются отдельным ADR в `docs/decisions/`.
