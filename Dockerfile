# FROM python:3.11-slim
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN ffmpeg -hide_banner -filters 2>&1 | grep -Eq '(^|[[:space:]])rubberband([[:space:]]|$)' \
    || (echo "Error: ffmpeg needs to include the rubberband audio filter for editor pitch rendering" >&2; exit 1)

COPY requirements.txt ./requirements.txt

RUN python -m pip install --no-cache-dir -r requirements.txt \
        --extra-index-url https://download.pytorch.org/whl/cu124 \
    && python -m pip install --no-cache-dir --force-reinstall --no-deps \
        torchvision==0.21.0 \
        --extra-index-url https://download.pytorch.org/whl/cu124

RUN python -c "from importlib.metadata import version; import playwright, torch, torchaudio, torchvision; print(f'playwright={version(\"playwright\")}, torch={torch.__version__}, torchaudio={torchaudio.__version__}, torchvision={torchvision.__version__}')"

RUN PLAYWRIGHT_BROWSERS_PATH=/app/.cache/ms-playwright \
    python -m playwright install --with-deps chromium

COPY backend ./backend
COPY frontend/src/fonts ./frontend/src/fonts

EXPOSE 8080
CMD ["python", "-m", "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8080"]
