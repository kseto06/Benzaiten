/*
This TS script integrates the backend and frontend integration of GET/POST endpoints for video and subtitle retrieval
*/
const GCS_BUCKET = "benzaiten-outputs";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL; //"http://127.0.0.1:8000";

const videoNameInput = document.getElementById("videoNameInput") as HTMLInputElement;
const loadButton = document.getElementById("loadButton") as HTMLButtonElement;

const statusText = document.getElementById("statusText") as HTMLParagraphElement;
const media = document.getElementById("videoPlayer") as HTMLMediaElement;
const LOG_PREFIX = "[Benzaiten]";

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

type GcsObject = {
    name: string;
};

type GcsObjectListResponse = {
    items?: GcsObject[];
    nextPageToken?: string;
};

function setStatus(message: string) {
    /*
    This function updates the status text on the page

    Args: 
        message (string): The message to display in the status text
    */
    console.log(`${LOG_PREFIX} UI status: ${message}`);
    statusText.textContent = message;
}

async function getApiError(response: Response): Promise<string> {
    const body = await response.text();

    try {
        const parsed = JSON.parse(body) as { detail?: string };
        return parsed.detail || body || `Request failed with status ${response.status}`;
    } catch {
        return body || `Request failed with status ${response.status}`;
    }
}

function buildGcsObjectUrl(objectName: string): string {
    const encodedObjectName = objectName
        .split("/")
        .map(segment => encodeURIComponent(segment))
        .join("/");

    return `https://storage.googleapis.com/${GCS_BUCKET}/${encodedObjectName}`;
}

function normalizeSearchText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}

function getObjectFilename(objectName: string): string {
    return objectName.split("/").at(-1) || objectName;
}

function getSearchBigrams(value: string): Set<string> {
    const compactValue = value.replace(/\s/g, "");

    if (compactValue.length < 2) {
        return new Set([compactValue]);
    }

    const bigrams = new Set<string>();
    for (let index = 0; index < compactValue.length - 1; index += 1) {
        bigrams.add(compactValue.slice(index, index + 2));
    }
    return bigrams;
}

function getFuzzyMatchScore(query: string, candidate: string): number {
    const normalizedQuery = normalizeSearchText(query);
    const normalizedCandidate = normalizeSearchText(candidate);

    if (!normalizedQuery || !normalizedCandidate) {
        return 0;
    }

    if (normalizedCandidate === normalizedQuery) {
        return 1;
    }

    if (normalizedCandidate.includes(normalizedQuery)) {
        return 0.95;
    }

    const queryTokens = normalizedQuery.split(" ");
    const candidateTokens = new Set(normalizedCandidate.split(" "));
    const matchedTokens = queryTokens.filter(token => candidateTokens.has(token));
    const tokenCoverage = matchedTokens.length / queryTokens.length;

    const queryBigrams = getSearchBigrams(normalizedQuery);
    const candidateBigrams = getSearchBigrams(normalizedCandidate);
    const sharedBigrams = [...queryBigrams].filter(bigram => candidateBigrams.has(bigram));
    const diceSimilarity = (
        2 * sharedBigrams.length
        / (queryBigrams.size + candidateBigrams.size)
    );

    return Math.max(tokenCoverage * 0.9, diceSimilarity);
}

function isSearchableMediaObject(objectName: string): boolean {
    const parts = objectName.split("/");
    const filename = getObjectFilename(objectName).toLocaleLowerCase();
    const extension = filename.split(".").at(-1);
    const intermediateFilenames = new Set([
        "input_video.mp4",
        "vocals.mp3",
        "instrumental.mp3",
        "instrumental_(decrowd).mp3",
    ]);

    if (
        parts[0] !== "outputs"
        || parts.length < 3
        || !["mp4", "mp3"].includes(extension || "")
        || intermediateFilenames.has(filename)
    ) {
        return false;
    }

    return parts.length === 3 || parts.includes("final_output");
}

