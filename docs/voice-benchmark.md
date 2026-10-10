# Irina: CPU и попытка ускорения Core ML

Исторический замер до перехода на Qwen. Piper больше не используется в рабочем TTS; текущий запуск описан в [audio worker](audio-worker.md). Скрипт ниже сохранён для воспроизведения этого эксперимента.

Замер 2026-10-10 на MacBook Pro с Apple M1 Pro (8 CPU cores, 16 GB), macOS 27.0.1 arm64. Модель `ru_RU-irina-medium`, Piper 1.8.0, Python 3.13.1. Текущий голос приложения не изменён.

## Результат

Полноценный замер Metal/GPU получить не удалось. ONNX Runtime 1.31.0 выдаёт `narrowing_error` при загрузке в формате MLProgram (со статическими и динамическими входами); NeuralNetwork загружается, но процесс падает при синтезе (exit 139).

ONNX Runtime 1.23.2 с динамическими входами компилирует модель, но синтез завершается ошибкой: динамический тензор имеет фактическую форму `{0,3}`, которую Core ML не поддерживает.

Работает Core ML с `RequireStaticInputShapes=1`, `ModelFormat=MLProgram`, `MLComputeUnits=CPUAndGPU`, плюс CPU fallback. Однако отдельный `ProfileComputePlan` показывает выбор CPU для всех операций Core ML; GPU фактически не задействован. Поэтому таблица ниже сравнивает обычный ONNX CPU с работающим смешанным ONNX/Core ML путём, а не CPU с настоящим Metal.

| Реплика | Длина аудио | ONNX CPU | Core ML + CPU fallback | Первый фрагмент: CPU / Core ML |
|---|---:|---:|---:|---:|
| Привет, я Лада. | ~2,1 с | 113 мс | 121 мс | 113 / 121 мс |
| Пропавшую кирку пока считаем аномалией. Но в сундуке всё-таки проверь. | ~4,9 с | 304 мс | 271 мс | 155 / 159 мс |
| Я бы выбрала дом, из которого не хочется уходить. Большое окно, крыльцо, место для гостей. Ценник к фасаду прикручивать необязательно. | ~9,9 с | 504 мс | 571 мс | 180 / 201 мс |

Медианы 15 последовательных повторов после прогрева каждой фразы; обе колонки на ONNX Runtime 1.23.2, с одинаковыми настройками потоков по умолчанию. Замер включает фонемизацию, синтез всех предложений и преобразование в PCM; исключает запись WAV, воспроизведение, сеть и запуск интерпретатора. Продолжительность немного варьируется из-за стохастики модели. Фоновая нагрузка не изолирована; небольшие различия нельзя считать устойчивым преимуществом.

Загрузка ONNX CPU: 0,56 с; первый синтез короткой фразы: 0,17 с. Загрузка Core ML с уже созданным кэшем: 0,67 с; первый синтез: 0,20 с. Первоначальная загрузка с компиляцией Core ML со статическими входами заняла 2,20 с (журнал `coreml-ort123-static.log`).

Для коротких реплик Лады рекомендуется CPU: он уже генерирует аудио примерно в 16–20 раз быстрее воспроизведения, без несовместимости Core ML. Это вывод для конкретной модели Irina и данного пути запуска, не для всех моделей TTS на Apple GPU.

## Воспроизведение

Изолированное окружение замера: `/tmp/lada-piper-bench-venv`. Модель, WAV, JSON и журналы находятся в игнорируемом Git каталоге `work/voice-benchmark/`. Основной результат: `results-ort123-static/{cpu,coreml}.json`. Профиль: `profile-ort123-static/coreml-profile.json`, журнал устройств: `coreml-profile.log`.

```sh
python3 -m venv /tmp/lada-piper-bench-venv
/tmp/lada-piper-bench-venv/bin/pip install piper-tts==1.8.0 onnxruntime==1.23.2
mkdir -p work/voice-benchmark
curl -fL https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx -o work/voice-benchmark/ru_RU-irina-medium.onnx
curl -fL https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx.json -o work/voice-benchmark/ru_RU-irina-medium.onnx.json
/tmp/lada-piper-bench-venv/bin/python scripts/benchmark-piper.py --model work/voice-benchmark/ru_RU-irina-medium.onnx --output-dir work/voice-benchmark/results-ort123-static --backend cpu --repeats 15
/tmp/lada-piper-bench-venv/bin/python scripts/benchmark-piper.py --model work/voice-benchmark/ru_RU-irina-medium.onnx --output-dir work/voice-benchmark/results-ort123-static --backend coreml --static-only --repeats 15
/tmp/lada-piper-bench-venv/bin/python scripts/benchmark-piper.py --model work/voice-benchmark/ru_RU-irina-medium.onnx --output-dir work/voice-benchmark/profile-ort123-static --backend coreml --static-only --profile
```

Источники: [Piper Python API](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/API_PYTHON.md), [настройки Core ML ONNX Runtime](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html).
