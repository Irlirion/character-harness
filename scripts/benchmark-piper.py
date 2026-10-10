"""Compare local Irina synthesis on ONNX CPU and Core ML CPU+GPU.

Install piper-tts in a separate venv; pass --model and --output-dir.
Timing includes phonemization and PCM conversion, but excludes WAV disk I/O.
Profiling is a separate pass so it does not distort timed measurements.
"""
import argparse
from collections import Counter
import importlib.metadata
import json
from pathlib import Path
import platform
import statistics
import time
import wave

import onnxruntime as ort
from piper import PiperVoice
from piper.config import PiperConfig

TEXTS = [
    "Привет, я Лада.",
    "Пропавшую кирку пока считаем аномалией. Но в сундуке всё-таки проверь.",
    "Я бы выбрала дом, из которого не хочется уходить. Большое окно, крыльцо, место для гостей. Ценник к фасаду прикручивать необязательно.",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--backend", choices=["cpu", "coreml"], required=True)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--static-only", action="store_true")
    parser.add_argument("--coreml-format", choices=["MLProgram", "NeuralNetwork"], default="MLProgram")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    available = ort.get_available_providers()
    if args.backend == "coreml" and "CoreMLExecutionProvider" not in available:
        raise RuntimeError(f"Core ML unavailable: {available}")
    providers = ["CPUExecutionProvider"]
    if args.backend == "coreml":
        providers = [("CoreMLExecutionProvider", {
            "ModelFormat": args.coreml_format, "MLComputeUnits": "CPUAndGPU",
            "RequireStaticInputShapes": "1" if args.static_only else "0", "EnableOnSubgraphs": "0",
            "ProfileComputePlan": "1" if args.profile else "0",
            "ModelCacheDirectory": str((args.output_dir / ("coreml-cache-" + args.coreml_format + ("-static" if args.static_only else "-dynamic"))).resolve()),
        }), "CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.enable_profiling = args.profile
    options.profile_file_prefix = str(args.output_dir / args.backend)
    # Use the same ORT threading defaults and optimization settings on both paths.
    started = time.perf_counter()
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=providers)
    config = PiperConfig.from_dict(json.loads(Path(str(args.model) + ".json").read_text()))
    voice = PiperVoice(session=session, config=config)
    load_s = time.perf_counter() - started
    print(json.dumps({"backend": args.backend, "load_s": load_s,
                      "providers": session.get_providers()}), flush=True)

    def synth(text):
        started = time.perf_counter()
        first_s = None
        chunks = []
        for chunk in voice.synthesize(text):
            pcm = chunk.audio_int16_bytes
            if first_s is None:
                first_s = time.perf_counter() - started
            chunks.append(pcm)
        return {"total_s": time.perf_counter() - started, "first_chunk_s": first_s,
                "audio_s": sum(len(c) for c in chunks) / (2 * config.sample_rate)}, chunks

    first, _ = synth(TEXTS[0])
    rows = []
    for index, text in enumerate(TEXTS):
        synth(text)  # Warm up each input length.
        measurements = []
        for repeat in range(args.repeats if not args.profile else 1):
            measurement, chunks = synth(text)
            measurements.append(measurement)
            if repeat == 0:
                with wave.open(str(args.output_dir / f"{args.backend}-{index + 1}.wav"), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(config.sample_rate)
                    wav.writeframes(b"".join(chunks))
        row = {"text": text, "measurements": measurements,
               "median_s": statistics.median(m["total_s"] for m in measurements),
               "median_first_chunk_s": statistics.median(m["first_chunk_s"] for m in measurements),
               "median_rtf": statistics.median(m["total_s"] / m["audio_s"] for m in measurements)}
        rows.append(row)
        print(json.dumps({"backend": args.backend, "index": index, **row}, ensure_ascii=False), flush=True)
    result = {"backend": args.backend, "platform": platform.platform(),
              "versions": {k: importlib.metadata.version(k) for k in ["piper-tts", "onnxruntime", "numpy"]},
              "available_providers": available, "active_providers": session.get_providers(),
              "provider_options": session.get_provider_options(), "load_s": load_s,
              "first_synthesis": first, "rows": rows}
    if args.profile:
        profile_path = session.end_profiling()
        events = json.loads(Path(profile_path).read_text())
        counts = Counter()
        times = Counter()
        for event in events:
            provider = event.get("args", {}).get("provider")
            if provider:
                counts[provider] += 1
                times[provider] += event.get("dur", 0)
        result["profile"] = {"path": profile_path, "node_events": dict(counts), "node_duration_us": dict(times)}
    name = args.backend + ("-profile" if args.profile else "")
    (args.output_dir / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"saved": str(args.output_dir / f"{name}.json"), "profile": result.get("profile")}), flush=True)


if __name__ == "__main__":
    main()
