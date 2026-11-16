"""Transcribe one media file with faster-whisper and write word-timed JSON.

Usage: transcribe.py <input> <output.json> [model_size]
"""
import json
import sys


def transcribe(path, model_size, device, compute_type):
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segments, info = model.transcribe(path, word_timestamps=True, vad_filter=True)
    items = []
    for segment in segments:
        items.append({
            "start": float(segment.start),
            "end": float(segment.end),
            "text": segment.text.strip(),
            "words": [
                {"start": float(w.start), "end": float(w.end), "word": w.word.strip()}
                for w in (segment.words or [])
            ],
        })
    return {
        "language": info.language,
        "duration": float(info.duration),
        "segments": items,
    }


def main():
    source, target = sys.argv[1], sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "base"
    attempts = [("cpu", "int8")]
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            attempts.insert(0, ("cuda", "float16"))
    except Exception:
        pass
    last = None
    for device, compute_type in attempts:
        try:
            result = transcribe(source, model_size, device, compute_type)
            break
        except Exception as error:  # fall back to the next device
            last = error
    else:
        raise SystemExit("transcription failed: %s" % last)
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
