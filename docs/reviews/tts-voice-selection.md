# Локальный русский TTS для Севера

Дата проверки: 2026-10-04. Машина: Apple Silicon arm64, macOS 27.0.1, 16 GiB RAM. Проверка выполнялась в отдельном каталоге `/Users/irlirion/Library/Caches/character-harness/tts-evaluation`; игровые аудиоустройства и Loopback не использовались.

## Вывод

Для небольших русских реплик подходящий открытый вариант — Piper с голосом **Dmitri medium**. Он синтезировал эти тестовые фразы на CPU быстрее реального времени примерно в 24 раза после загрузки модели и занимал около 201 MB RSS. Пакет Piper и ONNX Runtime подходят для 16 GB Apple Silicon. Имя Дмитрий соответствует выбранному мужскому образу Севера, но пол не указан в карточке модели, а я не могу субъективно оценить тембр/естественность слухом. Поэтому образцы приложены для человеческого прослушивания; выбор Дмитрия подтверждён пользователем.

Сейчас native Mac `say` уже доступен с голосом Milena и подтверждён как слышимый в существующем pipeline. В этой системе среди русских голосов `say -v '?'` показал только Milena; Yuri не установлен. `say` остаётся простым baseline с меньшим расходом памяти, а Piper добавляет нейронное качество и выбор мужского голоса ценой примерно 200 MB постоянно занятой RAM и GPL-компонента в коде engine.

## Кандидаты

| Кандидат | Русский голос и характер | Ресурсы/совместимость | Лицензия и пригодность |
|---|---|---|---|
| **Piper 1.8.0 + Dmitri medium** | Русский VITS, один голос, medium, 22.05 kHz. Имя Дмитрий предполагает мужской голос, но карточка не задаёт пол или описывает характер. Подходит по persona; интонацию нужно оценить по WAV. | Нативный arm64 Python 3.12 + ONNX Runtime на Mac. Модель 63,201,294 bytes. На этой машине: загрузка 0.714 s; тёплый синтез тестовых реплик 0.091–0.145 s; peak RSS 201,490,432 bytes. | Код текущего OHF-Voice Piper — GPL-3.0-or-later; пакет собирает espeak-ng. Карточка Dmitri указывает CC0 для датасета, но отдельно не задаёт лицензию checkpoint. Верхний уровень HF voice repo помечен MIT, однако нельзя считать запись о датасете отдельной лицензией весов. Локальная оценка и личное использование соответствуют заявленному назначению проекта; перед распространением приложения вместе с runtime или model надо отдельно проверить условия распространения. |
| **Piper 1.8.0 + Denis medium** | Ещё один русскоязычный medium checkpoint, вероятно мужской по имени (пол карточкой не подтверждён). | Такая же модель 63.2 MB; load 0.623 s; тёплый синтез 0.108–0.160 s; peak RSS 200,179,712 bytes. | Карточка также указывает CC0 только для датасета; лицензию весов отдельно не устанавливает. В ASR readback первой строки «Север» распознан как «Сила»; этого недостаточно, чтобы оценить качество на слух. |
| **Piper 1.8.0 + Irina medium** | Женский голос предполагается по имени, но карточка пол не указывает. | Модель 63.2 MB; load 0.563 s; тёплый синтез 0.133–0.209 s; peak RSS 235,307,008 bytes. | Карточка связывает датасет с RHVoice и прямо указывает `License: Unknown`. Не рекомендую для распространения. Это сравнительный образец, не выбор для Севера. |
| **Silero TTS v4_ru** | Официальный русский набор с несколькими голосами (включая мужские и женские), автоматической расстановкой ударений и SSML. Сильный кандидат на качество/варианты характера. | Русская v4 поставляется как PyTorch package; официальный пример включает CPU-режим. PyTorch даёт более тяжёлую среду, чем Piper + ONNX Runtime. Не загружал её в пределах текущего лимита загрузок и не бенчмаркировал. | README репозитория помечен CC BY-NC 4.0; это ограничивает несогласованное коммерческое использование и распространение производных. Лицензию кода и весов следует подтвердить отдельно для конкретной поставки. Не мой выбор для проекта, который хочется свободно распространять. |
| **RHVoice** | Русский параметрический синтез, голоса компактны и разборчивы, но сам upstream отмечает меньшую естественность по сравнению с системами, комбинирующими фрагменты записей. | Небольшой footprint — сильная сторона. Upstream заявляет поддержку Windows, GNU/Linux и Android, но не macOS; локально не собирал. | Engine — GPL-2.0. Голоса и языковые данные лицензируются отдельно; issue проекта перечисляет российские данные без явной лицензии. Распространение конкретного русского голоса надо проверять отдельно. |
| **macOS `say` / Milena** | Уже установлен русский голос Milena; бот сейчас использует его. Доступный голос здесь звучит как русская женская персона по имени, но акустический характер в этом исследовании субъективно не оценивал. | Уже встроен в текущий native worker. Три вызова синтеза WAV 48 kHz заняли 1.32–1.50 s каждый, peak RSS около 32 MB; при этом это отдельные запуски `say`, как в текущем worker. | Закрытая часть macOS; удобный надёжный baseline без дополнительной установки, но нельзя перенести в независимую сборку проекта. |

Heavy/неподходящие модели не загружал. Выбирал кандидатов с официально заявленной поддержкой русского и небольшим локальным runtime. Kokoro и семейства XTTS/F5 не включал в рейтинг без проверенного официального русского pretrained voice для этого сценария.

## Измерения

Piper: `piper-tts==1.8.0`, Python 3.12.7 arm64, `onnxruntime==1.30.0`, warm-up перед замером, затем три независимых синтеза в одном загруженном процессе. В каждой строке `время аудио / время синтеза` даёт RTF. Чем RTF меньше 1, тем быстрее генерация, чем длительность воспроизведения. Peak RSS включает Python, ONNX Runtime и голосовую модель.

