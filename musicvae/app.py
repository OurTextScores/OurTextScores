"""Multitrack MusicVAE Gradio Space.

Wraps Magenta's hierarchical multitrack MusicVAE models behind a single
`/multitrack_vae` endpoint that returns base64-encoded MIDI. Ported from
`Multitrack_MusicVAE.ipynb` (helpers: slerp, chord_encoding, trim_sequences,
fix_instruments_for_concatenation), with audio/SoundFont rendering removed --
OTS_Web handles playback. Both checkpoints are pulled from GCS on first use and
cached; models are lazily loaded per checkpoint.

NOTE: this is a design skeleton. The primary delivery risk is the legacy
TF1/Magenta environment (see the runbook "Dependency Risk"). Treat "both
checkpoints load and one sample runs" as the build acceptance gate.
"""

import base64
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import traceback

import numpy as np
import tensorflow.compat.v1 as tf

import note_seq as mm
from note_seq.sequences_lib import concatenate_sequences
from magenta.models.music_vae import configs
from magenta.models.music_vae.trained_model import TrainedModel

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

tf.disable_v2_behavior()


# Served as a plain FastAPI JSON API (not Gradio) so it runs reliably as a self-hosted
# CPU microservice in the OurTextScores stack. The generation code below still raises
# `gr.Error(...)` for bad input; this shim maps that to an HTTP 400 with a clean detail
# message, so the rest of the file is unchanged.
class _GrError(HTTPException):
    def __init__(self, detail):
        super().__init__(status_code=400, detail=str(detail))


class gr:  # noqa: N801 - shim namespace preserving `gr.Error(...)` call sites
    Error = _GrError


# --- Constants (from the notebook) -----------------------------------------
BATCH_SIZE = 4
Z_SIZE = 512
TOTAL_STEPS = 512
BAR_SECONDS = 2.0
CHORD_DEPTH = 49
MAX_BARS = 64

GCS_MODELS = "gs://download.magenta.tensorflow.org/models/music_vae/multitrack/*"
# Where the ~1 GB checkpoints live. Point this at a mounted volume in production so the
# download survives restarts (see docker-compose.musicvae.yml).
CKPT_DIR = os.environ.get("MUSIC_MULTITRACK_VAE_CKPT_DIR", "/tmp/music_vae")

MODELS = {
    "chords": {
        "config": "hier-multiperf_vel_1bar_med_chords",
        "ckpt": os.path.join(CKPT_DIR, "model_chords_fb64.ckpt"),
    },
    "unconditioned": {
        "config": "hier-multiperf_vel_1bar_med",
        "ckpt": os.path.join(CKPT_DIR, "model_fb256.ckpt"),
    },
}

_load_lock = threading.RLock()  # reentrant: get_model holds it, then calls _ensure_checkpoints() which re-acquires it
_models = {}          # name -> TrainedModel
_checkpoints_ready = False


def _log(message: str) -> None:
    print(f"[multitrack-musicvae] {message}", flush=True)


def _ensure_checkpoints() -> None:
    global _checkpoints_ready
    if _checkpoints_ready:
        return
    with _load_lock:
        if _checkpoints_ready:
            return
        os.makedirs(CKPT_DIR, exist_ok=True)
        # Skip the ~1 GB download if the checkpoints are already present (e.g. after a
        # restart, or when a persistent volume is mounted at CKPT_DIR).
        if not os.path.exists(os.path.join(CKPT_DIR, "model_fb256.ckpt.index")):
            _log("Copying MusicVAE checkpoints from GCS (first call only)...")
            subprocess.run(["gsutil", "-q", "-m", "cp", GCS_MODELS, CKPT_DIR + "/"], check=True)
        else:
            _log("Checkpoints already present; skipping download.")
        _checkpoints_ready = True


def get_model(name: str) -> TrainedModel:
    if name not in MODELS:
        raise gr.Error(f"Unknown model '{name}'. Use 'chords' or 'unconditioned'.")
    if name in _models:
        return _models[name]
    with _load_lock:
        if name in _models:
            return _models[name]
        _ensure_checkpoints()
        spec = MODELS[name]
        started = time.time()
        _log(f"Loading {name} model ({spec['config']})...")
        config = configs.CONFIG_MAP[spec["config"]]
        model = TrainedModel(
            config, batch_size=BATCH_SIZE, checkpoint_dir_or_path=spec["ckpt"]
        )
        if name == "unconditioned":
            model._config.data_converter._max_tensors_per_input = None
        _models[name] = model
        _log(f"Loaded {name} in {time.time() - started:.1f}s")
        return model


# --- Notebook helpers -------------------------------------------------------
def slerp(p0, p1, t):
    """Spherical linear interpolation."""
    omega = np.arccos(
        np.dot(np.squeeze(p0 / np.linalg.norm(p0)), np.squeeze(p1 / np.linalg.norm(p1)))
    )
    so = np.sin(omega)
    return np.sin((1.0 - t) * omega) / so * p0 + np.sin(t * omega) / so * p1


