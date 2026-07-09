# Self-hosted Inference Backend

Self-hosted inference means the user runs the Benzaiten FastAPI backend on their
own machine, then points the existing frontend at that backend URL. It does not
run model inference inside the browser.

## Start the backend

From the repository root:

```bash
bash backend/scripts/local-hosted/run_self_hosted_backend.sh
```

The script starts FastAPI with `ENABLE_SELF_HOSTED_INFERENCE=true` and defaults
to `http://127.0.0.1:8000`.

Useful overrides:

```bash
SELF_HOSTED_HOST=0.0.0.0 \
SELF_HOSTED_PORT=8000 \
SELF_HOSTED_ALLOWED_ORIGINS="http://localhost:5173,https://kseto06.github.io" \
bash backend/scripts/local-hosted/run_self_hosted_backend.sh
```

## Required environment

- Firebase frontend and backend must use the same Firebase project.
- Google credentials must be available to the backend process through ADC or a
  service account.
- The backend must be able to read/write the configured `GCS_BUCKET`.
- `ffmpeg`, Playwright Chromium, and backend Python dependencies must be
  installed.

Run the checker directly when debugging setup:

```bash
python backend/scripts/local-hosted/check_self_hosted_env.py
```

## Frontend configuration

In the landing page, choose `Self-hosted` for inference mode and enter the
FastAPI base URL, for example:

```text
http://127.0.0.1:8000
```

Cloud inference continues to use `VITE_API_BASE_URL`.