| Голос | Загрузка модели | Строка 1 | Строка 2 | Строка 3 | Peak RSS |
|---|---:|---:|---:|---:|---:|
| Dmitri medium | 0.714 s | 2.032 s аудио / 0.091 s (RTF 0.045) | 3.506 / 0.138 (0.039) | 3.529 / 0.145 (0.041) | 201 MB |
| Denis medium | 0.623 s | 2.566 / 0.108 (0.042) | 4.505 / 0.160 (0.036) | 4.180 / 0.160 (0.038) | 200 MB |
| Irina medium | 0.563 s | 3.332 / 0.133 (0.040) | 4.969 / 0.175 (0.035) | 5.979 / 0.209 (0.035) | 235 MB |
| macOS say Milena | — | 2.706 / 1.50 | 4.525 / 1.32 | 4.445 / 1.35 | 32 MB |

Голосовые модели Piper выдают mono PCM16 22.05 kHz. Текущий аудиоплеер принимает 48 kHz PCM16, поэтому выбранному голосу нужен ресэмплинг перед Swift воспроизведением. Локальный ffmpeg уже установлен. Если держать Piper загруженным между репликами, warm latency около 0.1 s; CLI с новым процессом на каждую фразу отдельно платит за старт интерпретатора и загрузку модели.

Я выполнил только ограниченный readback check локальным Whisper.cpp `ggml-base` на первой и остальных строках. Он распознал первую фразу Dmitri как «Привет, я Север. Тебя видит», у Denis — «Привет, я Сила! Рад тебя видеть», у Irina — точно, у Milena — с отличающейся пунктуацией. В третьей строке ASR сделал ошибки для всех голосов, включая Milena. Whisper base — грубая проверка написанного текста, не объективная оценка артикуляции и тембра. Я не прослушиваю WAV и не заявляю слуховое качество.

## Образцы

Все варианты говорят одинаковые три фразы:

1. «Привет, я Север. Рад тебя видеть.»
2. «У входа в шахту заметил следы. Похоже, кто-то недавно был здесь.»
3. «Если найдёшь железо, маякни. Я пока поищу уголь и вернусь.»

Все Piper WAV — 22.05 kHz mono PCM16. Milena WAV — 48 kHz mono PCM16, уже совпадает с форматом текущего плеера.

| Голос | Образцы |
|---|---|
| Dmitri | [строка 1](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/dmitri/dmitri-1.wav), [строка 2](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/dmitri/dmitri-2.wav), [строка 3](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/dmitri/dmitri-3.wav) |
| Denis | [строка 1](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/denis/denis-1.wav), [строка 2](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/denis/denis-2.wav), [строка 3](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/denis/denis-3.wav) |
| Irina | [строка 1](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/irina/irina-1.wav), [строка 2](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/irina/irina-2.wav), [строка 3](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/piper/samples/irina/irina-3.wav) |
| Milena | [строка 1](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/say/wav/milena-1.wav), [строка 2](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/say/wav/milena-2.wav), [строка 3](/Users/irlirion/Library/Caches/character-harness/tts-evaluation/say/wav/milena-3.wav) |

## Зафиксированные источники

- [Текущие релизы OHF-Voice Piper](https://github.com/OHF-Voice/piper1-gpl/releases) — последний на дату проверки v1.8.0, 4 сентября 2026.
- [Код и лицензия текущего Piper](https://github.com/OHF-Voice/piper1-gpl/blob/main/setup.py) — пакет объявлен GPL-3.0-or-later; код встраивает eSpeak NG. [Миграция с legacy Piper и смена лицензии на GPLv3](https://github.com/OHF-Voice/piper1-gpl/releases/tag/v1.3.0).
- [Официальный список Piper voices](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md) — указывает на карточки моделей и предупреждает проверять лицензию каждого голоса.
- Зафиксированный snapshot [Piper voices c10ece1a](https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/dmitri/medium). Тестовая модель имеет SHA-256 `f073356ebc4bd0f80c5af58df2953a5988bd5bdab1eb38635ce960b071fbefcb`; [карточка Dmitri](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/dmitri/medium/MODEL_CARD) даёт язык, частоту, CC0-лицензию датасета и происхождение от Lessac, но не отдельные условия для checkpoint.
- [Карточка Denis](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/denis/medium/MODEL_CARD) и [карточка Irina](https://huggingface.co/rhasspy/piper-voices/blob/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/irina/medium/MODEL_CARD) — источник лицензирования датасетов для сравнительных образцов.
- [Silero Models README](https://github.com/snakers4/silero-models/blob/master/README.md) — v4_ru, список speakers, CPU-пример и badge CC BY-NC 4.0; [точный текст лицензии](https://github.com/snakers4/silero-models/blob/master/LICENSE).
- [RHVoice upstream](https://github.com/RHVoice/RHVoice) — синтез, заявленные платформы и GPL-2.0 код; [лицензионная проблема голосовых/языковых submodule, включая русский](https://github.com/RHVoice/RHVoice/issues/885).

## Воспроизводимость

Модели теста скачаны из snapshot `c10ece1aade47bb51c153c893d14e5bf8e5b7117`, ветка `ru/ru_RU/dmitri/medium`; checkpoint Dmitri — `ru_RU-dmitri-medium.onnx`, 63,201,294 bytes. Для повторения теста использовались `piper-tts==1.8.0`, Python 3.12.7 arm64 и `onnxruntime==1.30.0`; total downloads для Python runtime и трёх русских моделей остались ниже лимита 500 MB. Файлы образцов и isolated environment лежат в указанном cache, в репозиторий модели/runtime не добавлены.
