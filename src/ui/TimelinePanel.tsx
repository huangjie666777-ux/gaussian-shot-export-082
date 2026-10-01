import { useEffect, useRef, useState } from 'react';
import { TimelinePlayer } from '../cinematic/playback';
import {
  exportTrack,
  EXPORT_FPS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  type ExportProgress,
} from '../cinematic/exporter';
import { sampleTrack, ShotTrack, type ShotKeyframe } from '../cinematic/track';
import type { CameraPose, SplatViewer } from '../viewer/SplatViewer';

interface TimelinePanelProps {
  viewerRef: React.RefObject<SplatViewer | null>;
}

type Notice = { kind: 'error' | 'info'; text: string } | null;

function formatTime(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

export function TimelinePanel({ viewerRef }: TimelinePanelProps): React.JSX.Element {
  const [track, setTrack] = useState<ShotTrack>(() => new ShotTrack());
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({ completed: 0, total: 0 });
  const [notice, setNotice] = useState<Notice>(null);
  const [timeDrafts, setTimeDrafts] = useState<Record<number, string>>({});

  const playerRef = useRef<TimelinePlayer | null>(null);
  const exportHandleRef = useRef<ReturnType<typeof exportTrack> | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const exportingRef = useRef(false);
  exportingRef.current = exporting;

  const showPose = (nextTrack: ShotTrack, time: number): void => {
    const viewer = viewerRef.current;
    if (!viewer || nextTrack.frames.length === 0) return;
    const shot = sampleTrack(nextTrack, time);
    viewer.applyPose(shot);
    setCurrentTime(shot.time);
  };
  const showPoseRef = useRef(showPose);
  showPoseRef.current = showPose;

  useEffect(() => {
    const player = new TimelinePlayer(
      (time) => showPoseRef.current(trackRef.current, time),
      () => setPlaying(false),
    );
    playerRef.current = player;
    return () => player.dispose();
  }, [viewerRef]);

  const enterCinematic = (): void => {
    viewerRef.current?.setCinematic(true);
  };

  const stopPlayback = (): void => {
    playerRef.current?.pause();
    setPlaying(false);
  };

  const captureKeyframe = (): void => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    stopPlayback();
    // Recording happens from free navigation; exit cinematic first so the
    // captured camera is the live orbit camera.
    viewer.setCinematic(false);
    const pose: CameraPose = viewer.capturePose();
    const time = track.frames.length === 0 ? 0 : track.duration + 1;
    const result = track.add(time, pose);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setTrack(result.track);
    setNotice({ kind: 'info', text: `已记录第 ${result.track.frames.length} 个关键帧（t=${time}s）` });
  };

  const updateKeyframePose = (id: number): void => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    stopPlayback();
    // "Update pose" means: overwrite with the camera currently on screen.
    viewer.setCinematic(false);
    const result = track.update(id, viewer.capturePose());
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setTrack(result.track);
    setNotice({ kind: 'info', text: `关键帧 #${id} 的姿态已更新为当前相机` });
  };

  const editKeyframeTime = (id: number, raw: string): void => {
    setTimeDrafts((drafts) => ({ ...drafts, [id]: raw }));
    if (raw.trim() === '') return;
    const time = Number(raw);
    if (!Number.isFinite(time)) return;
    const result = track.update(id, { time });
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setTrack(result.track);
    setTimeDrafts((drafts) => {
      const copy = { ...drafts };
      delete copy[id];
      return copy;
    });
    setNotice(null);
    if (viewerRef.current?.isCinematic) {
      showPose(result.track, Math.min(currentTimeRef.current, result.track.duration));
    }
  };

  const removeKeyframe = (id: number): void => {
    const result = track.remove(id);
    if (!result.ok) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    setTrack(result.track);
    setCurrentTime((time) => Math.min(time, result.track.duration));
    setNotice({ kind: 'info', text: '关键帧已删除' });
  };

  const scrubTo = (raw: number): void => {
    if (!track.isPlayable) return;
    stopPlayback();
    enterCinematic();
    const time = playerRef.current?.scrub(track, raw) ?? 0;
    setCurrentTime(time);
  };

  const togglePlay = (): void => {
    if (!track.isPlayable || exportingRef.current) return;
    const player = playerRef.current;
    if (!player) return;
    if (playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    enterCinematic();
    const from = currentTime >= track.duration ? 0 : currentTime;
    setCurrentTime(from);
    player.play(track, from);
    setPlaying(true);
  };

  const backToFreeNav = (): void => {
    stopPlayback();
    viewerRef.current?.setCinematic(false);
    setNotice({ kind: 'info', text: '已返回自由浏览，镜头轨道保留' });
  };

  const startExport = (): void => {
    const viewer = viewerRef.current;
    if (!viewer || !track.isPlayable || exporting) return;
    stopPlayback();
    setExporting(true);
    setProgress({ completed: 0, total: 0 });
    setNotice({ kind: 'info', text: '正在离线渲染与编码，期间场景与轨道保持不变…' });
    const handle = exportTrack(viewer, track, setProgress);
    exportHandleRef.current = handle;
    handle.promise
      .then((blob) => {
        downloadBlob(blob, `gaussian-shot-${Date.now()}.webm`);
        setNotice({ kind: 'info', text: '导出完成，已开始下载 1280×720 VP8/WebM 视频' });
        // Restore view to the authored final pose after successful export.
        viewerRef.current?.setCinematic(true);
        showPose(trackRef.current, trackRef.current.duration);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'ExportCanceledError') {
          setNotice({ kind: 'info', text: '导出已取消，编码资源已释放，已恢复原相机与画布尺寸' });
        } else {
          setNotice({
            kind: 'error',
            text: `导出失败，已恢复原相机与画布尺寸：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      })
      .finally(() => {
        setExporting(false);
        exportHandleRef.current = null;
        setProgress({ completed: 0, total: 0 });
      });
  };

  const duration = track.duration;
  const percent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <section className="timeline">
      <div className="timeline-head">
        <span className="timeline-title">镜头编排</span>
        <span className="timeline-hint">
          {track.frames.length} 个关键帧 · 总时长 {formatTime(duration)} · 至少两帧可播放/导出
        </span>
      </div>

      <div className="timeline-row">
        <button type="button" onClick={captureKeyframe} disabled={exporting}>
          记录当前镜头
        </button>
        <button type="button" onClick={togglePlay} disabled={!track.isPlayable || exporting}>
          {playing ? '暂停' : '播放'}
        </button>
        <button type="button" onClick={backToFreeNav} disabled={exporting}>
          返回自由浏览
        </button>
        <button type="button" onClick={startExport} disabled={!track.isPlayable || exporting}>
          导出 {EXPORT_WIDTH}×{EXPORT_HEIGHT} VP8/WebM
        </button>
        {exporting && (
          <button type="button" onClick={() => exportHandleRef.current?.cancel()}>
            取消导出
          </button>
        )}
      </div>

      <div className="timeline-row scrubber-row">
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(duration, 1 / EXPORT_FPS)}
          step={1 / EXPORT_FPS}
          value={Math.min(currentTime, Math.max(duration, 1 / EXPORT_FPS))}
          disabled={!track.isPlayable || exporting}
          onChange={(event) => scrubTo(Number(event.target.value))}
        />
        <span className="timeline-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <span className="timeline-percent">{percent.toFixed(0)}%</span>
      </div>

      {exporting && (
        <div className="export-progress">
          离线渲染与编码 {progress.completed}/{progress.total} 帧（
          {progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0}%），
          可随时取消
        </div>
      )}

      {notice && <div className={`timeline-message ${notice.kind}`}>{notice.text}</div>}

      {track.frames.length === 0 ? (
        <div className="timeline-empty">
          先用自由浏览调整好视角，点击“记录当前镜头”建立首帧（固定为 0s），再移动相机并继续记录，
          即可用时间轴播放预览或导出短片。
        </div>
      ) : (
        <ol className="keyframe-list">
          {track.frames.map((frame: ShotKeyframe, index) => (
            <li key={frame.id} className="keyframe-item">
              <span className="keyframe-index">#{index + 1}</span>
              <label>
                时间(s)
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  value={timeDrafts[frame.id] ?? frame.time}
                  disabled={exporting}
                  onChange={(event) => editKeyframeTime(frame.id, event.target.value)}
                />
              </label>
              <span className="keyframe-fov">FOV {frame.fov.toFixed(1)}°</span>
              <button
                type="button"
                onClick={() => updateKeyframePose(frame.id)}
                disabled={exporting}
              >
                更新姿态
              </button>
              <button
                type="button"
                onClick={() => removeKeyframe(frame.id)}
                disabled={exporting}
              >
                删除
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
