/*
This TS script integrates the backend and frontend integration of GET/POST endpoints for video and subtitle retrieval
*/
const GCS_BUCKET = "benzaiten-outputs";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL; //"http://127.0.0.1:8000";

const jobIdInput = document.getElementById("jobIdInput") as HTMLInputElement;
const videoNameInput = document.getElementById("videoNameInput") as HTMLInputElement;
const loadButton = document.getElementById("loadButton") as HTMLButtonElement;

const statusText = document.getElementById("statusText") as HTMLParagraphElement;
const media = document.getElementById("videoPlayer") as HTMLMediaElement;

// type FullInferenceResponse = {
//     status: string;
//     job_id: string;
//     video_url: string;
//     subtitle_url: string;
// }

//inference k8s job types:
type JobStartResponse = {
    status: "queued";
    job_id: string;
}

type JobStatusResponse = {
    status: "queued" | "running" | "completed" | "failed";
    job_id: string;
    video_url?: string;
    audio_url?: string;
    subtitle_url?: string;
    error?: string;
};

function setStatus(message: string) {
    /*
    This function updates the status text on the page

    Args: 
        message (string): The message to display in the status text
    */
    console.log(message);
    statusText.textContent = message;
}

function buildGcsUrl(jobId: string, filename: string): string {
    /*
    This function builds the URL to access a file in GCS based on the job ID and filename

    Args:
        jobId (string): The ID of the job
        filename (string): The name of the file to access
    Returns:
        string: The full URL to access the file in GCS
    */
    return `https://storage.googleapis.com/${GCS_BUCKET}/outputs/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`;
}

/**
 * @deprecated Unused with the k8s job pipeline. Keep only for the old pipeline.
 */
// async function convertSubtitlesToVtt(jobId: string): Promise<string> {
//     /*
//     This function sends a POST request to the backend to convert the subtitles for a given job ID to VTT format

//     Args:
//         jobId (string): The ID of the job for which to convert subtitles
//     Returns:
//         Promise<string>: A promise that resolves to the URL of the converted VTT file
//     */
//     const res = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/convert_to_vtt`, {
//         method: "POST",
//     });

//     if (!res.ok) {
//         throw new Error(await res.text());
//     }

//     const data = await res.json();

//     console.log("VTT conversion response:", data);

//     return data.vtt_url;
// }

function setMediaSources(mediaUrl: string, subtitleUrl?: string, mediaLabel = "Media") {
    /*
    This function sets the media source and subtitle track for the player
    
    Args:
        mediaUrl (string): The URL of the video or audio file to play
        subtitleUrl (string, optional): The URL of the subtitle file to use (if available)
    */
    setStatus(`Setting ${mediaLabel.toLowerCase()} source...`);

    console.log("Media URL:", mediaUrl);
    console.log("Subtitle URL:", subtitleUrl);

    // set media src directly
    media.src = `${mediaUrl}?t=${Date.now()}`;

    // remove old tracks
    const oldTracks = media.querySelectorAll("track");
    oldTracks.forEach((track) => track.remove());

    // if subtitle exists, add it as a track
    if (subtitleUrl) {
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = "lyrics";
        track.srclang = "ko";
        track.src = `${subtitleUrl}?t=${Date.now()}`;
        track.default = true;

        track.onload = () => {
            setStatus("Subtitle track loaded");

            for (let i = 0; i < media.textTracks.length; i++) {
                media.textTracks[i].mode = "showing";
            }
        };

        track.onerror = () => {
            setStatus("Subtitle track failed to load");
            console.error("Subtitle failed:", track.src);
        };

        media.appendChild(track);
    }

    media.load();

    media.onloadedmetadata = () => {
        setStatus(`${mediaLabel} metadata loaded, duration: ${media.duration}s`);
    };

    media.oncanplay = () => {
        setStatus(`${mediaLabel} ready`);
    };

    media.onerror = () => {
        setStatus(`${mediaLabel} failed to load`);
        console.error("Media error:", media.error);
        console.error("Attempted media src:", media.src);
    };
}

async function loadVideo() {
    /*
    This function retrieves the job ID and video name, then builds the video URL and subtitle URL, and finally sets the video sources for playback
    */
    const jobId = jobIdInput.value.trim();
    const videoName = videoNameInput.value.trim();

    if (!jobId || !videoName) {
        setStatus("Missing job_id or video_name");
        return;
    }

    setStatus("Loading...");
    loadButton.disabled = true;

    try {
        // old pipeline:
        // setStatus("Converting subtitles...");
        // const videoUrl = buildGcsUrl(jobId, `${videoName}.mp4`);
        // const subtitleUrl = await convertSubtitlesToVtt(jobId);
        // setStatus("Subtitle conversion done. Loading video...");
        // setMediaSources(videoUrl, subtitleUrl, "Video");

        //k8 job pipeline:
        const videoUrl = buildGcsUrl(jobId, `${videoName}.mp4`);
        const subtitleUrl = buildGcsUrl(jobId, "vocals.vtt");

        setStatus("Loading video...");
        setMediaSources(videoUrl, subtitleUrl, "Video");
    } catch (err) {
        setStatus("Failed to convert subtitles or load video.");
        console.error(err);
    } finally {
        loadButton.disabled = false;
    }
}

