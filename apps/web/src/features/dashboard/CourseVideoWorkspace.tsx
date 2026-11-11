import type {
  CourseVideoCourseDetail,
  CourseVideoCourseSummary,
  CreatorArtifact,
  CreatorJson,
  CreatorStageRun
} from '@opencreator/protocol';
import { Download, Film, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalizedCopy } from '../../i18n/useLocalizedCopy.js';
import NativeSelect from '../../components/forms/NativeSelect.js';
import CreatorToolShell from './CreatorToolShell.js';
import {
  captureCreatorClientFailure,
  createCreatorArtifactObjectUrl,
  useOptionalCreatorSession
} from './creator-session-store.js';

const COURSE_VIDEO_STAGES = ['import', 'plan', 'narration', 'presenter', 'render', 'deliver'] as const;
type CourseVideoStage = typeof COURSE_VIDEO_STAGES[number];

const ratios: Array<{ value: '16:9' | '9:16'; zh: string; en: string }> = [
  { value: '16:9', zh: '横屏 16:9', en: 'Landscape 16:9' },
  { value: '9:16', zh: '竖屏 9:16', en: 'Portrait 9:16' }
];

const courseVideoVoices = [
  'en-US-AvaNeural',
  'en-US-AndrewNeural',
  'en-US-JennyNeural',
  'en-US-GuyNeural',
  'en-GB-SoniaNeural',
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-YunxiNeural',
  'zh-TW-HsiaoChenNeural',
  'ja-JP-NanamiNeural',
  'ko-KR-SunHiNeural'
];

