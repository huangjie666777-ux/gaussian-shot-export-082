import { sampleTrack, ShotTrack } from './track';

/**
 * Timeline playback clock. Scrubbing and playback share sampleTrack with
 * offline export, so previewed motion equals exported motion. The clock is
 * driven by requestAnimationFrame wall time and never captures the canvas.
 */
export class TimelinePlayer {
  private rafId = 0;
  private playing = false;
  private startTime = 0;
  private startTrackTime = 0;
  private duration = 0;

  constructor(
    private readonly onSample: (time: number) => void,
    private readonly onEnded: () => void,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  play(track: ShotTrack, fromTime: number): void {
    if (this.playing || !track.isPlayable) return;
    this.duration = track.duration;
    this.playing = true;
    this.startTime = performance.now();
    this.startTrackTime = Math.min(Math.max(fromTime, 0), this.duration);
    const tick = (now: number): void => {
      if (!this.playing) return;
      const elapsed = (now - this.startTime) / 1000;
      const time = this.startTrackTime + elapsed;
      if (time >= this.duration) {
        this.playing = false;
        this.rafId = 0;
        // The end position must display the exact final keyframe pose.
        this.onSample(this.duration);
        this.onEnded();
        return;
      }
      this.onSample(time);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Sample a scrub position; returns the clamped time actually applied. */
  scrub(track: ShotTrack, time: number): number {
    const clamped = Math.min(Math.max(time, 0), track.duration);
    const shot = sampleTrack(track, clamped);
    this.onSample(shot.time);
    return shot.time;
  }

  dispose(): void {
    this.pause();
  }
}
