#!/usr/bin/env python3
"""Run Wav2Lip's inference.py with face detection forced onto the CPU.

Why: on AMD ROCm (gfx1151 / Strix Halo and similar) the s3fd face detector,
when run on the GPU, leaves MIOpen in a state that makes the *first* Wav2Lip
convolution take ~150 s instead of ~0.3 s, and every subsequent run pays it
again because the MIOpen kernel DB is not populated. Running face detection on
the CPU (only ~0.8 s for a static portrait) keeps the GPU generation path fast:
a full 294 s module drops from hours to well under a minute.

Usage is identical to Wav2Lip's inference.py. WAV2LIP_DIR selects the checkout
(if unset, the directory containing this script is used, which only works when
the launcher is placed inside the Wav2Lip checkout).
"""

from __future__ import annotations

import os
import runpy
import sys

wav2lip_dir = os.environ.get("WAV2LIP_DIR") or os.path.dirname(os.path.abspath(__file__))
wav2lip_dir = os.path.abspath(wav2lip_dir)
inference_py = os.path.join(wav2lip_dir, "inference.py")

if not os.path.isfile(inference_py):
    sys.stderr.write(
        "Wav2Lip inference.py not found at %s (set WAV2LIP_DIR)\n" % inference_py
    )
    sys.exit(3)

sys.path.insert(0, wav2lip_dir)

import face_detection  # noqa: E402

_original_face_alignment = face_detection.FaceAlignment


def _face_alignment_on_cpu(*args, **kwargs):
    kwargs["device"] = "cpu"
    return _original_face_alignment(*args, **kwargs)


face_detection.FaceAlignment = _face_alignment_on_cpu

sys.argv = [inference_py] + sys.argv[1:]
runpy.run_path(inference_py, run_name="__main__")
