from fastapi import FastAPI, UploadFile, Form
from fastapi.responses import FileResponse
import os

from ..backend.scripts.process import run_karaoke_inference

app = FastAPI()

@app.get("/")
def root():
    return {"status": "ok", "message": "inference server is running"}

@app.post("/inference")
async def run_inference(file: UploadFile, model_name: str = Form("bs-roformer")):
    input_path = f"/tmp/{file.filename}"

    with open(input_path, "wb") as f:
        f.write(await file.read())

    output_dir = "/tmp/output"
    os.makedirs(output_dir, exist_ok=True)

    run_karaoke_inference(
        model_name=model_name,
        audio_path=input_path,
        output_path=output_dir
    )

    if model_name == "bs-roformer":
        return {
            "model": model_name,
            "vocals": "/download/vocals.mp3",
            "instrumental": "/download/instrumental.mp3"
        }
    elif model_name == "decrowd":
        return {
            "model": model_name,
            "crowd": "/download/crowd.mp3",
            "instrumental_(decrowd)": "/download/instrumental_(decrowd).mp3"
        }