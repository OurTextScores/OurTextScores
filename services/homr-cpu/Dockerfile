# syntax=docker/dockerfile:1
#
# Build context is ./services so the shared homr-provider package can be copied
# in alongside this provider's thin entry point.

FROM python:3.12-slim-bookworm

ARG HOMR_COMMIT=1ddc6fcc26c4baa746eaffbba7f5e01429063465
ARG POETRY_VERSION=2.3.2

ENV DEBIAN_FRONTEND=noninteractive \
    HOMR_COMMIT=${HOMR_COMMIT} \
    HOMR_SERVICE_REVISION=ots-homr-cpu-v1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      libgl1 \
      libglib2.0-0 \
      libgomp1 && \
    rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/liebharc/homr.git /opt/homr && \
    cd /opt/homr && \
    git checkout --detach "${HOMR_COMMIT}" && \
    test "$(git rev-parse HEAD)" = "${HOMR_COMMIT}"

# Lifts the HOMR-pinned packages that carry known HIGH advisories, with the same
# hash verification. Copied before the install so it layers with it.
COPY homr-provider/security-overrides.txt /tmp/security-overrides.txt

# Resolve dependencies from HOMR's committed poetry.lock, but install them with
# pip under --require-hashes rather than `poetry install`. Two reasons: it
# verifies every artifact against the lockfile hashes (design section 9.5), and
# it keeps poetry's environment introspection out of the install, which breaks
# on interpreters whose bundled pip records a build-time wheel path.
RUN python -m pip install --no-cache-dir \
      "poetry==${POETRY_VERSION}" "poetry-plugin-export==1.9.0" && \
    cd /opt/homr && \
    poetry export --only main -f requirements.txt -o /tmp/homr-requirements.txt && \
    python -m pip install --no-cache-dir --require-hashes -r /tmp/homr-requirements.txt && \
    python -m pip install --no-cache-dir --require-hashes -r /tmp/security-overrides.txt && \
    python -m pip install --no-cache-dir --no-deps /opt/homr && \
    python -m pip uninstall -y poetry poetry-plugin-export && \
    rm -f /tmp/homr-requirements.txt /tmp/security-overrides.txt && \
    python -m pip install --no-cache-dir \
      "fastapi==0.116.1" \
      "httpx==0.28.1" \
      "python-multipart==0.0.30" \
      "uvicorn==0.35.0"

# Bake the pinned CPU models into the image so readiness never depends on a
# download at container start.
RUN cd /opt/homr && homr --init --gpu no

WORKDIR /app
COPY homr-provider/homr_engine.py /app/homr_engine.py
COPY homr-provider/homr_provider.py /app/homr_provider.py
COPY homr-provider/test_homr_provider.py /app/test_homr_provider.py
COPY homr-provider/warmup-page.png /app/warmup-page.png
COPY homr-provider/warmup-page.musicxml /app/warmup-page.musicxml
COPY homr-provider/LICENSE-NOTICE.md /app/LICENSE-NOTICE.md
COPY homr-cpu/app.py /app/app.py

RUN useradd --create-home --uid 10001 homr && chown -R homr:homr /app
USER homr

# RapidOCR caches its weights outside the HOMR package, so populate that cache
# as the runtime user while the filesystem is still writable. Optional: title
# detection is opt-in per page and the engine treats a missing OCR cache as a
# warning rather than a readiness failure.
RUN python -c "from homr.title_detection import download_ocr_weights; download_ocr_weights()" || \
      echo "OCR pre-warm skipped; title detection will initialise on first use"

EXPOSE 8000
# Readiness, not liveness: the worker must not be pointed at a container whose
# models have not loaded and whose warm-up inference has not succeeded.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=4 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/readyz', timeout=3)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
