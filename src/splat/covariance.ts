export interface Mat3 {
  /** column-major 3x3 */
  m: Float32Array;
}

/** Rotation matrix (column major) from normalized quaternion [w,x,y,z]. */
export function quatToMat3(q: ArrayLike<number>, out: Float32Array): Float32Array {
  const w = q[0];
  const x = q[1];
  const y = q[2];
  const z = q[3];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  out[0] = 1 - 2 * (yy + zz);
  out[1] = 2 * (xy + wz);
  out[2] = 2 * (xz - wy);
  out[3] = 2 * (xy - wz);
  out[4] = 1 - 2 * (xx + zz);
  out[5] = 2 * (yz + wx);
  out[6] = 2 * (xz + wy);
  out[7] = 2 * (yz - wx);
  out[8] = 1 - 2 * (xx + yy);
  return out;
}

/**
 * World-space 3D covariance Sigma = R S (R S)^T from rotation and positive
 * axis scales. Writes six unique entries (column major):
 * [00,10,20,11,21,22].
 */
export function worldCovariance3(
  rotations: ArrayLike<number>,
  scales: ArrayLike<number>,
  index: number,
  out: Float32Array,
): Float32Array {
  const r = new Float32Array(9);
  quatToMat3(
    [
      rotations[index * 4],
      rotations[index * 4 + 1],
      rotations[index * 4 + 2],
      rotations[index * 4 + 3],
    ],
    r,
  );
  const sx = scales[index * 3];
  const sy = scales[index * 3 + 1];
  const sz = scales[index * 3 + 2];
  r[0] *= sx;
  r[1] *= sx;
  r[2] *= sx;
  r[3] *= sy;
  r[4] *= sy;
  r[5] *= sy;
  r[6] *= sz;
  r[7] *= sz;
  r[8] *= sz;
  out[0] = r[0] * r[0] + r[3] * r[3] + r[6] * r[6];
  out[1] = r[0] * r[1] + r[3] * r[4] + r[6] * r[7];
  out[2] = r[0] * r[2] + r[3] * r[5] + r[6] * r[8];
  out[3] = r[1] * r[1] + r[4] * r[4] + r[7] * r[7];
  out[4] = r[1] * r[2] + r[4] * r[5] + r[7] * r[8];
  out[5] = r[2] * r[2] + r[5] * r[5] + r[8] * r[8];
  return out;
}

export interface ProjectedGaussian {
  visible: boolean;
  screenX: number;
  screenY: number;
  covA: number;
  covB: number;
  covC: number;
  radius: number;
  /** positive camera-space depth */
  depth: number;
}

export interface ProjectionParams {
  /** column-major view matrix (three.js camera.matrixWorldInverse) */
  view: Float32Array;
  /** focal length in pixels */
  focalX: number;
  focalY: number;
  /** principal point in pixels */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  near: number;
}

const FILTER_PIXELS = 0.3;

/**
 * EWA-style projection: camera-transform the 3D covariance, multiply by the
 * perspective Jacobian and add the standard screen-space low-pass filter.
 */
