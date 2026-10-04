# syntax=docker/dockerfile:1

# --- web UI ------------------------------------------------------------------
FROM node:22-alpine AS ui
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- server ------------------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt

COPY backend/app ./app
COPY --from=ui /src/dist ./static

# uid 1000 matches the usual first user on the host, so bind-mounted folders
# stay writable by both.
RUN useradd --uid 1000 --user-group --no-create-home --home-dir /app tgdrive \
    && mkdir -p /data /cache \
    && chown tgdrive:tgdrive /data /cache
USER tgdrive

ENV TGDRIVE_DB=/data/tgdrive.db \
    TGDRIVE_CACHE_DIR=/cache \
    TGDRIVE_STATIC_DIR=/app/static
VOLUME ["/data", "/cache"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]

# Exactly one worker: the unlocked keys, sessions and the SQLite connection
# all live in this one process.
CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header"]
