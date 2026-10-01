import { describe, expect, it } from 'vitest';
import {
  buildExportSamples,
  MAX_FOV,
  MIN_FOV,
  sampleTrack,
  ShotTrack,
  slerpQuat,
} from './track';

const pose = (
  x: number,
  fov = 50,
): { position: [number, number, number]; quaternion: [number, number, number, number]; fov: number } => ({
  position: [x, 0, 0],
  quaternion: [0, 0, 0, 1],
  fov,
});

describe('ShotTrack keyframe rules', () => {
  it('requires the first keyframe at t=0 and strict increase afterwards', () => {
    let track = new ShotTrack();
    expect(track.add(1, pose(0)).ok).toBe(false);
    const first = track.add(0, pose(0));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    track = first.track;
    expect(track.add(0, pose(1)).ok).toBe(false);
    expect(track.add(-1, pose(1)).ok).toBe(false);
    const second = track.add(2, pose(2));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.track.isPlayable).toBe(true);
    expect(second.track.duration).toBe(2);
  });

  it('rejects non-finite values and out-of-range fov without mutating the track', () => {
    let track = new ShotTrack([
      { id: 1, time: 0, ...pose(0) },
      { id: 2, time: 1, ...pose(1) },
    ]);
    const snapshot = track.frames.length;
    expect(track.update(2, { fov: NaN }).ok).toBe(false);
    expect(track.update(2, { fov: MIN_FOV - 0.1 }).ok).toBe(false);
    expect(track.update(2, { fov: MAX_FOV + 0.1 }).ok).toBe(false);
    expect(track.update(2, { position: [1, NaN, 0] }).ok).toBe(false);
    expect(track.update(2, { quaternion: [0, 0, 0, 0] }).ok).toBe(false);
    expect(track.update(2, { time: Infinity }).ok).toBe(false);
    expect(track.frames.length).toBe(snapshot);
    expect(track.frames[1].time).toBe(1);
    // A valid update goes through.
    const updated = track.update(2, { time: 0.5, fov: 70 });
    expect(updated.ok).toBe(true);
    if (updated.ok) track = updated.track;
    expect(track.frames[1].time).toBe(0.5);
    expect(track.frames[1].fov).toBe(70);
  });

  it('keeps strict ordering when a time is edited and re-bases after removing t=0', () => {
    const track =
      new ShotTrack([
        { id: 1, time: 0, ...pose(0) },
        { id: 2, time: 1, ...pose(1) },
        { id: 3, time: 2, ...pose(2) },
      ]);
    expect(track.update(2, { time: 2 }).ok).toBe(false);
    expect(track.update(3, { time: 0.5 }).ok).toBe(false);
    const removed = track.remove(1);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.track.frames[0].time).toBe(0);
    expect(removed.track.frames[1].time).toBe(1);
  });
});

describe('track sampling', () => {
  const track = new ShotTrack([
    { id: 1, time: 0, ...pose(0, 30) },
    { id: 2, time: 2, ...pose(2, 90) },
  ]);

  it('linearly interpolates position and fov', () => {
    const mid = sampleTrack(track, 1);
    expect(mid.position[0]).toBeCloseTo(1, 8);
    expect(mid.fov).toBeCloseTo(60, 8);
  });

  it('clamps to end poses, showing the final pose at the end', () => {
    const end = sampleTrack(track, 2);
    expect(end.position[0]).toBe(2);
    expect(end.fov).toBe(90);
    const beyond = sampleTrack(track, 99);
    expect(beyond.position[0]).toBe(2);
    expect(sampleTrack(track, -1).position[0]).toBe(0);
  });

  it('slerps along the shortest arc (90 deg rotation interpolates to 45 deg)', () => {
    const a: [number, number, number, number] = [0, 0, 0, 1];
    const b: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const mid = slerpQuat(a, b, 0.5);
    expect(mid[1]).toBeCloseTo(Math.sin(Math.PI / 8), 8);
    expect(mid[3]).toBeCloseTo(Math.cos(Math.PI / 8), 8);
    // Negated (long-arc) quaternion takes the short path too.
    const midNeg = slerpQuat(a, [-0, -Math.SQRT1_2, -0, -Math.SQRT1_2], 0.5);
    expect(midNeg[1]).toBeCloseTo(Math.sin(Math.PI / 8), 8);
  });
});

describe('buildExportSamples', () => {
  it('samples from 0 at fixed steps strictly before the end and keeps the tail', () => {
    const samples = buildExportSamples(1, 30);
    expect(samples).toHaveLength(30);
    expect(samples[0].time).toBe(0);
    expect(samples[29].time).toBeCloseTo(29 / 30, 10);
    expect(samples[29].duration).toBeCloseTo(1 / 30, 10);
    let total = 0;
    for (const sample of samples) total += sample.duration;
    expect(total).toBeCloseTo(1, 10);
  });

  it('handles a sub-frame remainder by clipping the final duration', () => {
    const samples = buildExportSamples(0.05, 30);
    expect(samples).toHaveLength(2);
    expect(samples[0].duration).toBeCloseTo(1 / 30, 10);
    expect(samples[1].time).toBeCloseTo(1 / 30, 10);
    expect(samples[1].duration).toBeCloseTo(0.05 - 1 / 30, 10);
    const tiny = buildExportSamples(0.02, 30);
    expect(tiny).toHaveLength(1);
    expect(tiny[0].duration).toBeCloseTo(0.02, 10);
  });

  it('rejects invalid duration and fps', () => {
    expect(() => buildExportSamples(0, 30)).toThrow();
    expect(() => buildExportSamples(1, 0)).toThrow();
  });
});
