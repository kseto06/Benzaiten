from backend.scripts.run_inference_job import run_source_separation_job
from backend.scripts.orchestration_jobs.stage_runner import run_stage_with_status

if __name__ == "__main__":
    result = run_stage_with_status("source-separation", run_source_separation_job)
    print(result)
