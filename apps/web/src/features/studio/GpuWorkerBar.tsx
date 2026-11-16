import type { StudioWorkerStatus } from '@opencreator/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import type { StudioService } from '../../services/studio-service.js';
import './gpu-worker.css';

type WorkerService = Pick<StudioService, 'worker' | 'startWorker' | 'stopWorker'>;

export function GpuWorkerBar({ service, refreshSignal = 0, onWorkerChange }: {
  service: WorkerService | null;
  refreshSignal?: number;
  onWorkerChange?: () => void;
}) {
  const l = useLocalizedCopy();
  const [worker, setWorker] = useState<StudioWorkerStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const delayedRefresh = useRef<number>();
  const generation = useRef(0);
  const request = useRef(0);
  const lastStatus = useRef<string>();

  const refresh = useCallback(async (force = false) => {
    if (service === null) return;
    const currentGeneration = generation.current;
    const currentRequest = ++request.current;
    try {
      const status = await service.worker(force);
      if (mounted.current && generation.current === currentGeneration && request.current === currentRequest) {
        const signature = [status.comfyui.online, status.avatar.online, status.llm.online, status.unslothVideo.online].join(',');
        if (lastStatus.current !== undefined && lastStatus.current !== signature) onWorkerChange?.();
        lastStatus.current = signature;
        setWorker(status);
        setStatusError('');
      }
    } catch (cause) {
      if (mounted.current && generation.current === currentGeneration && request.current === currentRequest) {
        setStatusError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [service, onWorkerChange]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    lastStatus.current = undefined;
    setWorker(undefined);
    setStatusError('');
    setBusy(false);
    if (service !== null) void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.clearInterval(timer);
      window.clearTimeout(delayedRefresh.current);
    };
  }, [service, refresh]);

  useEffect(() => {
    if (refreshSignal > 0) void refresh(true);
  }, [refresh, refreshSignal]);

  async function control(action: 'start' | 'stop') {
    if (service === null) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = action === 'start' ? await service.startWorker() : await service.stopWorker();
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (!result.ok) {
        const detail = Object.values(result.steps).filter(step => !step.ok).map(step => step.detail).filter(Boolean).join('; ');
        setError(detail || l('GPU 工作站操作失败', 'GPU worker action failed'));
        return;
      }
      setNotice(action === 'start'
        ? l('启动请求已发送，请查看服务状态。', 'Start requested; check the service status.')
        : l('停止请求已发送。', 'Stop requested.'));
      window.clearTimeout(delayedRefresh.current);
      delayedRefresh.current = window.setTimeout(() => void refresh(true), action === 'start' ? 8_000 : 1_500);
    } catch (cause) {
      if (mounted.current && generation.current === currentGeneration) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && generation.current === currentGeneration) setBusy(false);
    }
  }

  if (service === null) return null;
  const chips: Array<[string, boolean]> = worker === undefined ? [] : [
    ['ComfyUI', worker.comfyui.online],
    [l('本地视频模型', 'Local video model'), worker.unslothVideo.online],
    [l('数字人服务', 'Avatar service'), worker.avatar.online],
    [l('本地 LLM', 'Local LLM'), worker.llm.online]
  ];
  return (
    <div className="studio__worker" aria-label={l('GPU 工作站', 'GPU worker')}>
      <span className="studio__worker-title">{l('GPU 工作站', 'GPU worker')}</span>
      {worker === undefined && !statusError ? <span>{l('正在检查…', 'Checking…')}</span> : null}
      {chips.map(([label, online]) => (
        <span key={label} className="studio__chip">
          <span className={online ? 'studio__dot studio__dot--on' : 'studio__dot'} /> {label}
          <span className="gpu-worker__sr-only">{online ? l('在线', 'online') : l('离线', 'offline')}</span>
          {label === 'ComfyUI' && worker?.comfyui.vramFreeGb !== undefined ? ` · ${worker.comfyui.vramFreeGb} GB` : ''}
        </span>
      ))}
      <span className="studio__worker-actions">
        {worker?.canControl ? <>
          <button type="button" className="studio__button" disabled={busy || worker.comfyui.online} onClick={() => void control('start')}>{l('启动', 'Start')}</button>
          <button type="button" className="studio__button" disabled={busy || !worker.comfyui.online} onClick={() => void control('stop')}>{l('停止', 'Stop')}</button>
        </> : null}
        <button type="button" className="studio__button" onClick={() => void refresh(true)}>{l('重新检查', 'Recheck')}</button>
      </span>
      {error ? <span className="gpu-worker__message" role="alert">{error}</span> : null}
      {statusError ? <span className="gpu-worker__message" role="alert">{l('状态不可用：', 'Status unavailable: ')}{statusError}</span> : null}
      {notice ? <span className="gpu-worker__message" role="status">{notice}</span> : null}
    </div>
  );
}
