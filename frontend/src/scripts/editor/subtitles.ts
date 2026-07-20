import type { SubtitleCue } from "../common/types";

export function normalizeSubtitleCueTimings(
  cues: SubtitleCue[],
  minimumDuration: number,
): void {
  cues.sort((left, right) => left.start - right.start);
  for (let index = 1; index < cues.length; index += 1) {
    const previousCue = cues[index - 1];
    const cue = cues[index];
    if (previousCue.end <= cue.start) {
      continue;
    }
    if (cue.start - previousCue.start >= minimumDuration) {
      previousCue.end = cue.start;
    } else {
      cue.start = previousCue.end;
      cue.end = Math.max(cue.end, cue.start + minimumDuration);
    }
  }
}

export function getSubtitleNeighborBounds(
  cues: SubtitleCue[],
  cue: SubtitleCue,
  duration: number,
): {
  previousEnd: number;
  nextStart: number;
} {
  const index = cues.findIndex(candidate => candidate.id === cue.id);
  return {
    previousEnd: index > 0 ? cues[index - 1].end : 0,
    nextStart: index >= 0 && index < cues.length - 1
      ? cues[index + 1].start
      : duration,
  };
}
