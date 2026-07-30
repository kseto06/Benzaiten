import { processOffline } from "@soundtouchjs/audio-worklet";
import soundTouchProcessorUrl from "@soundtouchjs/audio-worklet/processor?url";
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { BrowserExportFormat } from "../common/types";

const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const EXPORT_FRAME_RATE = 30;
const VIDEO_BITRATE = 6_000_000;
const AUDIO_BITRATE = 192_000;
const AUDIO_SAMPLE_RATE = 48_000;

type BrowserExportAudioSource = {
  name: string;
  url: string;
  start: number;
  duration: number;
};

type BrowserProjectExportOptions = {
  mediaUrl: string;
  duration: number;
  volumePercent: number;
  playbackRate: number;
  pitchSemitones: number;
  additionalAudioSources: BrowserExportAudioSource[];
  signal: AbortSignal;
  drawOverlay: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    sourceTime: number,
  ) => void;
  onProgress: (percent: number, status: string) => void;
};

export type BrowserProjectExportResult = {
  blob: Blob;
  format: BrowserExportFormat;
};

type EncodingSelection = {
  format: BrowserExportFormat;
  outputFormat: Mp4OutputFormat | WebMOutputFormat;
  videoCodec: "avc" | "vp9" | "vp8";
  audioCodec: "aac" | "opus" | null;
};

type DecodedAudioSource = {
  name: string;
  buffer: AudioBuffer;
  start: number;
  duration: number;
};

type RenderOutputOptions = {
  encoding: EncodingSelection;
  mediaBlob: Blob;
  videoTrack: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>;
  sourceDuration: number;
  outputDuration: number;
  playbackRate: number;
  processedAudio: AudioBuffer | null;
  signal: AbortSignal;
  drawOverlay: BrowserProjectExportOptions["drawOverlay"];
  onProgress: BrowserProjectExportOptions["onProgress"];
  useNativeVideoDecoder: boolean;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Export was cancelled.", "AbortError");
  }
}

