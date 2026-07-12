from backend.scripts.run_inference_job import run_build_video_job
from backend.scripts.orchestration_jobs.stage_runner import run_stage_with_status

if __name__ == "__main__":
    result = run_stage_with_status("build-video", run_build_video_job)
    print(result)
