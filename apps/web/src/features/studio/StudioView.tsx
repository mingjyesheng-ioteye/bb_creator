import type {
  StudioCapabilitiesResponse,
  StudioJob
} from '@opencreator/protocol';
import { studioCapabilityGroups } from '@opencreator/protocol';
import { CircleAlert, LoaderCircle, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import type { CreatorWebService } from '../../services/creator-service.js';
import type { StudioService } from '../../services/studio-service.js';
import { GpuWorkerBar } from './GpuWorkerBar.js';
import { InstructorView } from './InstructorView.js';
import './studio.css';

export type StudioViewProps = {
  service: StudioService | null;
  courseService?: Pick<CreatorWebService, 'listCourseVideoCourses' | 'getCourseVideoCourse'> | null;
};

const ACTIVE = new Set<StudioJob['status']>(['queued', 'running']);

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function StudioView(props: StudioViewProps) {
  const l = useLocalizedCopy();
  const { service } = props;
  const [tab, setTab] = useState<'media' | 'instructor'>('media');
  const [catalog, setCatalog] = useState<StudioCapabilitiesResponse>();
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [selectedId, setSelectedId] = useState('cinematic');
  const [prompt, setPrompt] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [workerRefresh, setWorkerRefresh] = useState(0);

  const selected = useMemo(
    () => catalog?.capabilities.find(entry => entry.id === selectedId),
    [catalog, selectedId]
  );

  const refresh = useCallback(async (force = false) => {
    if (service === null) return;
    try {
      const [nextCatalog, nextJobs] = await Promise.all([
        service.capabilities(force), service.listJobs()
      ]);
      setCatalog(nextCatalog);
      setJobs(nextJobs);
      setError(undefined);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [service]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasActive = jobs.some(job => ACTIVE.has(job.status));
  useEffect(() => {
    if (service === null || !hasActive) return undefined;
    const timer = window.setInterval(() => {
      void service.listJobs().then(setJobs).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [service, hasActive]);

  useEffect(() => {
    setValues({});
    setFile(undefined);
  }, [selectedId]);

  async function submit() {
    if (service === null || selected === undefined) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const upload = file === undefined ? undefined : await service.upload(file);
      const params: Record<string, string | number> = {};
      for (const param of selected.params) {
        const raw = values[param.name];
        if (raw === undefined || raw === '') continue;
        params[param.name] = param.type === 'number' ? Number(raw) : raw;
      }
      const job = await service.createJob({
        capability: selected.id,
        prompt,
        ...(upload === undefined ? {} : { uploadId: upload.id }),
        params
      });
      setJobs(current => [job, ...current.filter(entry => entry.id !== job.id)]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  }

  const needsFile = selected !== undefined && selected.input !== 'none';
  const canRun = selected !== undefined && selected.runnable
    && (!selected.promptRequired || prompt.trim().length > 0)
    && (!selected.inputRequired || file !== undefined) && !submitting;

  return (
    <section className="studio">
      <div className="studio__inner">
        <header className="studio__header">
          <div>
            <h1>{l('特别关怀工作室', 'Special Care Studio')}</h1>
            <p className="studio__muted">
              {tab === 'instructor'
                ? l('小班课堂控制台：出勤、进度与计时。', 'Instructor-led classroom console: attendance, progress and timing.')
                : l('本地生成、剪辑、配音与再创作，全部在本机运行。', 'Generate, edit, narrate and repurpose media. Everything runs on this machine.')}
            </p>
          </div>
          <div className="studio__header-actions">
            <div className="studio__tabs" role="tablist" aria-label={l('工坊模式', 'Studio mode')}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'media'}
                className={tab === 'media' ? 'studio__tab studio__tab--active' : 'studio__tab'}
                onClick={() => setTab('media')}
              >
                {l('媒体', 'Media')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'instructor'}
                className={tab === 'instructor' ? 'studio__tab studio__tab--active' : 'studio__tab'}
                onClick={() => setTab('instructor')}
              >
                {l('课堂', 'Instructor')}
              </button>
            </div>
            {tab === 'media' ? (
              <button type="button" className="studio__button" onClick={() => { void refresh(true); setWorkerRefresh(value => value + 1); }}>
                <RefreshCw size={14} /> {l('刷新', 'Refresh')}
              </button>
            ) : null}
          </div>
        </header>

        {tab === 'instructor' ? (
          <InstructorView courseService={props.courseService} />
        ) : service === null ? (
          <p className="studio__muted">{l('本机 Runtime 就绪后可使用特别关怀工作室', 'Connect the local Runtime to use the Special Care Studio')}</p>
        ) : (
          <>
            {error === undefined ? null : (
              <div className="studio__alert" role="alert"><CircleAlert size={14} /> {error}</div>
            )}

            <GpuWorkerBar service={service} refreshSignal={workerRefresh} onWorkerChange={refresh} />

            <div className="studio__layout">
          <nav className="studio__catalog" aria-label={l('能力', 'Capabilities')}>
            {studioCapabilityGroups.map(group => {
              const entries = catalog?.capabilities.filter(entry => entry.group === group) ?? [];
              if (entries.length === 0) return null;
              return (
                <div key={group} className="studio__group">
                  <h2>{group}</h2>
                  {entries.map(entry => (
                    <button
                      key={entry.id}
                      type="button"
                      className="studio__card"
                      aria-pressed={entry.id === selectedId}
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <span className="studio__card-title">
                        {entry.title}
                        <span
                          className={entry.runnable ? 'studio__dot studio__dot--on' : 'studio__dot'}
                          role="img"
                          aria-label={entry.runnable ? l('可用', 'Ready') : l('不可用', 'Unavailable')}
                        />
                      </span>
                      <span className="studio__muted">{entry.blurb}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {catalog === undefined ? <p className="studio__muted"><LoaderCircle className="studio__spin" size={14} /> {l('加载中', 'Loading')}</p> : null}
          </nav>

          <div className="studio__work">
            {selected === undefined ? null : (
              <form
                className="studio__form"
                onSubmit={event => { event.preventDefault(); void submit(); }}
              >
                <h2>{selected.title}</h2>
                <p className="studio__muted">{selected.blurb}</p>
                {selected.runnable ? null : <p className="studio__warn">{selected.reason}</p>}
                {selected.promptRequired || selected.promptHint !== '' ? (
                  <label className="studio__field">
                    <span>{selected.id === 'documentary' ? l('搜索词（逗号分隔）', 'Search phrases (comma separated)') : l('提示词', 'Prompt')}</span>
                    <textarea
                      rows={4}
                      value={prompt}
                      placeholder={selected.promptHint}
                      maxLength={4000}
                      onChange={event => setPrompt(event.target.value)}
                    />
                  </label>
                ) : null}
                {needsFile ? (
                  <label className="studio__field">
                    <span>{selected.input === 'image' ? l('参考图片', 'Reference image') : l('输入视频', 'Input video')}{selected.inputRequired ? ' *' : ''}</span>
                    <input
                      type="file"
                      accept={selected.input === 'image' ? 'image/*' : 'video/*'}
                      onChange={event => setFile(event.target.files?.[0])}
                    />
                  </label>
                ) : null}
                {selected.params.map(param => (
                  <label key={param.name} className="studio__field">
                    <span>{param.label}</span>
                    {param.type === 'select' ? (
                      <select
                        value={values[param.name] ?? String(param.default ?? '')}
                        onChange={event => setValues(current => ({ ...current, [param.name]: event.target.value }))}
                      >
                        {(param.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input
                        type="number"
                        step="any"
                        {...(param.min === undefined ? {} : { min: param.min })}
                        {...(param.max === undefined ? {} : { max: param.max })}
                        value={values[param.name] ?? (param.default === undefined ? '' : String(param.default))}
                        onChange={event => setValues(current => ({ ...current, [param.name]: event.target.value }))}
                      />
                    )}
                  </label>
                ))}
                <div className="studio__actions">
                  <button type="submit" className="studio__button studio__button--primary" disabled={!canRun}>
                    {submitting ? <LoaderCircle className="studio__spin" size={14} /> : <Play size={14} />} {l('开始生成', 'Run')}
                  </button>
                </div>
              </form>
            )}

            <section className="studio__jobs" aria-label={l('任务', 'Jobs')}>
              <h2>{l('任务', 'Jobs')}</h2>
              {jobs.length === 0 ? <p className="studio__muted">{l('还没有任务', 'No jobs yet')}</p> : null}
              {jobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  service={service}
                  onCancel={() => void service.cancelJob(job.id)
                    .then(next => setJobs(current => current.map(entry => entry.id === next.id ? next : entry)))
                    .catch(cause => setError(messageOf(cause)))}
                  onDelete={() => void service.deleteJob(job.id)
                    .then(() => setJobs(current => current.filter(entry => entry.id !== job.id)))
                    .catch(cause => setError(messageOf(cause)))}
                />
              ))}
            </section>
          </div>
        </div>
          </>
        )}
      </div>
    </section>
  );
}

function JobCard(props: { job: StudioJob; service: StudioService; onCancel(): void; onDelete(): void }) {
  const l = useLocalizedCopy();
  const { job } = props;
  const active = ACTIVE.has(job.status);
  const [url, setUrl] = useState<string>();
  const loadedFor = useRef<string>();

  useEffect(() => {
    if (job.status !== 'done' || loadedFor.current === job.id) return undefined;
    loadedFor.current = job.id;
    let cancelled = false;
    let created: string | undefined;
    void props.service.mediaBlob(job.id).then(blob => {
      if (cancelled) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    }).catch(() => { loadedFor.current = undefined; });
    return () => {
      cancelled = true;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [job.id, job.status, props.service]);

  return (
    <article className="studio__job">
      <header>
        <strong>{job.title}</strong>
        <span className={`studio__status studio__status--${job.status}`}>{statusLabel(job.status, l)}</span>
      </header>
      <p className="studio__muted studio__prompt">{job.prompt}</p>
      {active ? (
        <div className="studio__progress">
          <LoaderCircle className="studio__spin" size={14} />
          <span>{job.message ?? l('等待中', 'Waiting')}</span>
          {job.percent === undefined ? null : <progress value={job.percent} max={100} />}
        </div>
      ) : null}
      {job.status === 'error' ? <p className="studio__warn">{job.error}</p> : null}
      {job.status === 'done' && url !== undefined ? (
        job.mediaKind === 'audio'
          ? <audio controls src={url} />
          : <video controls src={url} className="studio__video" />
      ) : null}
      <footer>
        {job.status === 'done' && url !== undefined && job.media !== undefined ? (
          <a className="studio__button" href={url} download={job.media.fileName}>{l('下载', 'Download')}</a>
        ) : null}
        {active
          ? <button type="button" className="studio__button" onClick={props.onCancel}><Square size={12} /> {l('取消', 'Cancel')}</button>
          : <button type="button" className="studio__button" onClick={props.onDelete}><Trash2 size={12} /> {l('删除', 'Delete')}</button>}
      </footer>
    </article>
  );
}

function statusLabel(status: StudioJob['status'], l: ReturnType<typeof useLocalizedCopy>): string {
  switch (status) {
    case 'queued': return l('排队中', 'Queued');
    case 'running': return l('进行中', 'Running');
    case 'done': return l('完成', 'Done');
    case 'cancelled': return l('已取消', 'Cancelled');
    case 'error': return l('失败', 'Failed');
  }
}
