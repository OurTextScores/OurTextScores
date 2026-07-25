# Multitrack MusicVAE — Hugging Face Docker Space (CPU).
# Python 3.8 (NOT 3.10): magenta 2.1.4 hard-pins numba==0.49.1 / llvmlite==0.32.1,
# which have prebuilt wheels only up to cp38. On 3.10 pip tries to COMPILE them and
# fails (numba/llvmlite setup.py break on modern setuptools). 3.8 is magenta's native
# environment and installs those as wheels. This also forces gradio to the 4.x line
# (gradio 5+ requires 3.10+), which is fine for the @gradio/client integration.
FROM python:3.8-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GRADIO_SERVER_NAME=0.0.0.0 \
    GRADIO_SERVER_PORT=7860 \
    HF_HOME=/tmp/hf \
    XDG_CACHE_HOME=/tmp/cache \
    MPLCONFIGDIR=/tmp/mpl

# System libs: libsndfile/ffmpeg for note-seq/librosa; libasound2-dev + libjack-jackd2-dev
# for python-rtmidi (magenta dep) which compiles ALSA+JACK backends (<alsa/asoundlib.h>,
# <jack/jack.h>); build-essential for wheels.
# `git` is required because HF Spaces injects a `git config` step after the Dockerfile
# (python:*-slim has no git → build fails with exit 127 "git: not found").
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libsndfile1 libasound2-dev libjack-jackd2-dev ffmpeg git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# HF Spaces run as uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY --chown=user app.py .

EXPOSE 7860
CMD ["python", "app.py"]
