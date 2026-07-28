import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import soundTouchProcessorUrl from "@soundtouchjs/audio-worklet/processor?url";

export type EditorAudioGraphOptions = {
  captureOnly?: boolean;
};

export type PitchCapability = {
  supported: boolean;
  reason: string;
};

export class EditorAudioGraph {
  private readonly captureOnly: boolean;
  private context: AudioContext | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private pitchNode: SoundTouchNode | null = null;
  private captureDestination: MediaStreamAudioDestinationNode | null = null;
  private initialization: Promise<boolean> | null = null;
  private readonly sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private readonly mediaElements = new Set<HTMLMediaElement>();
  private volumePercent = 100;
  private playbackRate = 1;
  private pitchSemitones = 0;

  constructor(options: EditorAudioGraphOptions = {}) {
    this.captureOnly = options.captureOnly ?? false;
  }

  static getPitchCapability(): PitchCapability {
    if (typeof AudioContext === "undefined") {
      return {
        supported: false,
        reason: "Web Audio is unavailable in this browser.",
      };
    }
    if (!window.isSecureContext) {
      return {
        supported: false,
        reason: "Live pitch requires HTTPS or localhost.",
      };
    }
    if (!("audioWorklet" in AudioContext.prototype)) {
      return {
        supported: false,
        reason: "AudioWorklet is unavailable in this browser.",
      };
    }
    return { supported: true, reason: "" };
  }

  static isPitchSupported(): boolean {
    return EditorAudioGraph.getPitchCapability().supported;
  }

  get pitchSupported(): boolean {
    return this.pitchNode !== null;
  }

  get captureStream(): MediaStream | null {
    return this.captureDestination?.stream ?? null;
  }

  get processorMetrics() {
    return this.pitchNode?.metrics ?? null;
  }

  private async initialize(): Promise<boolean> {
    if (this.masterGain && this.context) {
      return true;
    }
    if (this.initialization) {
      return this.initialization;
    }

    this.initialization = (async () => {
      try {
        this.context = new AudioContext();
        this.dryGain = this.context.createGain();
        this.wetGain = this.context.createGain();
        this.masterGain = this.context.createGain();
        const destination = this.captureOnly
          ? (this.captureDestination = this.context.createMediaStreamDestination())
          : this.context.destination;
        this.dryGain.connect(this.masterGain);
        this.wetGain.connect(this.masterGain);
        this.masterGain.connect(destination);

        if (EditorAudioGraph.isPitchSupported()) {
          await SoundTouchNode.register(this.context, soundTouchProcessorUrl);
          this.pitchNode = new SoundTouchNode({ context: this.context });
          this.pitchNode.addEventListener("processorerror", event => {
            console.warn("[Benzaiten] Pitch processor stopped unexpectedly", event);
          });
          this.pitchNode.connect(this.wetGain);
        }

        this.applySettings();
        return true;
      } catch (error) {
        console.warn("[Benzaiten] Audio processing graph is unavailable", error);
        await this.close();
        return false;
      }
    })();

    return this.initialization;
  }

  private applySettings(): void {
    if (!this.context || !this.masterGain || !this.dryGain || !this.wetGain) {
      return;
    }
    const now = this.context.currentTime;
    const pitchActive = this.pitchNode !== null && Math.abs(this.pitchSemitones) >= 0.001;
    this.masterGain.gain.setValueAtTime(this.volumePercent / 100, now);
    this.dryGain.gain.setValueAtTime(pitchActive ? 0 : 1, now);
    this.wetGain.gain.setValueAtTime(pitchActive ? 1 : 0, now);
    for (const element of this.mediaElements) {
      element.preservesPitch = !pitchActive;
    }
    if (this.pitchNode) {
      this.pitchNode.pitchSemitones.setValueAtTime(this.pitchSemitones, now);
      this.pitchNode.playbackRate.setValueAtTime(this.playbackRate, now);
    }
  }

  async connectMediaElement(element: HTMLMediaElement): Promise<boolean> {
    if (!(await this.initialize()) || !this.context || !this.dryGain) {
      return false;
    }
    if (this.sources.has(element)) {
      return true;
    }
    try {
      const source = this.context.createMediaElementSource(element);
      source.connect(this.dryGain);
      if (this.pitchNode) {
        source.connect(this.pitchNode);
      }
      element.volume = 1;
      this.sources.set(element, source);
      this.mediaElements.add(element);
      this.applySettings();
      return true;
    } catch (error) {
      console.warn("[Benzaiten] Could not attach media to the audio graph", error);
      return false;
    }
  }

  hasMediaElement(element: HTMLMediaElement): boolean {
    return this.sources.has(element);
  }

  setVolume(value: number): void {
    this.volumePercent = value;
    this.applySettings();
  }

  setPlaybackRate(value: number): void {
    this.playbackRate = value;
    this.applySettings();
  }

  setPitchSemitones(value: number): void {
    this.pitchSemitones = value;
    this.applySettings();
  }

  async resume(): Promise<void> {
    if (await this.initialize()) {
      await this.context?.resume();
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.dryGain = null;
    this.wetGain = null;
    this.masterGain = null;
    this.pitchNode = null;
    this.captureDestination = null;
    this.initialization = null;
    for (const element of this.mediaElements) {
      element.preservesPitch = true;
    }
    this.mediaElements.clear();
    if (context && context.state !== "closed") {
      await context.close();
    }
  }
}
