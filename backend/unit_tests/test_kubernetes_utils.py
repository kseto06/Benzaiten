import unittest
from types import SimpleNamespace
from unittest import mock

from backend.scripts.benzaiten_inference.k8s import kubernetes_utils


def _job(*, suspend=None, condition_type=None):
    conditions = []
    if condition_type is not None:
        conditions.append(SimpleNamespace(type=condition_type, status="True"))

    return SimpleNamespace(
        spec=SimpleNamespace(suspend=suspend),
        status=SimpleNamespace(conditions=conditions),
    )


def _pipeline_job(
    *,
    suspend=None,
    active=0,
    succeeded=0,
    failed=0,
    condition_type=None,
    kueue_managed=False,
):
    job = _job(suspend=suspend, condition_type=condition_type)
    job.metadata = SimpleNamespace(
        labels={kubernetes_utils.KUEUE_QUEUE_LABEL: "test-queue"}
        if kueue_managed
        else {}
    )
    job.status.active = active
    job.status.succeeded = succeeded
    job.status.failed = failed
    return job


class ClassifyPipelineJobsTests(unittest.TestCase):
    def test_suspended_kueue_job_is_queued_despite_active_orchestrator(self):
        jobs = [
            _pipeline_job(active=1),
            _pipeline_job(suspend=True, kueue_managed=True),
        ]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "queued")

    def test_admitted_kueue_job_is_running_before_pod_becomes_active(self):
        jobs = [_pipeline_job(suspend=False, kueue_managed=True)]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "running")

    def test_mixed_parallel_kueue_jobs_are_running(self):
        jobs = [
            _pipeline_job(suspend=False, active=1, kueue_managed=True),
            _pipeline_job(suspend=True, kueue_managed=True),
        ]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "running")

    def test_preempted_kueue_job_returns_to_queued(self):
        jobs = [_pipeline_job(suspend=True, kueue_managed=True)]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "queued")

    def test_non_kueue_active_job_remains_running(self):
        jobs = [_pipeline_job(active=1)]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "running")

    def test_failed_job_takes_precedence(self):
        jobs = [
            _pipeline_job(failed=1),
            _pipeline_job(suspend=False, active=1, kueue_managed=True),
        ]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "failed")

    def test_completed_jobs_are_completed(self):
        jobs = [
            _pipeline_job(succeeded=1),
            _pipeline_job(condition_type="Complete", kueue_managed=True),
        ]

        self.assertEqual(kubernetes_utils.get_pipeline_jobs_status(jobs), "completed")


class _FakeBatchV1Api:
    def __init__(self, job_responses):
        self.job_responses = {
            job_name: list(responses) for job_name, responses in job_responses.items()
        }

    def read_namespaced_job_status(self, *, name, namespace):
        del namespace
        responses = self.job_responses[name]
        if len(responses) > 1:
            return responses.pop(0)
        return responses[0]


class WaitForJobsTests(unittest.TestCase):
    def _wait_for_jobs(
        self,
        job_responses,
        monotonic_times,
        *,
        execution_timeout_seconds=3600,
    ):
        batch_api = _FakeBatchV1Api(job_responses)
        with (
            mock.patch.object(
                kubernetes_utils,
                "get_k8s_api_client",
                return_value=object(),
            ),
            mock.patch.object(
                kubernetes_utils.client,
                "BatchV1Api",
                return_value=batch_api,
            ),
            mock.patch.object(
                kubernetes_utils.time,
                "monotonic",
                side_effect=monotonic_times,
            ),
            mock.patch.object(kubernetes_utils.time, "sleep"),
        ):
            kubernetes_utils.wait_for_jobs(
                list(job_responses),
                poll_interval_seconds=1,
                execution_timeout_seconds=execution_timeout_seconds,
            )

    def test_suspended_queue_time_does_not_consume_execution_timeout(self):
        self._wait_for_jobs(
            {
                "queued-job": [
                    _job(suspend=True),
                    _job(suspend=True),
                    _job(suspend=False, condition_type="Complete"),
                ]
            },
            [0, 0, 3601, 7202],
        )

    def test_unsuspended_job_times_out_on_accumulated_execution(self):
        with self.assertRaisesRegex(
            TimeoutError,
            "K8s job active-job exceeded 3600 seconds of admitted execution time",
        ):
            self._wait_for_jobs(
                {
                    "active-job": [
                        _job(suspend=None),
                        _job(suspend=None),
                    ]
                },
                [0, 0, 3601],
            )

    def test_preemption_pauses_and_readmission_resumes_execution_clock(self):
        self._wait_for_jobs(
            {
                "preempted-job": [
                    _job(suspend=False),
                    _job(suspend=True),
                    _job(suspend=True),
                    _job(suspend=False),
                    _job(suspend=False, condition_type="Complete"),
                ]
            },
            [0, 0, 1200, 5000, 6000, 8000],
        )

    def test_parallel_jobs_have_independent_execution_clocks(self):
        self._wait_for_jobs(
            {
                "first-job": [
                    _job(suspend=False),
                    _job(suspend=False, condition_type="Complete"),
                ],
                "second-job": [
                    _job(suspend=True),
                    _job(suspend=False),
                    _job(suspend=False, condition_type="Complete"),
                ],
            },
            [0, 0, 60, 121],
            execution_timeout_seconds=100,
        )

    def test_failed_job_still_raises_runtime_error(self):
        with self.assertRaisesRegex(RuntimeError, "K8s job failed-job failed"):
            self._wait_for_jobs(
                {"failed-job": [_job(condition_type="Failed")]},
                [0, 0],
            )

    def test_completed_job_returns_without_waiting(self):
        self._wait_for_jobs(
            {"completed-job": [_job(condition_type="Complete")]},
            [0, 0],
        )


if __name__ == "__main__":
    unittest.main()