async function fetchMediaBlob(url: string, signal: AbortSignal): Promise<Blob> {
  throwIfAborted(signal);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Unable to read local media for export (${response.status}).`);
  }
  return response.blob();
}

function describeDecodeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return error.message;
  }
  if (error instanceof Error && error.message && error.message !== "Decoding error") {
    return error.message;
  }
  return "The browser's WebCodecs decoder rejected this media track.";
}

async function decodeAudioBlobNatively(
  blob: Blob,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  throwIfAborted(signal);
  const AudioContextConstructor = window.AudioContext
    || (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }

  const context = new AudioContextConstructor();
  try {
    const encodedAudio = await blob.arrayBuffer();
    throwIfAborted(signal);
    return await context.decodeAudioData(encodedAudio);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    console.info(
      "[Benzaiten] Native browser audio decode was unavailable",
      error,
    );
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function selectEncoding(hasAudio: boolean): Promise<EncodingSelection | null> {
  const mp4Video = await canEncodeVideo("avc", {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    bitrate: VIDEO_BITRATE,
  });
  const mp4Audio = !hasAudio || await canEncodeAudio("aac", {
    numberOfChannels: 2,
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
  });
  if (mp4Video && mp4Audio) {
    return {
      format: {
        label: "MP4",
        extension: "mp4",
        mimeType: "video/mp4",
        isFallback: false,
      },
      // Keeping the MP4 metadata at the end avoids buffering a second copy of
      // long exports solely to move the metadata before the media payload.
      outputFormat: new Mp4OutputFormat({ fastStart: false }),
      videoCodec: "avc",
      audioCodec: hasAudio ? "aac" : null,
    };
  }

  const webmAudio = !hasAudio || await canEncodeAudio("opus", {
    numberOfChannels: 2,
    sampleRate: AUDIO_SAMPLE_RATE,
    bitrate: AUDIO_BITRATE,
  });
  if (!webmAudio) {
    return null;
  }
  for (const codec of ["vp9", "vp8"] as const) {
    if (await canEncodeVideo(codec, {
      width: EXPORT_WIDTH,
      height: EXPORT_HEIGHT,
      bitrate: VIDEO_BITRATE,
    })) {
      return {
        format: {
          label: "WEBM",
          extension: "webm",
          mimeType: "video/webm",
          isFallback: true,
        },
        outputFormat: new WebMOutputFormat(),
        videoCodec: codec,
        audioCodec: hasAudio ? "opus" : null,
      };
    }
  }
  return null;
}

async function decodeAudioTrack(
  input: Input,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) {
    return null;
  }
  const sampleRate = await audioTrack.getSampleRate();
  const numberOfChannels = await audioTrack.getNumberOfChannels();
  if (!sampleRate || !numberOfChannels) {
    return null;
  }

  const sink = new AudioBufferSink(audioTrack);
  const chunks = [];
  let firstTimestamp: number | null = null;
  let endTimestamp = 0;
  for await (const chunk of sink.buffers()) {
    throwIfAborted(signal);
    firstTimestamp ??= chunk.timestamp;
    endTimestamp = Math.max(endTimestamp, chunk.timestamp + chunk.duration);
    chunks.push(chunk);
  }
  if (firstTimestamp === null || chunks.length === 0) {
    return null;
  }

  const length = Math.max(
    1,
    Math.ceil((endTimestamp - firstTimestamp) * sampleRate),
  );
  const combined = new AudioBuffer({
    length,
    numberOfChannels,
    sampleRate,
  });
  for (const chunk of chunks) {
    const destinationOffset = Math.max(
      0,
      Math.round((chunk.timestamp - firstTimestamp) * sampleRate),
    );
    for (
      let channelIndex = 0;
      channelIndex < Math.min(numberOfChannels, chunk.buffer.numberOfChannels);
      channelIndex += 1
    ) {
      const sourceData = chunk.buffer.getChannelData(channelIndex);
      const remaining = combined.length - destinationOffset;
      if (remaining <= 0) {
        continue;
      }
      combined.copyToChannel(
        sourceData.subarray(0, Math.min(sourceData.length, remaining)),
        channelIndex,
        destinationOffset,
      );
    }
  }
  return combined;
}

async function decodeAudioSource(
  source: BrowserExportAudioSource,
  signal: AbortSignal,
): Promise<DecodedAudioSource | null> {
  const blob = await fetchMediaBlob(source.url, signal);
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    if (!await input.canRead()) {
      return null;
    }
    let buffer: AudioBuffer | null = null;
    const audioTrack = await input.getPrimaryAudioTrack();
    if (audioTrack && await audioTrack.canDecode()) {
      try {
        buffer = await decodeAudioTrack(input, signal);
      } catch (error) {
        console.info(
          `[Benzaiten] WebCodecs could not decode ${source.name}; trying native audio decode`,
          error,
        );
      }
    }
    buffer ??= await decodeAudioBlobNatively(blob, signal);
    if (!buffer) {
      return null;
    }
    return {
      ...source,
      buffer,
      duration: Math.min(source.duration, buffer.duration),
    };
  } finally {
    input.dispose();
  }
}

async function mixAndProcessAudio(
  sources: DecodedAudioSource[],
  timelineDuration: number,
  volumePercent: number,
  playbackRate: number,
  pitchSemitones: number,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  if (!sources.length || timelineDuration <= 0) {
    return null;
  }
  throwIfAborted(signal);
  const mixContext = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(timelineDuration * AUDIO_SAMPLE_RATE)),
    AUDIO_SAMPLE_RATE,
  );
  const gain = mixContext.createGain();
  gain.gain.value = Math.max(0, volumePercent / 100);
  gain.connect(mixContext.destination);

  for (const source of sources) {
    const sourceNode = mixContext.createBufferSource();
    sourceNode.buffer = source.buffer;
    sourceNode.connect(gain);
    const start = Math.max(0, source.start);
    const availableDuration = Math.max(
      0,
      Math.min(
        source.duration,
        source.buffer.duration,
        timelineDuration - start,
      ),
    );
    if (availableDuration > 0) {
      sourceNode.start(start, 0, availableDuration);
    }
  }
  const mixed = await mixContext.startRendering();
  throwIfAborted(signal);

  if (
    Math.abs(pitchSemitones) < 0.001
    && Math.abs(playbackRate - 1) < 0.001
  ) {
    return mixed;
  }
  if (
    typeof OfflineAudioContext === "undefined"
    || !("audioWorklet" in OfflineAudioContext.prototype)
    || !window.isSecureContext
  ) {
    throw new Error(
      "This browser cannot apply Pitch or Speed during local export. "
      + "Use a secure browser context with AudioWorklet support.",
    );
  }
  return processOffline({
    input: mixed,
    processorUrl: soundTouchProcessorUrl,
    pitchSemitones,
    playbackRate,
  });
}

function outputTimestamps(duration: number): Iterable<number> {
  const frameCount = Math.max(1, Math.ceil(duration * EXPORT_FRAME_RATE));
  return {
    *[Symbol.iterator]() {
      for (let index = 0; index < frameCount; index += 1) {
        yield Math.min(duration, index / EXPORT_FRAME_RATE);
      }
    },
  };
}

function sourceTimestamps(duration: number, playbackRate: number): Iterable<number> {
  const outputDuration = duration / playbackRate;
  return {
    *[Symbol.iterator]() {
      for (const timestamp of outputTimestamps(outputDuration)) {
        yield Math.min(
          Math.max(0, duration - Number.EPSILON),
          timestamp * playbackRate,
        );
      }
    },
  };
}

function waitForMediaEvent(
  media: HTMLMediaElement,
  successEvent: keyof HTMLMediaElementEventMap,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      media.removeEventListener(successEvent, onSuccess);
      media.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onSuccess = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("The browser could not decode the local video."));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Export was cancelled.", "AbortError"));
    };
    media.addEventListener(successEvent, onSuccess, { once: true });
    media.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function drawVideoContained(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    video,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

async function renderWithNativeVideoDecoder(
  mediaBlob: Blob,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  videoSource: CanvasSource,
  sourceDuration: number,
  outputDuration: number,
  playbackRate: number,
  signal: AbortSignal,
  drawOverlay: BrowserProjectExportOptions["drawOverlay"],
  onProgress: BrowserProjectExportOptions["onProgress"],
): Promise<void> {
  const sourceUrl = URL.createObjectURL(mediaBlob);
  const sourceVideo = document.createElement("video");
  sourceVideo.src = sourceUrl;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.preload = "auto";
  // Run below real time so canvas encoding cannot starve native video decode.
  sourceVideo.playbackRate = 0.5;

  const frameDuration = 1 / EXPORT_FRAME_RATE;
  const frameCount = Math.max(1, Math.ceil(outputDuration * EXPORT_FRAME_RATE));
  let frameIndex = 0;
  let callbackId: number | null = null;
  let settled = false;
  let ending = false;
  let frameTask = Promise.resolve();

  try {
    if (sourceVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForMediaEvent(sourceVideo, "loadedmetadata", signal);
    }
    throwIfAborted(signal);
    sourceVideo.currentTime = 0;
    if (sourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForMediaEvent(sourceVideo, "loadeddata", signal);
    }

    if (!("requestVideoFrameCallback" in sourceVideo)) {
      throw new Error(
        "This browser cannot provide decoded video frames for local export.",
      );
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        sourceVideo.removeEventListener("ended", onEnded);
        sourceVideo.removeEventListener("error", onError);
        if (callbackId !== null) {
          sourceVideo.cancelVideoFrameCallback(callbackId);
          callbackId = null;
        }
      };
      const finish = async (): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          while (frameIndex < frameCount) {
            throwIfAborted(signal);
            const outputTimestamp = frameIndex / EXPORT_FRAME_RATE;
            const sourceTime = Math.min(
              sourceDuration,
              outputTimestamp * playbackRate,
            );
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#000";
            context.fillRect(0, 0, canvas.width, canvas.height);
            drawVideoContained(
              context,
              sourceVideo,
              canvas.width,
              canvas.height,
            );
            drawOverlay(context, canvas.width, canvas.height, sourceTime);
            await videoSource.add(
              outputTimestamp,
              Math.min(
                frameDuration,
                Math.max(frameDuration / 2, outputDuration - outputTimestamp),
              ),
              { keyFrame: frameIndex % (EXPORT_FRAME_RATE * 2) === 0 },
            );
            frameIndex += 1;
          }
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onAbort = (): void => {
        settled = true;
        cleanup();
        reject(new DOMException("Export was cancelled.", "AbortError"));
      };
      const onError = (): void => {
        settled = true;
        cleanup();
        reject(new Error("The browser could not decode the local video."));
      };
      const onEnded = (): void => {
        ending = true;
        void frameTask.then(finish).catch(error => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        });
      };
      const scheduleFrame = (): void => {
        callbackId = sourceVideo.requestVideoFrameCallback(
          (_now, metadata) => {
            callbackId = null;
            frameTask = (async () => {
              throwIfAborted(signal);
              const decodedSourceTime = Math.min(
                sourceDuration,
                Math.max(0, metadata.mediaTime),
              );
              const lastReadyOutputIndex = Math.min(
                frameCount - 1,
                Math.floor(
                  (decodedSourceTime / playbackRate) * EXPORT_FRAME_RATE,
                ),
              );
              while (frameIndex <= lastReadyOutputIndex) {
                const outputTimestamp = frameIndex / EXPORT_FRAME_RATE;
                const sourceTime = Math.min(
                  sourceDuration,
                  outputTimestamp * playbackRate,
                );
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = "#000";
                context.fillRect(0, 0, canvas.width, canvas.height);
                drawVideoContained(
                  context,
                  sourceVideo,
                  canvas.width,
                  canvas.height,
                );
                drawOverlay(context, canvas.width, canvas.height, sourceTime);
                await videoSource.add(
                  outputTimestamp,
                  Math.min(
                    frameDuration,
                    Math.max(
                      frameDuration / 2,
                      outputDuration - outputTimestamp,
                    ),
                  ),
                  { keyFrame: frameIndex % (EXPORT_FRAME_RATE * 2) === 0 },
                );
                frameIndex += 1;
                onProgress(
                  10 + (frameIndex / frameCount) * 76,
                  "",
                );
              }
              if (!settled && !ending) {
                scheduleFrame();
              }
            })();
            void frameTask.catch(error => {
              if (!settled) {
                settled = true;
                cleanup();
                reject(error);
              }
            });
          },
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      sourceVideo.addEventListener("ended", onEnded, { once: true });
      sourceVideo.addEventListener("error", onError, { once: true });
      scheduleFrame();
      void sourceVideo.play().catch(error => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
    });
  } finally {
    sourceVideo.pause();
    sourceVideo.removeAttribute("src");
    sourceVideo.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

async function renderEncodedOutput(
  options: RenderOutputOptions,
): Promise<BrowserProjectExportResult> {
  const {
    encoding,
    mediaBlob,
    videoTrack,
    sourceDuration,
    outputDuration,
    playbackRate,
    processedAudio,
    signal,
    drawOverlay,
    onProgress,
    useNativeVideoDecoder,
  } = options;
  if (!videoTrack) {
    throw new Error("The selected project does not contain a video track.");
  }

  const target = new BufferTarget();
  const output = new Output({
    format: encoding.outputFormat,
    target,
  });
  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas export is not available in this browser.");
  }
  const videoSource = new CanvasSource(canvas, {
    codec: encoding.videoCodec,
    bitrate: VIDEO_BITRATE,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, {
    frameRate: EXPORT_FRAME_RATE,
  });
  const audioSource = processedAudio && encoding.audioCodec
    ? new AudioBufferSource({
        codec: encoding.audioCodec,
        bitrate: AUDIO_BITRATE,
      })
    : null;
  if (audioSource) {
    output.addAudioTrack(audioSource);
  }

  try {
    await output.start();
    if (useNativeVideoDecoder) {
      await renderWithNativeVideoDecoder(
        mediaBlob,
        canvas,
        context,
        videoSource,
        sourceDuration,
        outputDuration,
        playbackRate,
        signal,
        drawOverlay,
        onProgress,
      );
    } else {
      const frameDuration = 1 / EXPORT_FRAME_RATE;
      const frameCount = Math.max(
        1,
        Math.ceil(outputDuration * EXPORT_FRAME_RATE),
      );
      const sampleSink = new VideoSampleSink(videoTrack);
      let frameIndex = 0;
      for await (
        const sample of sampleSink.samplesAtTimestamps(
          sourceTimestamps(sourceDuration, playbackRate),
        )
      ) {
        throwIfAborted(signal);
        const outputTimestamp = frameIndex / EXPORT_FRAME_RATE;
        const sourceTime = Math.min(
          sourceDuration,
          outputTimestamp * playbackRate,
        );
        context.clearRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        context.fillStyle = "#000";
        context.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
        if (sample) {
          sample.drawWithFit(context, { fit: "contain" });
          sample.close();
        }
        drawOverlay(context, EXPORT_WIDTH, EXPORT_HEIGHT, sourceTime);
        await videoSource.add(
          outputTimestamp,
          Math.min(
            frameDuration,
            Math.max(frameDuration / 2, outputDuration - outputTimestamp),
          ),
          { keyFrame: frameIndex % (EXPORT_FRAME_RATE * 2) === 0 },
        );
        frameIndex += 1;
        onProgress(
          10 + (frameIndex / frameCount) * 76,
          encoding.format.isFallback
            ? "Rendering WebM frames in your browser..."
            : "Rendering MP4 frames in your browser...",
        );
      }
    }
    videoSource.close();

    if (audioSource && processedAudio) {
      throwIfAborted(signal);
      onProgress(88, "Encoding pitched project audio");
      await audioSource.add(processedAudio);
      audioSource.close();
    }
    throwIfAborted(signal);
    onProgress(96, "Finalizing browser export");
    await output.finalize();
    if (!target.buffer) {
      throw new Error("Browser export completed without producing a video");
    }
    return {
      blob: new Blob([target.buffer], { type: encoding.format.mimeType }),
      format: encoding.format,
    };
  } catch (error) {
    if (!["canceled", "finalized"].includes(output.state)) {
      await output.cancel().catch(() => undefined);
    }
    throw error;
  }
}

export async function canUseDeterministicBrowserExport(): Promise<boolean> {
  return (
    typeof VideoEncoder !== "undefined"
    && typeof VideoDecoder !== "undefined"
    && Boolean(await selectEncoding(false))
  );
}

export async function renderBrowserProjectDeterministically(
  options: BrowserProjectExportOptions,
): Promise<BrowserProjectExportResult> {
  const {
    mediaUrl,
    volumePercent,
    playbackRate,
    pitchSemitones,
    additionalAudioSources,
    signal,
    drawOverlay,
    onProgress,
  } = options;
  throwIfAborted(signal);
  onProgress(2, "Reading local media");

  const mediaBlob = await fetchMediaBlob(mediaUrl, signal);
  const input = new Input({
    source: new BlobSource(mediaBlob),
    formats: ALL_FORMATS,
  });
  try {
    if (!await input.canRead()) {
      throw new Error("This media format cannot be decoded for browser export.");
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("The selected project does not contain a video track.");
    }
    const sourceDuration = Math.min(
      options.duration,
      await input.computeDuration([videoTrack]),
    );
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      throw new Error("The selected video has an invalid duration.");
    }

    onProgress(5, "Decoding project audio");
    const primaryAudioTrack = await input.getPrimaryAudioTrack();
    let primaryAudio: AudioBuffer | null = null;
    if (primaryAudioTrack && await primaryAudioTrack.canDecode()) {
      try {
        primaryAudio = await decodeAudioTrack(input, signal);
      } catch (error) {
        console.info(
          "[Benzaiten] WebCodecs audio decode failed; trying native audio decode",
          error,
        );
      }
    }
    primaryAudio ??= await decodeAudioBlobNatively(mediaBlob, signal);
    if (primaryAudioTrack && !primaryAudio) {
      throw new Error(
        "The browser could not decode this video's audio track for local export.",
      );
    }
    const decodedAdditionalAudio = await Promise.all(
      additionalAudioSources.map(source => decodeAudioSource(source, signal)),
    );
    const decodedAudioSources: DecodedAudioSource[] = [
      ...(primaryAudio
        ? [{
            name: "Primary program audio",
            start: 0,
            duration: sourceDuration,
            buffer: primaryAudio,
          }]
        : []),
      ...decodedAdditionalAudio.filter(
        (source): source is DecodedAudioSource => source !== null,
      ),
    ];

    const encoding = await selectEncoding(decodedAudioSources.length > 0);
    if (!encoding) {
      throw new Error("This browser does not expose a compatible video encoder.");
    }
    onProgress(8, "Preparing project audio");
    const processedAudio = await mixAndProcessAudio(
      decodedAudioSources,
      sourceDuration,
      volumePercent,
      playbackRate,
      pitchSemitones,
      signal,
    );
    const outputDuration = sourceDuration / playbackRate;
    const videoCanDecode = await videoTrack.canDecode();
    if (!videoCanDecode) {
      onProgress(
        9,
        "Using the browser's native decoder for this video codec...",
      );
      return renderEncodedOutput({
        encoding,
        mediaBlob,
        videoTrack,
        sourceDuration,
        outputDuration,
        playbackRate,
        processedAudio,
        signal,
        drawOverlay,
        onProgress,
        useNativeVideoDecoder: true,
      });
    }

    try {
      return await renderEncodedOutput({
        encoding,
        mediaBlob,
        videoTrack,
        sourceDuration,
        outputDuration,
        playbackRate,
        processedAudio,
        signal,
        drawOverlay,
        onProgress,
        useNativeVideoDecoder: false,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      console.warn(
        "[Benzaiten] WebCodecs video decode failed; retrying with native browser decode",
        error,
      );
      onProgress(
        9,
        `Retrying with native browser decode. ${describeDecodeError(error)}`,
      );
      return renderEncodedOutput({
        encoding,
        mediaBlob,
        videoTrack,
        sourceDuration,
        outputDuration,
        playbackRate,
        processedAudio,
        signal,
        drawOverlay,
        onProgress,
        useNativeVideoDecoder: true,
      });
    }
  } finally {
    input.dispose();
  }
}
