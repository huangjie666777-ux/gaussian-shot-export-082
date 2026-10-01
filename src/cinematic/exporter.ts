/**
 * Offline WebM export of a shot track.
 *
 * For every fixed-step sample the pose is pushed to the viewer, rendered at
 * exact 1280x720 pixels, and only handed to the encoder after the matching
 * Gaussian sort/draw has completed. Nothing is recorded from real-time
 * playback and raw frames are never accumulated: each sample is created,
 * encoded and closed in turn. On cancel/failure the muxer is canceled, no
 * partial file is ever returned, and the viewer canvas/camera are restored.
 */
import {
  BufferTarget,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny';
import { buildExportSamples, sampleTrack, ShotTrack } from './track';
import type { CameraPose, SplatViewer } from '../viewer/SplatViewer';

export const EXPORT_WIDTH = 1280;
export const EXPORT_HEIGHT = 720;
export const EXPORT_FPS = 30;
export const EXPORT_BITRATE = 8_000_000;

export interface ExportProgress {
  completed: number;
  total: number;
}

export interface ExportHandle {
  promise: Promise<Blob>;
  cancel: () => void;
}

export class ExportCanceledError extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'ExportCanceledError';
  }
}

export function exportTrack(
  viewer: SplatViewer,
  track: ShotTrack,
  onProgress: (progress: ExportProgress) => void,
): ExportHandle {
  let canceled = false;
  const promise = runExport(viewer, track, onProgress, () => canceled);
  return {
    promise,
    cancel: (): void => {
      canceled = true;
    },
  };
}

async function runExport(
  viewer: SplatViewer,
  track: ShotTrack,
  onProgress: (progress: ExportProgress) => void,
  isCanceled: () => boolean,
): Promise<Blob> {
  if (!track.isPlayable) throw new Error('至少需要两个关键帧才能导出');
  const samples = buildExportSamples(track.duration, EXPORT_FPS);
  if (samples.length === 0) throw new Error('镜头时长为 0，无法导出');

  // Remember the real free-navigation pose (only needed for failure/cancel
  // restore; on success the UI keeps the authored final pose).
  const savedPose: CameraPose = viewer.capturePose();
  const wasCinematic = viewer.isCinematic;
  viewer.setCinematic(true);

  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new VideoSampleSource({
    codec: 'vp8',
    bitrate: EXPORT_BITRATE,
    // Quality mode never drops or throttles frames for real-time pacing.
    latencyMode: 'quality',
  });
  output.addVideoTrack(source, {
    frameRate: EXPORT_FPS,
    maximumPacketCount: samples.length,
  });

  let started = false;
  let finalized = false;
  try {
    await output.start();
    started = true;

    for (let index = 0; index < samples.length; index++) {
      if (isCanceled()) throw new ExportCanceledError();
      const sample = samples[index];
      const shot = sampleTrack(track, sample.time);
      // Each encode waits for this exact pose's Gaussian sorting + drawing.
      await viewer.renderPoseAtSize(shot, EXPORT_WIDTH, EXPORT_HEIGHT);
      if (isCanceled()) throw new ExportCanceledError();

      const frame = new VideoSample(viewer.canvasElement, {
        timestamp: sample.time,
        duration: sample.duration,
      });
      try {
        // Backpressure: await before rendering the next frame.
        await source.add(frame);
      } finally {
        frame.close();
      }
      onProgress({ completed: index + 1, total: samples.length });
    }

    await output.finalize();
    finalized = true;
    const buffer = target.buffer;
    if (!buffer) throw new Error('编码完成但未取得视频数据');
    return new Blob([buffer], { type: 'video/webm;codecs=vp8' });
  } catch (error) {
    // Never finalize after cancel/failure: cancel() releases the
    // encoder/muxer and the BufferTarget never exposes a partial file.
    if (started && !finalized) {
      await output.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    viewer.restoreInteractiveSize();
    if (!wasCinematic) {
      // Failure or cancel from free navigation: give the camera back.
      viewer.setCinematic(false);
      viewer.applyPose(savedPose);
    }
    // On success (or when the user was already previewing the track) the UI
    // decides which pose to show; the canvas size is always restored.
  }
}
