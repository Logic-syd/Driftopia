let audio: AudioContext | null = null;
export const reducedMotion = () => {
  const preference = localStorage.getItem("driftopia-motion");
  return preference
    ? preference === "reduced"
    : window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};
// Created only after an explicit user preference/gesture; no downloaded assets.
export function playFeedback(kind: "success" | "salvage") {
  if (localStorage.getItem("driftopia-sound") !== "on") return;
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      kind === "salvage" ? 620 : 440,
      audio.currentTime,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === "salvage" ? 930 : 660,
      audio.currentTime + 0.12,
    );
    gain.gain.setValueAtTime(0.035, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.19);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.2);
  } catch {
    /* Audio support must never block gameplay. */
  }
}