export default function CourseVideoWorkspace(props: {
  onBack(): void;
  promptHint?: string;
}) {
  const l = useLocalizedCopy();
  const session = useOptionalCreatorSession();
  const [courseSlug, setCourseSlug] = useState(() => readString(session?.state.courseSlug));
  const [moduleKey, setModuleKey] = useState(() => readString(session?.state.moduleKey));
  const [ratio, setRatio] = useState<'16:9' | '9:16'>(() => readRatio(session?.state.ratio));
  const [voice, setVoice] = useState(() => readString(session?.state.voice) || 'en-US-AvaNeural');
  const [rate, setRate] = useState(() => readString(session?.state.rate) || '-4%');
  const [presenterEnabled, setPresenterEnabled] = useState(() => session?.state.presenterEnabled !== false);
  const [portraitPath, setPortraitPath] = useState(() => readString(session?.state.portraitPath));
  const [courses, setCourses] = useState<CourseVideoCourseSummary[]>([]);
  const [courseDetail, setCourseDetail] = useState<CourseVideoCourseDetail>();
  const [coursesLoading, setCoursesLoading] = useState(false);
  const [courseLoading, setCourseLoading] = useState(false);
  const [courseCatalogError, setCourseCatalogError] = useState('');
  const [courseReload, setCourseReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pipelineActive, setPipelineActive] = useState(false);
  const dispatchedRef = useRef<CourseVideoStage | null>(null);

  const result = useMemo(
    () => latestCompleted(session?.job.artifacts ?? [], 'course-video'),
    [session?.job.artifacts]
  );
  const videoUrl = useArtifactUrl(result?.id);
  const latest = latestStage(session?.job.stages ?? [], 'render');
  const rendering = pipelineActive || latest?.status === 'queued' || latest?.status === 'running';
  const runtimeError = latest?.status === 'failed'
    ? renderError(latest.errorCode, l)
    : session?.error ? renderError(session.error.code, l) : '';
  const visibleError = error || runtimeError;

  useEffect(() => {
    setCourseSlug(readString(session?.state.courseSlug));
    setModuleKey(readString(session?.state.moduleKey));
    setRatio(readRatio(session?.state.ratio));
    setVoice(readString(session?.state.voice) || 'en-US-AvaNeural');
    setRate(readString(session?.state.rate) || '-4%');
    setPresenterEnabled(session?.state.presenterEnabled !== false);
    setPortraitPath(readString(session?.state.portraitPath));
  }, [
    session?.state.courseSlug,
    session?.state.moduleKey,
    session?.state.ratio,
    session?.state.voice,
    session?.state.rate,
    session?.state.presenterEnabled,
    session?.state.portraitPath
  ]);

  const listCourses = session?.listCourseVideoCourses;
  const getCourse = session?.getCourseVideoCourse;

  useEffect(() => {
    if (listCourses === undefined) return;
    let active = true;
    setCoursesLoading(true);
    setCourseCatalogError('');
    void listCourses()
      .then(result => { if (active) setCourses(result.courses); })
      .catch(cause => {
        if (!active) return;
        setCourseCatalogError(cause instanceof Error && cause.message.trim().length > 0
          ? cause.message
          : l('无法读取课程列表', 'Could not load courses'));
      })
      .finally(() => { if (active) setCoursesLoading(false); });
    return () => { active = false; };
  }, [listCourses, courseReload, l]);

  useEffect(() => {
    if (getCourse === undefined || courseSlug.trim().length === 0) {
      setCourseDetail(current => current === undefined ? current : undefined);
      return;
    }
    let active = true;
    setCourseLoading(true);
    void getCourse(courseSlug.trim())
      .then(detail => { if (active) setCourseDetail(detail); })
      .catch(() => { if (active) setCourseDetail(undefined); })
      .finally(() => { if (active) setCourseLoading(false); });
    return () => { active = false; };
  }, [getCourse, courseSlug]);

  // The daemon does not auto-dispatch `dependsOn`, so drive the linear graph here:
  // run the first stage that has no completed run, one at a time.
  useEffect(() => {    if (!pipelineActive || session === null) return;
    const stages = session.job.stages;
    const next = COURSE_VIDEO_STAGES.find(stageId => latestStage(stages, stageId)?.status !== 'succeeded');
    if (next === undefined) {
      setPipelineActive(false);
      dispatchedRef.current = null;
      setNotice(l('课程视频已生成', 'Course video generated'));
      return;
    }
    const run = latestStage(stages, next);
    if (run?.status === 'failed') {
      setPipelineActive(false);
      dispatchedRef.current = null;
      return;
    }
    if (run?.status === 'queued' || run?.status === 'running') return;
    if (dispatchedRef.current === next) return;
    dispatchedRef.current = next;
    void session.applyAction({
      actor: 'user',
      action: 'run-stage',
      input: { stageId: next }
    }).catch(() => {
      dispatchedRef.current = null;
      setPipelineActive(false);
    });
  }, [pipelineActive, session, session?.job.stages, session?.job.revision, l]);

  function selectCourse(value: string) {
    if (value === '__manual__') {
      setCourseSlug('');
      setModuleKey('');
      setCourseDetail(undefined);
      setError('');
      return;
    }
    setCourseSlug(value);
    setModuleKey('');
    setError('');
  }

  async function generate() {
    if (rendering || session === null) {
      if (session === null) {
        setError(l('课程视频服务暂不可用，请检查 Runtime 连接', 'Course video is unavailable. Check the Runtime connection.'));
      }
      return;
    }
    if (!courseSlug.trim()) {
      setError(l('请先填写 bb_exam 课程标识（slug）', 'Enter the bb_exam course slug first'));
      return;
    }
    setError('');
    setNotice('');
    session.updateDraft({
      courseSlug: courseSlug.trim(),
      moduleKey: moduleKey.trim(),
      ratio,
      voice: voice.trim(),
      rate: rate.trim(),
      presenterEnabled,
      portraitPath: portraitPath.trim()
    }, { semantic: true });
    dispatchedRef.current = null;
    try {
      await session.flush();
      setPipelineActive(true);
    } catch {}
  }

  function downloadResult() {
    if (session === null || result === undefined) return;
    void captureCreatorClientFailure(
      session,
      'course-video.download',
      l('视频下载失败，请稍后重试。', 'The video download failed. Try again later.'),
      async () => {
        const url = await createCreatorArtifactObjectUrl(session, result.id, 'course-video.download', l('视频下载失败', 'Video download failed'));
        const link = document.createElement('a');
        link.href = url;
        link.download = readString(result.metadata.fileName) || 'course-lesson.mp4';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    ).then(() => setNotice(l('视频文件已开始下载', 'The video download has started'))).catch(() => undefined);
  }

  const selectedRatio = ratios.find(item => item.value === ratio) ?? ratios[0]!;
  const courseSelectValue = courses.some(course => course.slug === courseSlug)
    ? courseSlug
    : '__manual__';
  return (
    <CreatorToolShell
      title={l('课程视频', 'Course Video')}
      subtitle={l('把 bb_exam 已发布课程生成为带旁白的课程视频', 'Turn a published bb_exam course into a narrated lesson video')}
      context={result
        ? readString(result.metadata.moduleTitle) || l('课程视频已生成', 'Course video ready')
        : rendering
          ? l('正在生成课程视频', 'Generating course video')
          : `${courseSlug || l('未选择课程', 'No course')} · ${l(selectedRatio.zh, selectedRatio.en)}`}
      stepLabel={rendering ? l('正在生成课程视频', 'Generating course video') : l('课程视频', 'Course video')}
      currentIssue={visibleError || undefined}
      suggestions={result
        ? [l('调整旁白语速', 'Adjust the narration rate'), l('改用竖屏输出', 'Switch to portrait output')]
        : [l('选择要生成视频的课程模块', 'Choose the course module to render')]}
      placeholder={props.promptHint ?? l(
        '描述要调整的课程、模块、旁白或画幅',
        'Describe changes to the course, module, narration, or format'
      )}
      onBack={props.onBack}
      pageClassName="course-video-workspace-page"
    >
      <div className="creator-tool-stack course-video-stack">
        <section className="creator-tool-panel" aria-labelledby="course-video-settings-title">
          <div className="creator-tool-panel-heading">
            <div>
              <h2 id="course-video-settings-title">{l('课程设置', 'Course settings')}</h2>
              <p>{l('选择 bb_exam 已发布课程与目标模块', 'Choose a published bb_exam course and target module')}</p>
            </div>
          </div>
          <div className="course-video-fields">
            <label className="creator-tool-field">
              <span>{l('课程', 'Course')}</span>
              <NativeSelect
                aria-label={l('课程', 'Course')}
                value={courseSelectValue}
                onChange={event => selectCourse(event.target.value)}
                disabled={coursesLoading}
              >
                {coursesLoading ? <option value="__manual__">{l('正在读取课程…', 'Loading courses…')}</option> : null}
                {!coursesLoading && courses.length === 0 ? (
                  <option value="__manual__">{l('手动输入课程标识', 'Enter course slug manually')}</option>
                ) : null}
                {courses.map(course => (
                  <option key={course.slug} value={course.slug}>
                    {course.title}{course.moduleCount === undefined ? '' : ` · ${course.moduleCount} ${l('个模块', 'modules')}`}
                  </option>
                ))}
                <option value="__manual__">{l('手动输入课程标识', 'Enter course slug manually')}</option>
              </NativeSelect>
            </label>
            {courseSelectValue === '__manual__' ? (
              <label className="creator-tool-field">
                <span>{l('课程标识（slug）', 'Course slug')}</span>
                <input
                  value={courseSlug}
                  maxLength={120}
                  onChange={event => { setCourseSlug(event.target.value); setError(''); }}
                  placeholder="understanding-behavior"
                />
              </label>
            ) : null}
            {courseDetail !== undefined ? (
              <label className="creator-tool-field">
                <span>{l('模块', 'Module')} <small>{courseDetail.modules.length} {l('个模块', 'modules')}</small></span>
                <NativeSelect
                  aria-label={l('模块', 'Module')}
                  value={moduleKey}
                  onChange={event => { setModuleKey(event.target.value); setError(''); }}
                  disabled={courseLoading}
                >
                  <option value="">{l('首个模块', 'First module')}</option>
                  {courseDetail.modules.map(module => (
                    <option key={module.moduleKey} value={module.moduleKey}>{module.title}</option>
                  ))}
                </NativeSelect>
              </label>
            ) : (
              <label className="creator-tool-field">
                <span>{l('模块', 'Module')} <small>{l('留空取首个模块', 'Blank uses the first module')}</small></span>
                <input
                  value={moduleKey}
                  maxLength={120}
                  onChange={event => { setModuleKey(event.target.value); setError(''); }}
                  placeholder="m01"
                />
              </label>
            )}
            {courseCatalogError ? (
              <p className="creator-tool-notice" role="status">{courseCatalogError}</p>
            ) : null}
            {courseDetail ? (
              <p className="creator-tool-notice" role="status">
                {l(`课程：${courseDetail.title}`, `Course: ${courseDetail.title}`)}
              </p>
            ) : null}
            <div className="course-video-options">
              <label className="creator-tool-field">
                <span>{l('输出画幅', 'Output format')}</span>
                <NativeSelect
                  aria-label={l('输出画幅', 'Output format')}
                  value={ratio}
                  onChange={event => setRatio(readRatio(event.target.value))}
                >
                  {ratios.map(item => (
                    <option key={item.value} value={item.value}>{l(item.zh, item.en)}</option>
                  ))}
                </NativeSelect>
              </label>
              <label className="creator-tool-field">
                <span>{l('旁白音色', 'Narration voice')}</span>
                <input
                  value={voice}
                  maxLength={120}
                  list="course-video-voices"
                  onChange={event => setVoice(event.target.value)}
                  placeholder="en-US-AvaNeural"
                />
              </label>
              <datalist id="course-video-voices">
                {courseVideoVoices.map(value => <option key={value} value={value} />)}
              </datalist>
              <label className="creator-tool-field">
                <span>{l('语速', 'Speaking rate')}</span>
                <input
                  value={rate}
                  maxLength={20}
                  onChange={event => setRate(event.target.value)}
                  placeholder="-4%"
                />
              </label>
              <label className="creator-tool-field">
                <span>{l('数字人', 'Presenter')}</span>
                <NativeSelect
                  aria-label={l('数字人', 'Presenter')}
                  value={presenterEnabled ? 'on' : 'off'}
                  onChange={event => setPresenterEnabled(event.target.value === 'on')}
                >
                  <option value="on">{l('生成数字人', 'Generate presenter')}</option>
                  <option value="off">{l('不生成数字人', 'No presenter')}</option>
                </NativeSelect>
              </label>
              {presenterEnabled ? (
                <label className="creator-tool-field">
                  <span>{l('数字人肖像路径（可选）', 'Presenter portrait path (optional)')}</span>
                  <input
                    value={portraitPath}
                    maxLength={1024}
                    onChange={event => setPortraitPath(event.target.value)}
                    placeholder="/path/to/portrait.png"
                  />
                </label>
              ) : null}
            </div>
            {!presenterEnabled ? (
              <p className="creator-tool-notice" role="status">
                {l('已关闭数字人，视频只保留课件与旁白。', 'Presenter is off; the video keeps the lesson and narration only.')}
              </p>
            ) : null}
          </div>
          <div className="creator-tool-actions">
            <button
              className="creator-tool-secondary"
              type="button"
              onClick={() => setCourseReload(value => value + 1)}
              disabled={coursesLoading || rendering}
            >
              <RotateCcw size={15} strokeWidth={1.8} aria-hidden="true" />
              {l('刷新课程', 'Refresh courses')}
            </button>
            <button type="button" onClick={() => void generate()} disabled={rendering}>
              {rendering
                ? <LoaderCircle className="course-video-spinner" size={16} strokeWidth={1.8} aria-hidden="true" />
                : result
                  ? <RotateCcw size={16} strokeWidth={1.8} aria-hidden="true" />
                  : <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />}
              {rendering
                ? l('正在生成', 'Generating')
                : result
                  ? l('重新生成', 'Regenerate')
                  : l('生成课程视频', 'Generate course video')}
            </button>
          </div>
        </section>

        <section className="creator-tool-panel course-video-result-panel" aria-labelledby="course-video-result-title">
          <div className="creator-tool-panel-heading">
            <div>
              <h2 id="course-video-result-title">{l('视频结果', 'Video result')}</h2>
              <p>{result
                ? l('可以预览或下载课程视频', 'Preview or download the course video')
                : l('完成课程设置后开始生成', 'Complete the settings to generate a video')}</p>
            </div>
          </div>
          {videoUrl ? (
            <>
              <video controls preload="metadata" aria-label={l('课程视频预览', 'Course video preview')} src={videoUrl} />
              <div className="creator-tool-actions course-video-result-actions">
                <button className="creator-tool-primary" type="button" onClick={downloadResult}>
                  <Download size={15} strokeWidth={1.8} aria-hidden="true" />
                  {l('下载视频', 'Download video')}
                </button>
              </div>
            </>
          ) : (
            <div className="course-video-empty" aria-live="polite">
              {rendering
                ? <LoaderCircle className="course-video-spinner" size={22} strokeWidth={1.7} aria-hidden="true" />
                : <Film size={22} strokeWidth={1.7} aria-hidden="true" />}
              <span>{rendering ? l('正在生成课程视频', 'Generating course video') : l('还没有生成课程视频', 'No course video generated yet')}</span>
            </div>
          )}
        </section>

        {error ? (
          <div className="course-video-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? <p className="creator-tool-notice" role="status">{notice}</p> : null}
      </div>
    </CreatorToolShell>
  );
}

function useArtifactUrl(artifactId?: string): string {
  const session = useOptionalCreatorSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const jobId = session?.job.id;
  const [loaded, setLoaded] = useState<{ jobId: string; artifactId: string; url: string }>();
  useEffect(() => {
    let objectUrl = '';
    let canceled = false;
    if (artifactId === undefined || jobId === undefined || sessionRef.current === null) {
      return () => { canceled = true; };
    }
    void createCreatorArtifactObjectUrl(
      sessionRef.current,
      artifactId,
      'course-video.load-preview',
      'Could not load the video preview. Try again later.'
    ).then(url => {
      if (canceled) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setLoaded({ jobId, artifactId, url: objectUrl });
    }).catch(() => undefined);
    return () => { canceled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, jobId]);
  return loaded !== undefined && loaded.jobId === jobId && loaded.artifactId === artifactId
    ? loaded.url
    : '';
}

function latestCompleted(artifacts: CreatorArtifact[], kind: string): CreatorArtifact | undefined {
  return [...artifacts].reverse().find(artifact => artifact.kind === kind && artifact.status === 'completed');
}

function latestStage(stages: CreatorStageRun[], stageId: string): CreatorStageRun | undefined {
  return [...stages].reverse().find(stage => stage.stageId === stageId);
}

function readRatio(value: CreatorJson | undefined): '16:9' | '9:16' {
  return value === '9:16' ? '9:16' : '16:9';
}

function readString(value: CreatorJson | undefined): string {
  return typeof value === 'string' ? value : '';
}

function renderError(
  code: string | null,
  l: (zh: string, en: string) => string
): string {
  if (code === 'course_source_unconfigured') {
    return l('请先配置 bb_exam 课程来源地址与访问令牌', 'Configure the bb_exam source URL and token first');
  }
  if (code === 'creator_tts_runtime_unavailable') {
    return l('本地语音合成不可用，请检查 edge-tts 是否安装', 'Local speech synthesis is unavailable. Check that edge-tts is installed.');
  }
  if (code === 'course_slug_missing') {
    return l('请填写课程标识（slug）', 'Enter the course slug');
  }
  return l('课程视频生成失败，请在 Agent 区域查看诊断后重试', 'Course video generation failed. Review the diagnosis in the Agent panel and retry.');
}
