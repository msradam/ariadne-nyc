#!/usr/bin/env bash
# Fetch the Granite 4.0 1B MLC model weights from HuggingFace into ./models/granite-1b/.
# The model runs in the browser via WebGPU. This clone serves it locally during
# development so dev never round-trips to HF after first setup.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$REPO_ROOT/models/granite-1b"
HF_URL="https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC"

if ! command -v git-lfs >/dev/null 2>&1; then
  echo "error: git-lfs is required. Install with: brew install git-lfs" >&2
  exit 1
fi

git lfs install --skip-repo

if [ -d "$MODEL_DIR/.git" ]; then
  echo "Model dir exists at $MODEL_DIR - pulling latest..."
  git -C "$MODEL_DIR" pull
else
  echo "Cloning Granite 4.0 1B (~900 MB) into $MODEL_DIR..."
  rm -rf "$MODEL_DIR"
  mkdir -p "$(dirname "$MODEL_DIR")"
  git clone "$HF_URL" "$MODEL_DIR"
fi

echo
echo "Done. Model ready at $MODEL_DIR"
ls -lh "$MODEL_DIR" | head -20