export function projectCovariance(
  worldCov: ArrayLike<number>,
  worldPos: ArrayLike<number>,
  posOffset: number,
  params: ProjectionParams,
): ProjectedGaussian {
  const v = params.view;
  const px = worldPos[posOffset];
  const py = worldPos[posOffset + 1];
  const pz = worldPos[posOffset + 2];
  const tx = v[0] * px + v[4] * py + v[8] * pz + v[12];
  const ty = v[1] * px + v[5] * py + v[9] * pz + v[13];
  const tz = v[2] * px + v[6] * py + v[10] * pz + v[14];
  const depth = -tz;

  const rejected: ProjectedGaussian = {
    visible: false,
    screenX: 0,
    screenY: 0,
    covA: 0,
    covB: 0,
    covC: 0,
    radius: 0,
    depth,
  };

  // Behind camera or too close to the near plane: the Jacobian diverges there,
  // so such splats must never reach the rasterizer.
  if (!(depth > params.near) || !Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
    return rejected;
  }

  // Camera-space covariance: W is the 3x3 rotation of the view matrix.
  const w00 = v[0];
  const w01 = v[4];
  const w02 = v[8];
  const w10 = v[1];
  const w11 = v[5];
  const w12 = v[9];
  const w20 = v[2];
  const w21 = v[6];
  const w22 = v[10];
  const s00 = worldCov[0];
  const s10 = worldCov[1];
  const s20 = worldCov[2];
  const s11 = worldCov[3];
  const s21 = worldCov[4];
  const s22 = worldCov[5];

  const t00 = w00 * s00 + w01 * s10 + w02 * s20;
  const t01 = w00 * s10 + w01 * s11 + w02 * s21;
  const t02 = w00 * s20 + w01 * s21 + w02 * s22;
  const t10 = w10 * s00 + w11 * s10 + w12 * s20;
  const t11 = w10 * s10 + w11 * s11 + w12 * s21;
  const t12 = w10 * s20 + w11 * s21 + w12 * s22;
  const t20 = w20 * s00 + w21 * s10 + w22 * s20;
  const t21 = w20 * s10 + w21 * s11 + w22 * s21;
  const t22 = w20 * s20 + w21 * s21 + w22 * s22;

  const c00 = t00 * w00 + t01 * w01 + t02 * w02;
  const c01 = t00 * w10 + t01 * w11 + t02 * w12;
  const c02 = t00 * w20 + t01 * w21 + t02 * w22;
  const c11 = t10 * w10 + t11 * w11 + t12 * w12;
  const c12 = t10 * w20 + t11 * w21 + t12 * w22;
  const c22 = t20 * w20 + t21 * w21 + t22 * w22;

  // Perspective Jacobian at (tx,ty,tz), focal already in pixels. Screen
  // coordinates are u = fx*tx/d + cx and v = cy - fy*ty/d with d = -tz:
  //   du/dtx = fx/d,  du/dtz = fx*tx/d^2
  //   dv/dty = -fy/d, dv/dtz = -fy*ty/d^2.
  const invD = 1 / depth;
  const j00 = params.focalX * invD;
  const j02 = params.focalX * tx * invD * invD;
  const j11 = -params.focalY * invD;
  const j12 = -params.focalY * ty * invD * invD;

  let covA = j00 * c00 * j00 + 2 * j00 * c02 * j02 + j02 * c22 * j02;
  let covB = j00 * c01 * j11 + j00 * c02 * j12 + j02 * c12 * j11 + j02 * c22 * j12;
  let covC = j11 * c11 * j11 + 2 * j11 * c12 * j12 + j12 * c22 * j12;
  covA += FILTER_PIXELS * FILTER_PIXELS;
  covC += FILTER_PIXELS * FILTER_PIXELS;

  if (![covA, covB, covC].every(Number.isFinite)) return rejected;

  const det = covA * covC - covB * covB;
  const trace = covA + covC;
  if (!(det > 1e-6) || !(trace > 0)) return rejected;
  const mid = trace * 0.5;
  const disc = mid * mid - det;
  if (!(disc >= 0)) return rejected;
  const lambda1 = mid + Math.sqrt(disc);
  const lambda2 = mid - Math.sqrt(disc);
  if (!(lambda2 > 0)) return rejected;
  const radius = 3 * Math.sqrt(lambda1);

  const screenX = params.centerX + params.focalX * tx * invD;
  const screenY = params.centerY - params.focalY * ty * invD;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return rejected;
  if (radius < 0.5) return rejected;
  // Defensive: a perspective-blown splat can cover the whole screen.
  if (radius > 2 * Math.max(params.width, params.height)) return rejected;
  if (
    screenX + radius < 0 ||
    screenX - radius > params.width ||
    screenY + radius < 0 ||
    screenY - radius > params.height
  ) {
    return rejected;
  }

  return { visible: true, screenX, screenY, covA, covB, covC, radius, depth };
}
