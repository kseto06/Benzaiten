const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const escapeHtml = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function getKaraokeTokenWeight(text) {
  let weight = 0;
  for (const character of Array.from(String(text).trim())) {
    if (/\s/u.test(character)) {
      continue;
    }
    weight += /[\W_]/u.test(character) ? 0.25 : 1;
  }
  return Math.max(0.25, weight);
}

function getKaraokeLineTokens(line) {
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

function getTimedKaraokeTokens(cue) {
  const lines = cue.text.replace(/\r/g, "").split("\n");
  const cueDuration = Math.max(0.01, cue.end - cue.start);
  const timedSegments = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) {
      timedSegments.push({ lineBreak: true });
    }
    const lineTokens = getKaraokeLineTokens(line);
    const lineWeight = lineTokens.reduce(
      (total, segment) => total + segment.weight,
      0,
    );
    let cursor = cue.start;
    for (const segment of lineTokens) {
      const segmentDuration = cueDuration
        * (segment.weight / Math.max(0.25, lineWeight));
      const timedSegment = {
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

function renderKaraokeSubtitle(cue, time) {
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

window.configureSubtitleRenderer = settings => {
  window.__benzaitenSubtitleSettings = settings;
  const box = document.getElementById("subtitleBox");
  const overlay = document.getElementById("subtitleOverlay");
  const transform = settings.transform;
  box.style.left = `${transform.x}%`;
  box.style.top = `${transform.y}%`;
  box.style.width = `${transform.width}%`;
  box.style.height = `${transform.height}%`;
  box.style.transform = `translate(-50%, -50%) rotate(${transform.rotation}deg)`;
  overlay.style.setProperty("--subtitle-preview-scale", settings.previewScale);
  overlay.style.fontSize = `${settings.subtitleFontSize * settings.previewScale}px`;
  overlay.style.setProperty(
    "--karaoke-highlight-color",
    settings.karaokeHighlightColor,
  );
};

window.renderSubtitleAt = time => {
  const settings = window.__benzaitenSubtitleSettings;
  const overlay = document.getElementById("subtitleOverlay");
  const cue = settings.cues.find(item => time >= item.start && time < item.end);
  overlay.innerHTML = cue
    ? settings.karaokeEnabled
      ? renderKaraokeSubtitle(cue, time)
      : escapeHtml(cue.text)
    : "";
};
