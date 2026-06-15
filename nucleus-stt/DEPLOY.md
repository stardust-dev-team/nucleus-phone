# Deploying nucleus-stt (Stage B3 / bead nucleus-phone-rgja.6)

The self-hosted Twilio Media Streams → STT service for nucleus-phone. It runs its OWN Render
service (Docker), separate from the main `nucleus-phone` web service, because spawning CPU/mem-heavy
Python STT workers inside the main Starter web service would starve the API the dialer depends on.

**Status: PREPARE-ONLY.** The Dockerfile + `render.yaml` define the deploy shape; the Render
service is **not yet created** (paid compute — a gated step). Nothing here ships until you
create the service AND set `STT_WS_URL` on the main service (until then the main service emits no
`<Stream>`, so this image is never contacted).

## What this service does

Per Twilio Media Streams connection: reads `conference_name` off the `start` frame, runs two
per-track moonshine workers (agent + customer), and POSTs each finalized chunk + an end-of-call
`finalize` to the main service's `/api/stt-ingest` (bearer-authed). See `src/media-stream-server.ts`.

## Prerequisites

- Image build is validated in CI on every push touching `nucleus-stt/**` by
  `.github/workflows/build-stt.yml` (`docker build` on an amd64 `ubuntu-latest` runner — the
  Render target arch; a local build on an arm64 Mac would verify the wrong target). **VERIFIED
  green 2026-06-15** (run 27578788259): the moonshine/base ONNX model bakes (`moonshine/base
  baked`) and `pywhispercpp==1.5.0` resolves to a prebuilt amd64 wheel — no whisper.cpp source
  compile occurs, so the build is fast (~40s). To validate locally instead, run `docker build -t
  nucleus-stt nucleus-stt/` from the repo root.
- The main `nucleus-phone` service already deployed (it is the ingest target).

## Create the service (gated — paid compute)

1. Generate a shared secret: `openssl rand -base64 32`.
2. Render dashboard → New → Blueprint (or Web Service from image), pointing at `nucleus-stt/render.yaml`
   (or configure manually: runtime=image, rootDir=`nucleus-stt`, dockerfilePath=`./Dockerfile`,
   healthCheckPath=`/healthz`, plan=Pro Plus, autoDeploy OFF, region oregon).
3. Set the env vars below.

## Environment variables

### On the new `nucleus-stt` service (you set these)

| Var | Value | Notes |
|-----|-------|-------|
| `STT_INGEST_SECRET` | the generated secret | MUST equal the same var on the main service |
| `MAIN_INGEST_URL`   | `https://nucleus-phone.onrender.com` | base URL, no trailing slash; chunks POST to `${MAIN_INGEST_URL}/api/stt-ingest` |
| `PORT`              | `8080` | Render also injects PORT; the server honors it |

### Baked into the image (do NOT set — listed for reference; Dockerfile ENV)

`NUCLEUS_STT_PYTHON=/app/worker/.venv/bin/python` ·
`NUCLEUS_STT_WORKER=/app/worker/stt_worker.py` ·
`NUCLEUS_STT_STEP_MS=1250` (do NOT lower without re-running the Render cadence gate) ·
`NUCLEUS_STT_WINDOW_MS=10000` · `HF_HOME=/opt/stt-assets/hf` · `HF_HUB_OFFLINE=1` ·
`TRANSFORMERS_OFFLINE=1` · `NODE_ENV=production`.

### On the MAIN `nucleus-phone` service (you set these to turn the in-house path on)

| Var | Value | Effect |
|-----|-------|--------|
| `STT_WS_URL` | `wss://<new-nucleus-stt-service>/media-stream` | Makes the main service emit `<Stream>` on outbound + PSTN-inbound TwiML. **Until set, nothing changes in prod.** |
| `STT_INGEST_SECRET` | the SAME secret | Bearer the `/api/stt-ingest` endpoint checks |
| `STT_FALLBACK_TWILIO` | `false` | Drops Twilio RT `<Transcription>` so the in-house path is sole driver. Leave unset (or `true`) during dual-run to keep BOTH live; set `true` again during a nucleus-stt outage to re-add Twilio RT (PREEMPTIVE — affects only calls that START after it's set). |

Per-rep rollout is the `nucleus_phone_users.use_inhouse_stt` flag (default FALSE) — flip a rep to
drive the in-house path for their calls; others keep Twilio RT. Both verbs can be live at once
during validation; exactly one SOURCE feeds each call (the per-call `use_inhouse_stt` gate).

## Health

`GET /healthz` → `200 {"status":"ok","activeCalls":N}`. Wire a Render health check + SMS alert
(existing pattern) before flipping reps in-house — post-flip, a nucleus-stt outage silences the
live transcript for calls in progress (TwiML is fixed per call; mitigation is the preemptive
`STT_FALLBACK_TWILIO` switch, not mid-call recovery).
