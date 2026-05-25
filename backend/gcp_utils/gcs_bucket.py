from pathlib import Path
from google.cloud import storage
from fastapi import UploadFile
from typing import Tuple

def upload_file_to_gcs(local_path: str, bucket_name: str, destination_blob_name: str) -> str:
    '''
    Function to upload a local file to an audio file to google cloud storage (GCS)

    Args:
        local_path: The local path of the file to be uploaded.
        bucket_name: The name of the GCS bucket where the file will be uploaded.
        destination_blob_name: The name of the destination blob in the GCS bucket.
    Returns:
        The public URL of the uploaded file in GCS. (gs://...)
    '''
    local_file = Path(local_path)

    if not local_file.exists():
        return FileNotFoundError(f"file not found: {local_path}")
    
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(destination_blob_name)

    blob.upload_from_filename(str(local_file))

    return f"gs://{bucket_name}/{destination_blob_name}"

def download_file_from_gcs(bucket_name: str, source_blob_name: str, local_path: str) -> Path:
    '''
    Function to download a file from google cloud storage (GCS) to a local path

    Args:
        bucket_name: The name of the GCS bucket where the file is stored.
        source_blob_name: The name of the source blob in the GCS bucket.
        local_path: The local path where the file will be downloaded.
    Returns:
        The local path of the downloaded file.
    '''
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(source_blob_name)

    local_file = Path(local_path)
    local_file.parent.mkdir(parents=True, exist_ok=True)

    blob.download_to_filename(str(local_file))

    return local_file

def remove_file_from_gcs(bucket_name: str, blob_name: str) -> bool:
    '''
    Function to remove a file from google cloud storage (GCS)

    Args:
        bucket_name: The name of the GCS bucket where the file is stored.
        blob_name: The name of the blob to remove from the GCS bucket.
    Returns:
        True if the file was removed successfully.
    '''
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)

    if not blob.exists():
        return False

    blob.delete()
    return True

async def upload_input_file_to_gcs(file: UploadFile, job_id: str) -> Tuple[str, str, str]:
    '''
    Async function to upload an input file from FastAPI endpoint to GCS
    Saves uploaded file to /tmp -> uploads to GCS - > returns GCS path, blob name, original filename

    Args:
        file: The UploadFile object received from the FastAPI endpoint.
        job_id: unique job id for the inference job
    '''
    GCS_BUCKET = "benzaiten-outputs"

    filename = file.filename
    input_dir = Path(f"/tmp/{job_id}")
    input_dir.mkdir(parents=True, exist_ok=True)

    local_input_path = input_dir / filename
    with open(local_input_path, "wb") as f:
        f.write(await file.read())

    destination_blob_name = f"inputs/{job_id}/{filename}"

    input_gcs_path = upload_file_to_gcs(
        local_path=str(local_input_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=destination_blob_name
    )

    return input_gcs_path, destination_blob_name, filename