/**
 * @deprecated Unused with the k8s job pipeline. Keep only for the old pipeline.
 */
// async function runFullInference(
//     file: File,
//     language: string,
//     shouldDecrowd: boolean,
// ): Promise<FullInferenceResponse> {
//     /*
//     This function sends a POST request to the backend to run full inference on the provided video file

//     Args:
//         file (File): The video file to process
//     Returns:
//         Promise<FullInferenceResponse>: A promise that resolves to the response from the backend containing job ID, video URL, and subtitle URL
//     */
//     const formData = new FormData();

//     formData.append("file", file);
//     formData.append("language", language);
//     formData.append("should_decrowd", shouldDecrowd ? "true" : "false");

//     setStatus("Running inference...");

//     const res = await fetch(`${API_BASE_URL}/jobs`, { //await fetch(`${API_BASE_URL}/full_inference`, {
//         method: "POST",
//         body: formData,
//     });

//     if (!res.ok) {
//         throw new Error(await res.text());
//     }

//     const data: FullInferenceResponse = await res.json();
//     console.log("Inference response:", data);

//     localStorage.setItem("job_id", data.job_id);
//     localStorage.setItem("video_url", data.video_url);
    
//     return data;
// }

async function handleRunFullInference() {
    /*
    This function handles the click event for the "Run Full Inference" button, retrieves the selected file, and initiates the full inference process
    */
    const fileInput = document.getElementById("fileInput") as HTMLInputElement;
    const languageInput = document.getElementById("languageInput") as HTMLInputElement;
    const shouldDecrowdInput = document.getElementById("shouldDecrowdInput") as HTMLInputElement;
    const runInferenceButton = document.getElementById("runInferenceButton") as HTMLButtonElement;
    
    const file = fileInput.files?.[0];
    const language = languageInput.value.trim();
    const shouldDecrowd = shouldDecrowdInput.checked;

    if (!file) {
        setStatus("Select a file.")
        return;
    }

    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
        setStatus("Select a video or audio file.");
        return;
    }

    if (!language) {
        setStatus("Enter a language code (e.g. 'en' for English, 'ko' for Korean).");
        return;
    }

    runInferenceButton.disabled = true;

    // try {
    //     const data = await runFullInference(file, language, shouldDecrowd);
    //     setStatus("Converting subtitles...");
    //     const subtitleUrl = await convertSubtitlesToVtt(data.job_id);
    //     setStatus("Inference and subtitle conversion done. Loading video...");
    //     setMediaSources(data.video_url, subtitleUrl, "Video");
    //     jobIdInput.value = data.job_id;
    // } catch (err) {
    //     setStatus("Failed to run inference or convert subtitles.");
    //     console.error(err);
    // } finally {
    //     runInferenceButton.disabled = false;
    // }

    try {
        const startData = await startInferenceJob(file, language, shouldDecrowd);

        localStorage.setItem("job_id", startData.job_id);
        jobIdInput.value = startData.job_id;

        setStatus("Inference job started...");

        const completedJob = await pollJobStatus(startData.job_id);

        if (completedJob.status === "failed") {
            throw new Error(completedJob.error || "Inference job failed");
        }

        const mediaUrl = completedJob.video_url || completedJob.audio_url;
        const mediaLabel = completedJob.video_url ? "Video" : "Audio";

        if (!mediaUrl || !completedJob.subtitle_url) {
            throw new Error("Job completed but output URLs are missing");
        }

        localStorage.setItem("media_url", mediaUrl);

        setStatus(`Inference done. Loading ${mediaLabel.toLowerCase()}...`);
        setMediaSources(mediaUrl, completedJob.subtitle_url, mediaLabel);
    } catch (err) {
        setStatus("Failed to run inference.");
        console.error(err);
    } finally {
        runInferenceButton.disabled = false;
    }
}

async function startInferenceJob(
    file: File,
    language: string,
    shouldDecrowd: boolean,
): Promise<JobStartResponse> {
    const formData = new FormData();

    formData.append("file", file);
    formData.append("language", language);
    formData.append("should_decrowd", shouldDecrowd ? "true" : "false");

    setStatus("Uploading media and starting inference job...");

    const res = await fetch(`${API_BASE_URL}/jobs`, {
        method: "POST",
        body: formData,
    });

    if (!res.ok) {
        throw new Error(await res.text());
    }

    return await res.json();
}

async function pollJobStatus(jobId: string): Promise<JobStatusResponse> {
    while (true) {
        const res = await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`);

        if (!res.ok) {
            throw new Error(await res.text());
        }

        const data: JobStatusResponse = await res.json();

        if (data.status === "completed" || data.status === "failed") {
            return data;
        }

        setStatus(`Inference ${data.status}...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
}

const runInferenceButton = document.getElementById("runInferenceButton") as HTMLButtonElement;
runInferenceButton.addEventListener("click", handleRunFullInference);

loadButton.addEventListener("click", loadVideo);
