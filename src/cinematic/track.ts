/**
 * Camera shot track: time-ordered keyframes carrying position, orientation
 * quaternion and vertical field of view.
 *
 * The track is immutable: every mutation returns either a new track or an
 * error message and never mutates the previous keyframes, so invalid input
 * cannot corrupt an authored timeline.
 */

export interface ShotPose {
  position: [number, number, number];
  /** quaternion in three.js layout [x, y, z, w] */
  quaternion: [number, number, number, number];
  /** vertical field of view in degrees */
  fov: number;
}

export interface ShotKeyframe extends ShotPose {
  id: number;
  /** track time in seconds */
  time: number;
}

export interface SampledShot extends ShotPose {
  time: number;
}

export const MIN_FOV = 1;
export const MAX_FOV = 170;

export class TrackValidationError extends Error {}

function allFinite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function normalizeQuat(
  quat: [number, number, number, number],
): [number, number, number, number] {
  const norm = Math.hypot(quat[0], quat[1], quat[2], quat[3]) || 1;
  return [quat[0] / norm, quat[1] / norm, quat[2] / norm, quat[3] / norm];
}

function validatePose(pose: ShotPose): string | null {
  if (pose.position.length !== 3 || !allFinite(pose.position)) {
    return '相机位置包含非法数值（需为有限数字）';
  }
  if (pose.quaternion.length !== 4 || !allFinite(pose.quaternion)) {
    return '相机四元数包含非法数值（需为有限数字）';
  }
  const norm = Math.hypot(
    pose.quaternion[0],
    pose.quaternion[1],
    pose.quaternion[2],
    pose.quaternion[3],
  );
  if (!(norm > 1e-6)) return '相机四元数长度为零，无法表示姿态';
  if (!Number.isFinite(pose.fov)) {
    return '垂直视场角必须是有效数字';
  }
  if (pose.fov < MIN_FOV || pose.fov > MAX_FOV) {
    return `垂直视场角必须在 ${MIN_FOV}° ~ ${MAX_FOV}° 之间`;
  }
  return null;
}

export type TrackResult = { ok: true; track: ShotTrack } | { ok: false; error: string };

export class ShotTrack {
  readonly frames: readonly ShotKeyframe[];

  constructor(frames: readonly ShotKeyframe[] = []) {
    this.frames = frames.map((frame) => ({
      ...frame,
      position: [...frame.position] as [number, number, number],
      quaternion: normalizeQuat([...frame.quaternion] as [number, number, number, number]),
    }));
  }

  get duration(): number {
    return this.frames.length === 0 ? 0 : this.frames[this.frames.length - 1].time;
  }

  get isPlayable(): boolean {
    return this.frames.length >= 2 && this.duration > 0;
  }

  nextId(): number {
    return this.frames.reduce((max, frame) => Math.max(max, frame.id), 0) + 1;
  }

  /** Add a keyframe. First frame must be t=0; later times strictly increase. */
  add(time: number, pose: ShotPose): TrackResult {
    if (!Number.isFinite(time)) return { ok: false, error: '关键帧时间必须是有限数字' };
    if (this.frames.length === 0 && time !== 0) {
      return { ok: false, error: '首帧时间必须为 0 秒' };
    }
    if (this.frames.length > 0 && time <= this.duration) {
      return { ok: false, error: '关键帧时间必须严格大于上一帧' };
    }
    const poseError = validatePose(pose);
    if (poseError) return { ok: false, error: poseError };
    const frame: ShotKeyframe = {
      id: this.nextId(),
      time,
      position: [...pose.position] as [number, number, number],
      quaternion: normalizeQuat([...pose.quaternion] as [number, number, number, number]),
      fov: pose.fov,
    };
    return { ok: true, track: new ShotTrack([...this.frames, frame]) };
  }

  /** Replace pose fields and/or the time of an existing keyframe. */
  update(id: number, patch: Partial<ShotPose> & { time?: number }): TrackResult {
    const index = this.frames.findIndex((frame) => frame.id === id);
    if (index < 0) return { ok: false, error: '关键帧不存在或已被删除' };
    const current = this.frames[index];
    const next: ShotKeyframe = {
      id,
      time: patch.time ?? current.time,
      position: patch.position
        ? ([...patch.position] as [number, number, number])
        : ([...current.position] as [number, number, number]),
      quaternion: patch.quaternion
        ? normalizeQuat([...patch.quaternion] as [number, number, number, number])
        : ([...current.quaternion] as [number, number, number, number]),
      fov: patch.fov ?? current.fov,
    };
    if (!Number.isFinite(next.time)) {
      return { ok: false, error: '关键帧时间必须是有限数字' };
    }
    if (index === 0 && next.time !== 0) {
      return { ok: false, error: '首帧时间必须为 0 秒' };
    }
    if (index > 0 && next.time <= this.frames[index - 1].time) {
      return { ok: false, error: '时间必须与前一关键帧严格递增' };
    }
    if (index < this.frames.length - 1 && next.time >= this.frames[index + 1].time) {
      return { ok: false, error: '时间必须与后一关键帧严格递增' };
    }
    const poseError = validatePose(next);
    if (poseError) return { ok: false, error: poseError };
    const frames = this.frames.slice();
    frames[index] = next;
    return { ok: true, track: new ShotTrack(frames) };
  }