async function listOutputObjects(): Promise<GcsObject[]> {
    const objects: GcsObject[] = [];
    let pageToken: string | undefined;

    do {
        const searchParams = new URLSearchParams({
            prefix: "outputs/",
            maxResults: "1000",
            fields: "items(name),nextPageToken",
        });

        if (pageToken) {
            searchParams.set("pageToken", pageToken);
        }

        const requestUrl = (
            `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o?${searchParams}`
        );
        const response = await fetch(requestUrl);

        if (!response.ok) {
            throw new Error(
                `Could not search stored videos (GCS returned ${response.status})`,
            );
        }

        const data: GcsObjectListResponse = await response.json();
        objects.push(...(data.items || []));
        pageToken = data.nextPageToken;
    } while (pageToken);

    return objects;
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
    This function searches the public GCS outputs by video name and loads the
    closest matching media and subtitle objects.
    */
    const searchQuery = videoNameInput.value.trim();

    if (!searchQuery) {
        setStatus("Enter a video name to search.");
        return;
    }

    setStatus(`Searching for "${searchQuery}"...`);
    loadButton.disabled = true;

    try {
        const objects = await listOutputObjects();
        const mediaMatches = objects
            .filter(object => isSearchableMediaObject(object.name))
            .map(object => ({
                object,
                score: getFuzzyMatchScore(
                    searchQuery,
                    getObjectFilename(object.name),
                ),
            }))
            .sort((left, right) => right.score - left.score);

        const bestMatch = mediaMatches[0];
        if (!bestMatch || bestMatch.score < 0.45) {
            throw new Error(`No close match found for "${searchQuery}"`);
        }

        const jobId = bestMatch.object.name.split("/")[1];
        const subtitleObject = objects.find(object => (
            object.name.startsWith(`outputs/${jobId}/`)
            && object.name.endsWith("/vocals.vtt")
        ));
        const matchedFilename = getObjectFilename(bestMatch.object.name);
        const mediaLabel = matchedFilename.toLocaleLowerCase().endsWith(".mp4")
            ? "Video"
            : "Audio";

        console.log(`${LOG_PREFIX} Media search match`, {
            searchQuery,
            score: bestMatch.score,
            matchedObject: bestMatch.object.name,
            subtitleObject: subtitleObject?.name,
        });

        setStatus(`Found "${matchedFilename}". Loading ${mediaLabel.toLowerCase()}...`);
        setMediaSources(
            buildGcsObjectUrl(bestMatch.object.name),
            subtitleObject ? buildGcsObjectUrl(subtitleObject.name) : undefined,
            mediaLabel,
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Failed to load media: ${message}`);
        console.error(`${LOG_PREFIX} Media search failed`, err);
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
    const fastDecrowdInput = document.getElementById("fastDecrowdInput") as HTMLInputElement;
    const runInferenceButton = document.getElementById("runInferenceButton") as HTMLButtonElement;
    
    const file = fileInput.files?.[0];
    const language = languageInput.value.trim();
    const shouldDecrowd = shouldDecrowdInput.checked;
    const fastDecrowd = shouldDecrowd && fastDecrowdInput.checked;

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
    // } catch (err) {
    //     setStatus("Failed to run inference or convert subtitles.");
    //     console.error(err);
    // } finally {
    //     runInferenceButton.disabled = false;
    // }

    try {
        console.log(`${LOG_PREFIX} Starting inference`, {
            apiBaseUrl: API_BASE_URL,
            file: {
                name: file.name,
                type: file.type,
                sizeBytes: file.size,
            },
            language,
            shouldDecrowd,
            fastDecrowd,
        });

        const startData = await startInferenceJob(
            file,
            language,
            shouldDecrowd,
            fastDecrowd,
        );

        localStorage.setItem("job_id", startData.job_id);

        console.log(`${LOG_PREFIX} Inference job accepted`, startData);
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

        console.log(`${LOG_PREFIX} Inference job completed`, completedJob);
        localStorage.setItem("media_url", mediaUrl);

        setStatus(`Inference done. Loading ${mediaLabel.toLowerCase()}...`);
        setMediaSources(mediaUrl, completedJob.subtitle_url, mediaLabel);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Failed to run inference: ${message}`);
        console.error(`${LOG_PREFIX} Inference flow failed`, err);
    } finally {
        runInferenceButton.disabled = false;
    }
}

async function startInferenceJob(
    file: File,
    language: string,
    shouldDecrowd: boolean,
    fastDecrowd: boolean,
): Promise<JobStartResponse> {
    const formData = new FormData();

    formData.append("file", file);
    formData.append("language", language);
    formData.append("should_decrowd", shouldDecrowd ? "true" : "false");
    formData.append("fast_decrowd", fastDecrowd ? "true" : "false");

    setStatus("Uploading media and starting inference job...");

    const requestUrl = `${API_BASE_URL}/jobs`;
    const requestStartedAt = performance.now();

    console.log(`${LOG_PREFIX} POST ${requestUrl}`, {
        fileName: file.name,
        fileType: file.type,
        fileSizeBytes: file.size,
        language,
        shouldDecrowd,
        fastDecrowd,
    });

    const res = await fetch(requestUrl, {
        method: "POST",
        body: formData,
    });

    console.log(`${LOG_PREFIX} POST ${requestUrl} response`, {
        status: res.status,
        ok: res.ok,
        durationMs: Math.round(performance.now() - requestStartedAt),
    });

    if (!res.ok) {
        const error = await getApiError(res);
        console.error(`${LOG_PREFIX} Job submission rejected`, {
            status: res.status,
            error,
        });
        throw new Error(error);
    }

    const data: JobStartResponse = await res.json();
    console.log(`${LOG_PREFIX} Job submission response`, data);
    return data;
}

async function pollJobStatus(jobId: string): Promise<JobStatusResponse> {
    const requestUrl = `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`;
    const pollingStartedAt = performance.now();
    let pollAttempt = 0;
    let previousStatus: JobStatusResponse["status"] | undefined;

    console.log(`${LOG_PREFIX} Polling job`, { jobId, requestUrl });

    while (true) {
        pollAttempt += 1;
        const requestStartedAt = performance.now();
        const res = await fetch(requestUrl);

        if (!res.ok) {
            const error = await getApiError(res);
            console.error(`${LOG_PREFIX} Job status request failed`, {
                jobId,
                pollAttempt,
                status: res.status,
                durationMs: Math.round(performance.now() - requestStartedAt),
                error,
            });
            throw new Error(error);
        }

        const data: JobStatusResponse = await res.json();

        console.log(`${LOG_PREFIX} Job status response`, {
            jobId,
            pollAttempt,
            requestDurationMs: Math.round(performance.now() - requestStartedAt),
            elapsedMs: Math.round(performance.now() - pollingStartedAt),
            data,
        });

        if (data.status !== previousStatus) {
            console.log(`${LOG_PREFIX} Job status changed`, {
                jobId,
                previousStatus,
                status: data.status,
            });
            previousStatus = data.status;
        }

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
videoNameInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        void loadVideo();
    }
});

const shouldDecrowdInput = document.getElementById("shouldDecrowdInput") as HTMLInputElement;
const fastDecrowdInput = document.getElementById("fastDecrowdInput") as HTMLInputElement;

function syncFastDecrowdAvailability() {
    fastDecrowdInput.disabled = !shouldDecrowdInput.checked;
    if (fastDecrowdInput.disabled) {
        fastDecrowdInput.checked = false;
    }
}

shouldDecrowdInput.addEventListener("change", syncFastDecrowdAvailability);
syncFastDecrowdAvailability();
