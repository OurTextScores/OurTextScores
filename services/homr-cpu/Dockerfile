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

RUN python -m pip install --no-cache-dir "poetry==${POETRY_VERSION}" && \
    cd /opt/homr && \
    poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction && \
    python -m pip install --no-cache-dir \
      "fastapi==0.116.1" \
      "httpx==0.28.1" \
      "python-multipart==0.0.20" \
      "uvicorn==0.35.0"

# Bake the pinned CPU models into the image so readiness never depends on a
# download at container start.
RUN cd /opt/homr && homr --init --gpu no

WORKDIR /app
COPY homr-provider/homr_engine.py /app/homr_engine.py
COPY homr-provider/homr_provider.py /app/homr_provider.py
COPY homr-provider/test_homr_provider.py /app/test_homr_provider.py
COPY homr-provider/LICENSE-NOTICE.md /app/LICENSE-NOTICE.md
COPY homr-cpu/app.py /app/app.py

RUN useradd --create-home --uid 10001 homr && chown -R homr:homr /app
USER homr

EXPOSE 8000
# Readiness, not liveness: the worker must not be pointed at a container whose
# models have not loaded and whose warm-up inference has not succeeded.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=4 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/readyz', timeout=3)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