def chord_encoding(chord):
    index = mm.TriadChordOneHotEncoding().encode_event(chord)
    c = np.zeros([TOTAL_STEPS, CHORD_DEPTH])
    c[0, 0] = 1.0
    c[1:, index] = 1.0
    return c


def trim_sequences(seqs, num_seconds=BAR_SECONDS):
    for i in range(len(seqs)):
        seqs[i] = mm.extract_subsequence(seqs[i], 0.0, num_seconds)
        seqs[i].total_time = num_seconds


def fix_instruments_for_concatenation(note_sequences):
    instruments = {}
    for i in range(len(note_sequences)):
        for note in note_sequences[i].notes:
            if not note.is_drum:
                if note.program not in instruments:
                    if len(instruments) >= 8:
                        instruments[note.program] = len(instruments) + 2
                    else:
                        instruments[note.program] = len(instruments) + 1
                note.instrument = instruments[note.program]
            else:
                note.instrument = 9


def _parse_chords(chords_csv):
    return [c.strip() for c in (chords_csv or "").split(",") if c.strip()]


def _validate_chords(chords):
    encoder = mm.TriadChordOneHotEncoding()
    for c in chords:
        try:
            encoder.encode_event(c)
        except Exception as exc:  # noqa: BLE001
            raise gr.Error(
                f"Unsupported chord '{c}'. Only triad symbols are supported "
                f"(e.g. C, Cm, Caug, Am, F, G). ({exc})"
            )


def _ns_to_midi_b64(ns) -> str:
    # note_seq.sequence_proto_to_midi_file writes to a file PATH (not a file object).
    fd, path = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    try:
        mm.sequence_proto_to_midi_file(ns, path)
        with open(path, "rb") as fh:
            data = fh.read()
    finally:
        os.remove(path)
    return base64.b64encode(data).decode("ascii")


def _uploaded_measures(model, input_midi_base64):
    if not input_midi_base64:
        raise gr.Error("This mode requires input_midi_base64 (a MIDI upload).")
    raw = base64.b64decode(input_midi_base64)
    seq = mm.midi_to_sequence_proto(raw)
    _, tensors, _, _ = model._config.data_converter.to_tensors(seq)
    measures = model._config.data_converter.from_tensors(tensors)
    if not measures:
        raise gr.Error("Could not extract any measure from the uploaded MIDI.")
    trim_sequences(measures)
    return measures


# --- Modes ------------------------------------------------------------------
def _mode_sample(model, chord, temperature, num_samples):
    c_input = chord_encoding(chord) if chord else None
    n = int(min(max(1, num_samples), BATCH_SIZE))
    seqs = model.sample(
        n=n, length=TOTAL_STEPS, temperature=temperature, c_input=c_input
    )
    trim_sequences(seqs)
    fix_instruments_for_concatenation(seqs)
    return concatenate_sequences(seqs), len(seqs)


def _mode_chord_progression(model, chords, temperature):
    z = np.random.normal(size=[1, Z_SIZE])
    seqs = [
        model.decode(
            length=TOTAL_STEPS, z=z, temperature=temperature, c_input=chord_encoding(c)
        )[0]
        for c in chords
    ]
    trim_sequences(seqs)
    fix_instruments_for_concatenation(seqs)
    return concatenate_sequences(seqs), len(seqs)


def _mode_style_interpolation(model, chords, temperature, num_bars):
    z1 = np.random.normal(size=[Z_SIZE])
    z2 = np.random.normal(size=[Z_SIZE])
    z = np.array([slerp(z1, z2, t) for t in np.linspace(0, 1, num_bars)])
    if chords:  # chord-conditioned interpolation, repeating the progression
        seqs = [
            model.decode(
                length=TOTAL_STEPS,
                z=z[i : i + 1, :],
                temperature=temperature,
                c_input=chord_encoding(chords[i % len(chords)]),
            )[0]
            for i in range(num_bars)
        ]
    else:  # unconditioned interpolation
        seqs = model.decode(length=TOTAL_STEPS, z=z, temperature=temperature)
    trim_sequences(seqs)
    fix_instruments_for_concatenation(seqs)
    return concatenate_sequences(seqs), len(seqs)


def _mode_reconstruct(model, input_midi_base64, index, temperature):
    measures = _uploaded_measures(model, input_midi_base64)
    idx = int(min(max(0, index), len(measures) - 1))
    z, _, _ = model.encode([measures[idx]])
    recon = model.decode(z, length=TOTAL_STEPS, temperature=temperature)[0]
    trim_sequences([recon])
    return recon, 1