  /** Delete a keyframe; deleting the t=0 frame re-bases remaining times. */
  remove(id: number): TrackResult {
    if (!this.frames.some((frame) => frame.id === id)) {
      return { ok: false, error: '关键帧不存在或已被删除' };
    }
    const remaining = this.frames
      .filter((frame) => frame.id !== id)
      .map((frame) => ({ ...frame }));
    if (remaining.length > 0 && remaining[0].time !== 0) {
      const base = remaining[0].time;
      for (const frame of remaining) frame.time -= base;
    }
    return { ok: true, track: new ShotTrack(remaining) };
  }
}

/** Spherical shortest-arc quaternion interpolation (three.js [x,y,z,w]). */
export function slerpQuat(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  t: number,
): [number, number, number, number] {
  let ax = a[0];
  let ay = a[1];
  let az = a[2];
  let aw = a[3];
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let cosAngle = ax * bx + ay * by + az * bz + aw * bw;
  // Pick the shorter great-circle arc.
  if (cosAngle < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosAngle = -cosAngle;
  }
  let s0: number;
  let s1: number;
  if (cosAngle > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const omega = Math.acos(Math.min(1, cosAngle));
    const sinOmega = Math.sin(omega);
    s0 = Math.sin((1 - t) * omega) / sinOmega;
    s1 = Math.sin(t * omega) / sinOmega;
  }
  return normalizeQuat([
    s0 * ax + s1 * bx,
    s0 * ay + s1 * by,
    s0 * az + s1 * bz,
    s0 * aw + s1 * bw,
  ]);
}

function poseOf(frame: ShotKeyframe): SampledShot {
  return {
    time: frame.time,
    position: [...frame.position] as [number, number, number],
    quaternion: [...frame.quaternion] as [number, number, number, number],
    fov: frame.fov,
  };
}

/**
 * Sample at time t: position and fov interpolate linearly, rotation uses
 * shortest-arc slerp. Out-of-range times clamp to the end poses, so the
 * final keyframe pose is shown at (and beyond) the track end.
 */
export function sampleTrack(track: ShotTrack, time: number): SampledShot {
  const frames = track.frames;
  if (frames.length === 0) throw new TrackValidationError('镜头轨道为空，无法采样');
  if (!Number.isFinite(time)) throw new TrackValidationError('采样时间必须是有限数字');
  if (time <= frames[0].time) return poseOf(frames[0]);
  if (time >= frames[frames.length - 1].time) return poseOf(frames[frames.length - 1]);

  let right = 1;
  while (right < frames.length && frames[right].time < time) right++;
  const left = frames[right - 1];
  const rightFrame = frames[right];
  const span = rightFrame.time - left.time;
  const alpha = span <= 0 ? 0 : (time - left.time) / span;
  return {
    time,
    position: [
      left.position[0] + (rightFrame.position[0] - left.position[0]) * alpha,
      left.position[1] + (rightFrame.position[1] - left.position[1]) * alpha,
      left.position[2] + (rightFrame.position[2] - left.position[2]) * alpha,
    ],
    quaternion: slerpQuat(left.quaternion, rightFrame.quaternion, alpha),
    fov: left.fov + (rightFrame.fov - left.fov) * alpha,
  };
}

export interface ExportSample {
  /** presentation timestamp in seconds */
  time: number;
  /** presentation duration in seconds; the tail sample keeps the remainder */
  duration: number;
}

/**
 * Fixed-step offline sample schedule. Times start at 0 and advance by
 * 1/fps while staying strictly before the end time. The final regular
 * sample is clipped to the remaining duration, so a sub-frame tail still
 * produces a frame and total duration matches the track exactly.
 */
export function buildExportSamples(duration: number, fps: number): ExportSample[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TrackValidationError('镜头总时长必须为正数');
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TrackValidationError('帧率必须为正数');
  }
  const step = 1 / fps;
  const samples: ExportSample[] = [];
  let index = 0;
  // Epsilon guards against float drift making the last regular sample equal
  // the end time; it still samples strictly before the end.
  while (index * step < duration - 1e-9) {
    const time = index * step;
    const next = Math.min((index + 1) * step, duration);
    samples.push({ time, duration: Math.max(0, next - time) });
    index++;
  }
  return samples;
}
