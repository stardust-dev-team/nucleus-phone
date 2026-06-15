# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────────────────────
# nucleus-stt — combined Node + Python STT runtime image (bead nucleus-phone-rgja.6, Stage B3).
#
# CONFIG-ONLY ARTIFACT. This defines the production deploy SHAPE for the separate nucleus-stt
# Render service. Creating the Render service, building, and pointing the main service's
# STT_WS_URL at it are SEPARATE, GATED steps (see DEPLOY.md) — this Dockerfile does not create
# or deploy anything by existing.
#
# Copy-forked from aunshin-phone/Dockerfile, STRIPPED of aunshin's health-data hardening:
#   - NO Landlock/no-disk jail wrapper (jail_worker.sh / *_REQUIRE_JAIL). nucleus-phone is a
#     lower compliance bar — the worker still decodes audio in-memory only (invariant carried in
#     the forked worker), but it spawns the venv python DIRECTLY.
#   - NO Anthropic ZDR / AWS KMS / isolated-Postgres gates. nucleus-stt does no LLM egress; it
#     only POSTs finalized transcript chunks back to the main service over a bearer.
#
# Bakes the LIVE engine model only (moonshine/base) so the first call pays no cold download.
# The BATCH/post-call whisper.cpp path is a plan NON-GOAL for this epic (its dep is installed
# from requirements-runtime.txt but its ggml model is NOT baked — left to download if ever used).
#
# The Python interpreter is managed by uv (reproducible python-build-standalone 3.13 — Debian
# bookworm only ships 3.11, and 3.14 drops audioop which the μ-law path needs absent; mulaw.py
# handles μ-law in-repo regardless).
# ─────────────────────────────────────────────────────────────────────────────────────────────

# ===== Stage 1: build the Python 3.13 STT venv + bake the LIVE model =========================
FROM node:22-bookworm-slim AS stt-build

# uv (pinned) — manages the Python toolchain + installs the wheels reproducibly.
COPY --from=ghcr.io/astral-sh/uv:0.11.19 /uv /usr/local/bin/uv

# Build toolchain: pywhispercpp may have no x86_64 manylinux wheel and build whisper.cpp from
# source (cmake). git/curl for any source pulls. Left out of the final stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy
RUN uv python install 3.13

# Create the venv AT its final runtime path (/app/worker/.venv) so it is not relocated between
# stages, then install the PRODUCTION subset (no bake-off/eval deps).
COPY worker/requirements-runtime.txt /tmp/requirements-runtime.txt
RUN uv venv --python 3.13 /app/worker/.venv \
    && VIRTUAL_ENV=/app/worker/.venv uv pip install -r /tmp/requirements-runtime.txt

# Bake the LIVE moonshine/base ONNX weights + tokenizer into a stable, read-at-runtime HF cache
# so there is no first-call download (and HF_HUB_OFFLINE can be enforced at runtime).
ENV HF_HOME=/opt/stt-assets/hf
RUN mkdir -p /opt/stt-assets/hf \
    && /app/worker/.venv/bin/python - <<'PY'
from moonshine_onnx import MoonshineOnnxModel, load_tokenizer
MoonshineOnnxModel(model_name="moonshine/base")
load_tokenizer()
print("moonshine/base baked")
PY

# ===== Stage 2: Node app deps =================================================================
FROM node:22-bookworm-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime runs TypeScript directly via tsx (no emit step), so dev deps are needed — npm ci.
RUN npm ci

# ===== Stage 3: final runtime image ==========================================================
FROM node:22-bookworm-slim AS runtime

# libgomp1: onnxruntime OpenMP runtime. No build toolchain in the final image.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --uid 10001 nucleus

# Baked Python runtime + venv + models (owned by root, world-readable, NOT writable by `nucleus`).
COPY --from=stt-build /opt/uv-python /opt/uv-python
COPY --from=stt-build /app/worker/.venv /app/worker/.venv
COPY --from=stt-build /opt/stt-assets /opt/stt-assets

WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY worker ./worker

# STT spawn wiring (consumed by liveSttConfigFromEnv → MoonshineWorkerBinding). Direct python —
# no jail wrapper (aunshin's Landlock seal is intentionally NOT carried; see header). HF_HUB_OFFLINE
# forces the baked weights so a missing network can't wedge the first decode.
ENV NUCLEUS_STT_PYTHON=/app/worker/.venv/bin/python \
    NUCLEUS_STT_WORKER=/app/worker/stt_worker.py \
    NUCLEUS_STT_STEP_MS=1250 \
    NUCLEUS_STT_WINDOW_MS=10000 \
    HF_HOME=/opt/stt-assets/hf \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production

USER nucleus

# Composition root (bead nucleus-phone-rgja.5): boots http.Server, serves GET /healthz (the
# render.yaml healthCheckPath) + the Twilio Media Streams WS (/media-stream), and mints the
# per-call moonshine STT adapters. Fails CLOSED at boot (main() throws on a missing
# MAIN_INGEST_URL / STT_INGEST_SECRET) so a half-wired image crashes rather than runs unauthed.
CMD ["node", "--import", "tsx", "src/media-stream-server.ts"]