def _mode_encode_interpolation(model, input_midi_base64, index_1, index_2, temperature, num_bars):
    measures = _uploaded_measures(model, input_midi_base64)
    i1 = int(min(max(0, index_1), len(measures) - 1))
    i2 = int(min(max(0, index_2), len(measures) - 1))
    z1, _, _ = model.encode([measures[i1]])
    z2, _, _ = model.encode([measures[i2]])
    z = np.array(
        [slerp(np.squeeze(z1), np.squeeze(z2), t) for t in np.linspace(0, 1, num_bars)]
    )
    seqs = model.decode(length=TOTAL_STEPS, z=z, temperature=temperature)
    trim_sequences(seqs)
    fix_instruments_for_concatenation(seqs)
    return concatenate_sequences(seqs), len(seqs)


# --- Core generation --------------------------------------------------------
def multitrack_vae(
    mode,
    model,
    chord,
    chords,
    temperature,
    num_bars,
    num_samples,
    seed,
    index,
    index_1,
    index_2,
    input_midi_base64,
):
    started = time.time()
    warnings = []
    temperature = float(temperature or 0.2)
    num_bars = int(min(max(4, int(num_bars or 32)), MAX_BARS))
    chord_list = _parse_chords(chords)

    # Chord modes require the chord-conditioned checkpoint.
    if mode in ("sample", "chord_progression", "style_interpolation"):
        if mode == "chord_progression" and not chord_list:
            raise gr.Error("chord_progression requires a non-empty 'chords' list.")
        if chord:
            _validate_chords([chord])
        if chord_list:
            _validate_chords(chord_list)
        if (chord or chord_list) and model != "chords":
            warnings.append("Chord conditioning requested; forcing model='chords'.")
            model = "chords"

    # The OTS client sends -1 (or omits) to mean "no seed"; only seed on a valid value.
    if seed is not None and str(seed) != "" and int(seed) >= 0:
        np.random.seed(int(seed))

    tf_model = get_model(model)

    try:
        if mode == "sample":
            ns, num_measures = _mode_sample(tf_model, chord, temperature, int(num_samples or BATCH_SIZE))
        elif mode == "chord_progression":
            ns, num_measures = _mode_chord_progression(tf_model, chord_list, temperature)
        elif mode == "style_interpolation":
            ns, num_measures = _mode_style_interpolation(tf_model, chord_list, temperature, num_bars)
        elif mode == "reconstruct":
            ns, num_measures = _mode_reconstruct(tf_model, input_midi_base64, int(index or 0), temperature)
        elif mode == "encode_interpolation":
            ns, num_measures = _mode_encode_interpolation(
                tf_model, input_midi_base64, int(index_1 or 0), int(index_2 or 1), temperature, num_bars
            )
        else:
            raise gr.Error(f"Unknown mode '{mode}'.")
    except gr.Error:
        raise
    except Exception as exc:  # noqa: BLE001
        raise gr.Error(f"Generation failed: {exc}\n\n{traceback.format_exc()}") from exc

    midi_b64 = _ns_to_midi_b64(ns)
    metadata = {
        "model": model,
        "config": MODELS[model]["config"],
        "mode": mode,
        "temperature": temperature,
        "num_bars": num_bars,
        "num_measures": num_measures,
        "bar_seconds": BAR_SECONDS,
        "total_seconds": round(num_measures * BAR_SECONDS, 3),
        "chords": chord_list or ([chord] if chord else []),
        "seed": None if (seed is None or str(seed) == "") else int(seed),
        "elapsed_ms": int((time.time() - started) * 1000),
        "warnings": warnings,
    }
    return midi_b64, metadata


# --- HTTP API ---------------------------------------------------------------
app = FastAPI(title="Multitrack MusicVAE")


class GenerateRequest(BaseModel):
    mode: str
    model: str = "chords"
    chord: str = ""
    chords: str = ""          # comma-separated triad symbols, e.g. "C, Am, F, G"
    temperature: float = 0.2
    num_bars: int = 32
    num_samples: int = 4
    seed: int = -1            # < 0 (or omitted) means "no seed"
    index: int = 0
    index_1: int = 0
    index_2: int = 0
    input_midi_base64: str = ""


@app.get("/health")
def health():
    return {"ok": True, "models_loaded": sorted(_models.keys())}


@app.post("/multitrack_vae")
def generate(req: GenerateRequest):
    """Generate/interpolate/reconstruct multitrack MIDI; returns base64 MIDI + metadata.

    The heavy blocking work (gsutil checkpoint download, TF inference) runs in FastAPI's
    threadpool because this handler is a sync `def`, so the event loop stays responsive.
    Models are loaded once and cached in-process (see get_model).
    """
    midi_b64, metadata = multitrack_vae(
        req.mode, req.model, req.chord, req.chords, req.temperature,
        req.num_bars, req.num_samples, req.seed, req.index, req.index_1, req.index_2,
        req.input_midi_base64,
    )
    return {"midi_base64": midi_b64, "metadata": metadata}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7860)
