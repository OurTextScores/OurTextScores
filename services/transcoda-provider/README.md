# Shared Transcoda provider

`transcoda_engine.py` keeps one warm Transcoda model in a supervised child
process. A hard timeout kills that process, since an asyncio cancellation cannot
interrupt native PyTorch/CUDA work. A replacement is cold and must pass a real
warm-up inference before `/readyz` succeeds.

`transcoda_provider.py` owns validation, authentication, successful-result
idempotency, readiness waiting, single-flight admission, safe errors, immutable
provenance, capabilities, and the `ots-transcoda-provider.v1` response envelope.
The backend adapter is intentionally not connected to worker orchestration yet.

Contract tests use a fake engine and need no model or GPU:

```bash
python -m unittest test_transcoda_provider -v
```

Run that command in an environment containing FastAPI, httpx, and
python-multipart (the Modal image pins the versions used in production).
