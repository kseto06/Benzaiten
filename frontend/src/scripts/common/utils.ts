/*
This file contains the utils functions that are used across multiple scripts in the frontend.
*/

import { GCS_BUCKET } from "./config";
import type { KaraokeLineBreak, KaraokeToken, SubtitleCue, TimedKaraokeToken } from "./types";
import { escapeHtml } from "./dom";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function getKaraokeTokenWeight(text: string): number {
  let weight = 0;
  for (const character of Array.from(text.trim())) {
    if (/\s/u.test(character)) {
      continue;
    }
    weight += /\p{P}|\p{S}/u.test(character) ? 0.25 : 1;
  }
  return Math.max(0.25, weight);
}

export function getKaraokeLineTokens(line: string): KaraokeToken[] {
  if (!line) {
    return [];
  }
  if (/\s/u.test(line.trim())) {
    return (line.match(/\S+\s*/gu) || []).map(token => ({
      text: token,
      weight: getKaraokeTokenWeight(token),
    }));
  }
  return Array.from(line).map(character => ({
    text: character,
    weight: getKaraokeTokenWeight(character),
  }));
}

export function getTimedKaraokeTokens(cue: SubtitleCue): Array<TimedKaraokeToken | KaraokeLineBreak> {
  const lines = cue.text.replace(/\r/g, "").split("\n");
  const cueDuration = Math.max(0.01, cue.end - cue.start);
  const timedSegments: Array<TimedKaraokeToken | KaraokeLineBreak> = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) {
      timedSegments.push({ lineBreak: true });
    }
    const lineTokens = getKaraokeLineTokens(line);
    const lineWeight = lineTokens.reduce((total, segment) => total + segment.weight, 0);
    let cursor = cue.start;
    for (const segment of lineTokens) {
      const segmentDuration = cueDuration * (segment.weight / Math.max(0.25, lineWeight));
      const timedSegment: TimedKaraokeToken = {
        ...segment,
        start: cursor,
        end: cursor + segmentDuration,
      };
      timedSegments.push(timedSegment);
      cursor = timedSegment.end;
    }
  }
  return timedSegments;
}

export function renderKaraokeSubtitle(cue: SubtitleCue, time: number): string {
  return getTimedKaraokeTokens(cue).map(segment => {
    if (segment.lineBreak === true) {
      return "\n";
    }
    const progress = clamp(
      (time - segment.start) / Math.max(0.01, segment.end - segment.start),
      0,
      1,
    );
    const text = escapeHtml(segment.text);
    return (
      `<span class="karaoke-segment" style="--karaoke-progress:${(progress * 100).toFixed(2)}%">`
      + `<span class="karaoke-segment-base">${text}</span>`
      + `<span class="karaoke-segment-fill" aria-hidden="true">${text}</span>`
      + "</span>"
    );
  }).join("");
}

export function getGcsObjectName(url?: string | null): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsedUrl = new URL(url);
    const prefix = `/${GCS_BUCKET}/`;
    if (!parsedUrl.pathname.startsWith(prefix)) {
      return undefined;
    }
    return decodeURIComponent(parsedUrl.pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export function filenameWithoutExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
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

function getSearchBigrams(value: string): Set<string> {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 2) {
    return new Set([compact]);
  }

  const bigrams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    bigrams.add(compact.slice(index, index + 2));
  }
  return bigrams;
}

export function getFuzzyMatchScore(query: string, candidate: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate === normalizedQuery) {
    return 1;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 0.96;
  }

  const queryTokens = normalizedQuery.split(" ");
  const candidateTokens = new Set(normalizedCandidate.split(" "));
  const tokenCoverage = (
    queryTokens.filter(token => candidateTokens.has(token)).length / queryTokens.length
  );
  const queryBigrams = getSearchBigrams(normalizedQuery);
  const candidateBigrams = getSearchBigrams(normalizedCandidate);
  const shared = [...queryBigrams].filter(bigram => candidateBigrams.has(bigram));
  const dice = (2 * shared.length) / (queryBigrams.size + candidateBigrams.size);
  return Math.max(tokenCoverage * 0.9, dice);
}
function parseTimestamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN)) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parts[0] * 60 + parts[1];
}

export function parseSubtitleFile(content: string): SubtitleCue[] {
  const normalized = content.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex(line => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }
    const [startValue, endPart] = lines[timingIndex].split("-->");
    const endValue = endPart.trim().split(/\s+/)[0];
    const start = parseTimestamp(startValue);
    const end = parseTimestamp(endValue);
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "");
    if (end > start && text) {
      cues.push({
        id: crypto.randomUUID(),
        start,
        end,
        text,
      });
    }
  }
  return cues;
}

export function formatTime(seconds: number, includeMilliseconds = false): string {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds % 1) * 1000);
  const base = hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
  return includeMilliseconds ? `${base}.${String(milliseconds).padStart(3, "0")}` : base;
}
