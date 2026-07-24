export function setPlayButtonState(playButton: HTMLButtonElement, isPlaying: boolean): void {
  playButton.title = isPlaying ? "Pause" : "Play";
  playButton.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
  playButton.innerHTML = isPlaying
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h3v10H8V7Zm5 0h3v10h-3V7Z"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z"/></svg>`;
}
