#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

echo "[1/4] Pulling latest code..."
git pull origin main

echo "[2/4] Stopping old containers..."
docker-compose down

echo "[3/4] Building and starting services..."
docker-compose up -d --build

echo "[4/4] Done. Service should be available on port 3000."
docker-compose ps
