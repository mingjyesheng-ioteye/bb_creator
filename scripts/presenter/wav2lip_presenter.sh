#!/usr/bin/env bash
#
# Wav2Lip talking-head presenter for the OpenCreator course-video presenter stage.
#
#   wav2lip_presenter.sh <portrait> <audio> <out>
#
# The presenter stage calls a command template with {portrait} {audio} {out}
# substituted. Point OpenCreator at this script:
#
#   OPENCREATOR_PRESENTER_CMD="/path/to/scripts/presenter/wav2lip_presenter.sh {portrait} {audio} {out}"
#   OPENCREATOR_PRESENTER_PORTRAIT=/path/to/instructor.png
#
# Environment:
#   WAV2LIP_DIR      Wav2Lip checkout (default: ./third_party/Wav2Lip)
#   WAV2LIP_CKPT     checkpoint (default: $WAV2LIP_DIR/checkpoints/wav2lip_gan.pth)
#   WAV2LIP_PY       python interpreter with the Wav2Lip dependencies
#   WAV2LIP_RESIZE   face resize_factor, 1 (quality) or 2 (faster)   (default: 1)
set -euo pipefail

WAV2LIP_DIR="${WAV2LIP_DIR:-$(pwd)/third_party/Wav2Lip}"
WAV2LIP_CKPT="${WAV2LIP_CKPT:-$WAV2LIP_DIR/checkpoints/wav2lip_gan.pth}"
WAV2LIP_PY="${WAV2LIP_PY:-python3}"
WAV2LIP_RESIZE="${WAV2LIP_RESIZE:-1}"

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <portrait> <audio> <out>" >&2
  exit 2
fi

PORTRAIT="$(realpath "$1")"
AUDIO="$(realpath "$2")"
OUT="$(realpath -m "$3")"

if [ ! -d "$WAV2LIP_DIR" ]; then
  echo "Wav2Lip checkout not found at $WAV2LIP_DIR (set WAV2LIP_DIR)" >&2
  exit 3
fi
if [ ! -f "$WAV2LIP_CKPT" ]; then
  echo "Wav2Lip checkpoint not found at $WAV2LIP_CKPT (set WAV2LIP_CKPT)" >&2
  exit 3
fi

# Wav2Lip resolves ./checkpoints and ./face_detection relative to its repo dir.
cd "$WAV2LIP_DIR"
"$WAV2LIP_PY" inference.py \
  --checkpoint_path "$WAV2LIP_CKPT" \
  --face "$PORTRAIT" \
  --audio "$AUDIO" \
  --outfile "$OUT" \
  --static 1 \
  --resize_factor "$WAV2LIP_RESIZE" >&2
