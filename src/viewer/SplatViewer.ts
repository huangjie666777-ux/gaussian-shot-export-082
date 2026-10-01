import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PerspectiveCamera, Vector3 } from 'three';
import { SplatRenderer } from '../renderer/SplatRenderer';
import { SplatWorkerClient, type FrameResult } from './SplatWorkerClient';
import { fitCamera, projectionParams } from './camera';
import type { SplatData } from '../splat/parser';
import type { ShotPose } from '../cinematic/track';

export interface ViewerStats {
  count: number;
  visible: number;
}

export interface CameraPose {
  position: [number, number, number];
  /** three.js quaternion layout [x, y, z, w] */
  quaternion: [number, number, number, number];
  fov: number;
}

interface SceneEntry {
  id: number;
  data: SplatData;
}

export class SplatViewer {
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly renderer: SplatRenderer;
  private readonly worker: SplatWorkerClient;
  private scene: SceneEntry | null = null;
  private frameId = 0;
  private issuedFrame = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private frameInFlight = false;
  private frameDirty = false;
  private immediateRequested = false;
  private frameWaiters: Array<{
    frameId: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private idleWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private cinematic = false;
  private savedFreePose: CameraPose | null = null;
  private fixedSize: { width: number; height: number } | null = null;
  private ignoreResize = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onStats: (stats: ViewerStats) => void,
  ) {
    this.camera = new PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 3);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestFrame());

    this.renderer = new SplatRenderer(canvas, () => this.requestFrame(true));
    this.worker = new SplatWorkerClient((result) => this.handleFrame(result));

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvas);
    this.handleResize();

    // OrbitControls damping continues after interaction; keep updating while
    // the camera is still moving. In cinematic mode the timeline owns the
    // camera, so damping must never overwrite the keyframed pose.
    const tick = (): void => {
      if (this.disposed) return;
      if (!this.cinematic) {
        const changed = this.controls.update();
        if (changed) this.requestFrame();
      }
      if (this.frameDirty && !this.frameInFlight) this.dispatchFrame();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /**
   * Replace the active scene. The worker copies the arrays, so the caller may
   * release its own references afterwards.
   */
  setScene(data: SplatData): void {
    const id = this.scene ? this.scene.id + 1 : 1;
    this.scene = { id, data };
    this.frameId = 0;
    this.issuedFrame = 0;
    this.frameInFlight = false;
    this.frameDirty = false;
    this.rejectFrameWaiters(new Error('场景已切换'));
    this.worker.loadScene(id, data);
    this.fit();
    this.onStats({ count: data.count, visible: 0 });
  }

  fit(): void {
    if (!this.scene) return;
    const { center, radius } = this.scene.data.bounds;
    fitCamera(this.camera, { center, radius });
    this.controls.target.copy(new Vector3(center[0], center[1], center[2]));
    this.controls.update();
    this.requestFrame(true);
  }

  resetView(): void {
    this.fit();
  }

  get canvasElement(): HTMLCanvasElement {
    return this.canvas;
  }

  get isCinematic(): boolean {
    return this.cinematic;
  }

  /** Snapshot the current camera for keyframe authoring. */
  capturePose(): CameraPose {
    this.camera.updateMatrixWorld();
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      quaternion: [
        this.camera.quaternion.x,
        this.camera.quaternion.y,
        this.camera.quaternion.z,
        this.camera.quaternion.w,
      ],
      fov: this.camera.fov,
    };
  }

  /**
   * Enter/leave cinematic mode. While cinematic, OrbitControls (and their
   * damping) are disabled so free navigation cannot overwrite keyframed
   * poses. Leaving restores the pose saved on entry.
   */
  setCinematic(enabled: boolean): void {
    if (enabled === this.cinematic) return;
    if (enabled) {
      this.savedFreePose = this.capturePose();
      this.controls.enabled = false;
      this.cinematic = true;
    } else {
      this.cinematic = false;
      this.controls.enabled = true;
      const saved = this.savedFreePose;
      if (saved) {
        this.camera.position.set(...saved.position);
        this.camera.quaternion.set(...saved.quaternion);
        if (this.camera.fov !== saved.fov) {
          this.camera.fov = saved.fov;
          this.camera.updateProjectionMatrix();
        } else {
          this.camera.updateMatrixWorld();
        }
        // Rebuild the controls orbit state from the restored camera so the
        // next free-navigation interaction starts from the saved pose.
        this.controls.update();
      }
      this.requestFrame(true);
    }
  }

  /** Apply a sampled keyframe pose and request a fresh sorted/drawn frame. */
  applyPose(pose: ShotPose): void {
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.camera.quaternion.set(
      pose.quaternion[0],
      pose.quaternion[1],
      pose.quaternion[2],
      pose.quaternion[3],
    );
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.updateMatrixWorld();
    }
    this.requestFrame(true);
  }

  /**
   * Render an exact-size offline frame for a sampled pose and resolve only
   * once the matching Gaussian sort result has been drawn. Used by export:
   * real-time playback is never recorded.
   */
  async renderPoseAtSize(pose: ShotPose, width: number, height: number): Promise<void> {
    if (!this.scene) throw new Error('场景未加载，无法导出');
    // Let any preview sort (e.g. the last frame of free navigation) finish
    // first so its late result can never race the first offline frame.
    if (this.frameInFlight) await this.waitForIdle();
    if (this.disposed) throw new Error('查看器已释放');
    this.fixedSize = { width, height };
    this.ignoreResize = true;
    this.renderer.resizePixels(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyPose(pose);
    await this.waitForFrame();
  }

  /** Restore display canvas dimensions and resume normal interactive sizing. */
  restoreInteractiveSize(): void {
    this.fixedSize = null;
    this.ignoreResize = false;
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    this.renderer.resize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestFrame(true);
  }

  /** Resolve after every currently queued/newer sort job has settled. */
  waitForIdle(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('查看器已释放'));
        return;
      }
      if (!this.frameInFlight) {
        resolve();
        return;
      }
      this.idleWaiters.push({ resolve, reject });
    });
  }

  private waitForFrame(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('查看器已释放'));
        return;
      }
      if (!this.frameInFlight) {
        this.dispatchFrame();
      }
      // Wait for the frame just dispatched (applyPose bumped dirty state
      // beforehand, so it is this exact pose's sort job).
      const frameId = this.issuedFrame;
      this.frameWaiters.push({ frameId, resolve, reject });
    });
  }

  private rejectFrameWaiters(error: Error): void {
    for (const waiter of this.frameWaiters.splice(0)) waiter.reject(error);
    for (const waiter of this.idleWaiters.splice(0)) waiter.reject(error);
  }

  private handleResize(): void {
    if (this.ignoreResize) return;
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    this.renderer.resize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestFrame(true);
  }

  /**
   * Mark the view dirty. Only one projection/sort job is in flight at a time,
   * so a slow worker cannot build a queue of stale camera positions; the next
   * rAF always sends the newest camera once the worker is free again.
   */
  private requestFrame(immediate = false): void {
    if (this.disposed || !this.scene) return;
    this.frameDirty = true;
    if (immediate) this.immediateRequested = true;
    if (!this.frameInFlight && immediate) this.dispatchFrame();
  }

  private dispatchFrame(): void {
    if (!this.scene || this.disposed) return;
    const fixed = this.fixedSize;
    // Offline frames render at exact pixel dimensions (dpr = 1); preview
    // frames follow the CSS canvas size times the display pixel ratio.
    const width = fixed ? fixed.width : this.canvas.clientWidth || 1;
    const height = fixed ? fixed.height : this.canvas.clientHeight || 1;
    const dpr = fixed ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.camera.updateMatrixWorld();
    const params = projectionParams(this.camera, width, height, dpr);
    this.frameId += 1;
    const frameId = this.frameId;
    this.issuedFrame = frameId;
    this.frameDirty = false;
    this.immediateRequested = false;
    this.frameInFlight = true;
    this.worker.requestFrame(this.scene.id, frameId, params);
  }

  private handleFrame(result: FrameResult): void {
    this.frameInFlight = false;
    if (this.disposed) return;
    // Drop late answers from an older scene or an outdated camera position;
    // they must never overwrite the newest state or resolve frame waiters.
    const accepted =
      this.scene !== null &&
      result.sceneId === this.scene.id &&
      result.frameId === this.issuedFrame;
    if (!accepted) {
      // A newer camera position is already pending dispatch: keep the loop
      // alive without drawing the stale payload.
      if (this.frameDirty && !this.frameInFlight) {
        requestAnimationFrame(() => {
          if (this.frameDirty && !this.frameInFlight) this.dispatchFrame();
        });
      }
      return;
    }
    this.renderer.draw(result.packed, result.visible);
    if (this.scene) this.onStats({ count: this.scene.data.count, visible: result.visible });
    for (const waiter of this.frameWaiters.splice(0)) {
      if (waiter.frameId === result.frameId) waiter.resolve();
    }
    for (const waiter of this.idleWaiters.splice(0)) waiter.resolve();
    // The camera moved while the worker was busy: send the newest position.
    if (this.frameDirty) {
      if (this.immediateRequested) this.dispatchFrame();
      else requestAnimationFrame(() => this.dispatchFrame());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectFrameWaiters(new Error('查看器已释放'));
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.worker.dispose();
    this.renderer.dispose();
  }
}
