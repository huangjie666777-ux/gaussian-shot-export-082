import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSplat, SplatParseError, type SplatData } from '../splat/parser';
import { SplatViewer, type ViewerStats } from '../viewer/SplatViewer';
import { TimelinePanel } from './TimelinePanel';
import './app.css';

type Status = 'idle' | 'loading' | 'ready' | 'error';

const BUILTIN_SCENES = [{ name: '吉他 Guitar', url: '/scenes/guitar.splat' }];

export function App(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<SplatViewer | null>(null);
  const loadTokenRef = useRef(0);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sceneName, setSceneName] = useState<string>('');
  const [stats, setStats] = useState<ViewerStats>({ count: 0, visible: 0 });

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new SplatViewer(canvasRef.current, setStats);
    viewerRef.current = viewer;
    void loadFromUrl(BUILTIN_SCENES[0].name, BUILTIN_SCENES[0].url);
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyScene = useCallback((name: string, data: SplatData): void => {
    setSceneName(name);
    setStats({ count: data.count, visible: 0 });
    viewerRef.current?.setScene(data);
  }, []);

  const loadFromUrl = useCallback(
    async (name: string, url: string): Promise<void> => {
      const token = ++loadTokenRef.current;
      setStatus('loading');
      setError(null);
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`内置场景加载失败（HTTP ${response.status}）`);
        const buffer = await response.arrayBuffer();
        if (token !== loadTokenRef.current) return; // a newer load won
        const data = parseSplat(buffer);
        if (token !== loadTokenRef.current) return;
        applyScene(name, data);
        setStatus('ready');
      } catch (caught) {
        if (token !== loadTokenRef.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('error');
      }
    },
    [applyScene],
  );

  const onFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const token = ++loadTokenRef.current;
      setStatus('loading');
      setError(null);
      try {
        const buffer = await file.arrayBuffer();
        if (token !== loadTokenRef.current) return;
        const data = parseSplat(buffer);
        if (token !== loadTokenRef.current) return;
        applyScene(file.name, data);
        setStatus('ready');
      } catch (caught) {
        if (token !== loadTokenRef.current) return;
        const message =
          caught instanceof SplatParseError
            ? `文件已拒绝，当前场景保持不变：${caught.message}`
            : caught instanceof Error
              ? caught.message
              : String(caught);
        setError(message);
        setStatus('error');
      }
    },
    [applyScene],
  );

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">3D Gaussian Splatting 浏览器</div>
        <div className="actions">
          {BUILTIN_SCENES.map((scene) => (
            <button
              key={scene.url}
              type="button"
              onClick={() => void loadFromUrl(scene.name, scene.url)}
              disabled={status === 'loading'}
            >
              内置：{scene.name}
            </button>
          ))}
          <label className="file-button">
            打开本地 .splat
            <input type="file" accept=".splat,application/octet-stream" onChange={onFile} hidden />
          </label>
          <button type="button" onClick={() => viewerRef.current?.fit()}>
            适配全景
          </button>
          <button type="button" onClick={() => viewerRef.current?.resetView()}>
            重置视角
          </button>
        </div>
      </header>
      <div className="workspace">
        <main className="stage">
          <canvas ref={canvasRef} className="splat-canvas" />
          <div className="hud">
            <div>左键旋转 · 右键平移 · 滚轮缩放</div>
            <div>
              {sceneName && <span>场景：{sceneName} · </span>}
              高斯 {stats.count.toLocaleString()} 个 · 可见 {stats.visible.toLocaleString()} 个
            </div>
            {status === 'loading' && <div className="status loading">正在加载与解析场景…</div>}
            {status === 'error' && error && <div className="status error">{error}</div>}
            {status === 'idle' && <div className="status">等待加载场景</div>}
          </div>
        </main>
        <TimelinePanel viewerRef={viewerRef} />
      </div>
    </div>
  );
}
