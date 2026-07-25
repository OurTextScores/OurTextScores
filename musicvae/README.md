# Multitrack MusicVAE service

Self-hosted CPU microservice wrapping Magenta's **Multitrack MusicVAE**
(`hier-multiperf_vel_1bar_med` / `hier-multiperf_vel_1bar_med_chords`), served as a plain
**FastAPI** JSON API. Used by the score editor's `music.multitrack_vae` specialist —
`score_editor_api` calls it over the internal Docker network.

- **CPU only** (no GPU). `python:3.8-slim` + magenta 2.1.4 + FastAPI/uvicorn.
- First request downloads ~1 GB of checkpoints from GCS once, then caches them
  (`MUSIC_MULTITRACK_VAE_CKPT_DIR`, default `/data/checkpoints` → named volume).
- ~2–4 GB RAM (TF1 + model); `mem_limit` in compose caps it.

## API
- `POST /multitrack_vae` — body: `{mode, model, chord, chords, temperature, num_bars,
  num_samples, seed, index, index_1, index_2, input_midi_base64}` →
  `{midi_base64, metadata}` (or `400 {detail}` for bad input).
  Modes: `sample | chord_progression | style_interpolation | reconstruct | encode_interpolation`.
- `GET /health` → `{ok, models_loaded}`.

## Dev
Defined in the repo `docker-compose.yml` as service `musicvae` (`build: ./musicvae`, on
`appnet`). `score_editor_api` reaches it via `MUSIC_MULTITRACK_VAE_SERVICE_URL:
http://musicvae:7860`.

```bash
docker compose up -d musicvae        # first run builds (~10 min: TF/magenta)
docker compose up -d --force-recreate score_editor_api
```

## Prod (hand-maintained VPS compose — see OTS_Web docs/BUILD_EMBED.md)
The prod compose is not synced from git and does not build from source. Instead:
1. CI publishes the image to GHCR on a `musicvae-v*` tag or manual dispatch
   (`.github/workflows/publish-musicvae-image.yml`) → `ghcr.io/ourtextscores/musicvae`.
2. Add a `musicvae` service to the prod compose referencing that image (not `build:`),
   on the **same** app network `score_editor_api` is on (verify with `docker inspect`; the
   default project network won't be shared — put both on `appnet`), with the checkpoint
   volume mounted at `/data/checkpoints`.
3. Set `MUSIC_MULTITRACK_VAE_SERVICE_URL: http://musicvae:7860` on prod `score_editor_api`
   (add to its `environment:` — a bare `.env` entry only works if the service has
   `env_file`), then recreate it so the var loads.
4. `docker compose pull musicvae && docker compose up -d musicvae score_editor_api`.

**Volume ownership.** The container runs as uid 1000. A **named volume** provisioned from
this image inherits uid-1000 ownership (Dockerfile pre-creates `/data/checkpoints`). A
**bind mount** (`./volumes/musicvae_checkpoints:/data/checkpoints`) is created root-owned by
Docker and the process can't write the GCS checkpoint download → `EACCES` HTTP 500 on the
first call. Fix once on the host: `sudo chown -R 1000:1000 <bind-mount-path>` (or, for any
mount type, `docker exec -u 0 ourtextscores_musicvae chown -R 1000:1000 /data/checkpoints`).
