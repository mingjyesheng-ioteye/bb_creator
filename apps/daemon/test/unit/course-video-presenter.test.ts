import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoursePresenterExecutor } from '../../src/creator/course-video/presenter-executor.js';
import type { GeneratePresenterClip } from '../../src/creator/course-video/presenter-executor.js';
import { applyAvatarClips } from '../../src/creator/course-video/render-executor.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function narratedLesson() {
  return {
    schemaVersion: '1',
    id: 'm01',
    brand: 'Arc Mercer',
    courseTitle: 'Understanding Behavior',
    moduleTitle: 'Functions',
    moduleIndex: 1,
    moduleTotal: 1,
    presenter: { mode: 'video', layout: 'pip-br', name: 'Instructor', role: 'Training Instructor', accentColor: '#FFD166' },
    slides: [
      { id: 'm01:title', kind: 'title', heading: 'Functions', bullets: [], narration: 'Intro', audioSrc: '/tmp/a0.mp3', durationInFrames: 90 },
      { id: 'm01:summary', kind: 'summary', heading: 'Summary', bullets: [], narration: 'Done', audioSrc: '/tmp/a1.mp3', durationInFrames: 60 }
    ]
  };
}

function job(state: Record<string, unknown>): CreatorJob {
  const now = new Date().toISOString();
  return {
    id: 'course-video-job', projectId: 'p', templateId: 'course-video', templateVersion: 1,
    status: 'running', revision: 0, state: state as CreatorJob['state'], agentThreadId: null,
    stages: [], artifacts: [], providerRequests: [], activities: [], createdAt: now, updatedAt: now
  };
}

function stageRun(): CreatorStageRun {
  return {
    id: 'presenter-stage', jobId: 'course-video-job', stageId: 'presenter', executor: 'course-presenter',
    status: 'running', dispatchStatus: 'claimed', claimOwner: 'test', claimExpiresAt: null, attempt: 1,
    idempotencyKey: null, scopeKey: null, inputFingerprint: null, progress: {}, errorCode: null,
    errorMessage: null, startedAt: new Date().toISOString(), finishedAt: null
  };
}

function artifact(kind: string, path: string): CreatorArtifact {
  return {
    id: `${kind}-artifact`, jobId: 'course-video-job', kind, version: 1, status: 'completed', path,
    scopeKey: null, inputFingerprint: null, sha256: null, sourceArtifactIds: [], metadata: {},
    createdAt: new Date().toISOString()
  };
}

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'course-video-presenter-'));
  const workdir = join(tempDir, 'work');
  mkdirSync(workdir);
  const lessonPath = join(tempDir, 'course-narrated-lesson.json');
  writeFileSync(lessonPath, JSON.stringify(narratedLesson()));
  return { workdir, lessonPath };
}

function clipMock() {
  return vi.fn(async (_request: Parameters<GeneratePresenterClip>[0]) => undefined);
}

describe('course video presenter executor', () => {
  it('generates one talking-head clip per slide with narration', async () => {
    const { workdir, lessonPath } = setup();
    const generateClip = vi.fn(async () => undefined);
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateClip
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(generateClip).toHaveBeenCalledTimes(2);
    expect(result.outputs[0]).toMatchObject({ kind: 'course-avatar', status: 'completed' });
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.portraitPath).toBe('/portraits/instructor.png');
    expect(manifest.clips.map((clip: { slideId: string }) => clip.slideId)).toEqual(['m01:title', 'm01:summary']);
  });

  it('keeps the portrait but skips clips when no lip-sync command is configured', async () => {
    const { workdir, lessonPath } = setup();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png'
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.portraitPath).toBe('/portraits/instructor.png');
    expect(manifest.clips).toEqual([]);
  });

  it('writes an empty manifest when no portrait is available', async () => {
    const { workdir, lessonPath } = setup();
    const generateClip = vi.fn();
    const executor = createCoursePresenterExecutor({ resolvePortrait: async () => '', generateClip });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(generateClip).not.toHaveBeenCalled();
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.clips).toEqual([]);
  });

  it('prefers the lip-sync command in auto mode and passes the slide length', async () => {
    const { workdir, lessonPath } = setup();
    const command = clipMock();
    const model = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateClip: command,
      generateModelClip: model
    });

    await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(command).toHaveBeenCalledTimes(2);
    expect(model).not.toHaveBeenCalled();
    expect(command.mock.calls[0]![0]).toMatchObject({ durationSeconds: 3 });
  });

  it('uses MiniMax-H3 when presenterBackend is minimax', async () => {
    const { workdir, lessonPath } = setup();
    const command = clipMock();
    const model = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateClip: command,
      generateModelClip: model
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({ presenterBackend: 'minimax', presenterModel: 'unsloth/MiniMax-H3-GGUF', presenterPrompt: 'Subtle nod' }),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(command).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[0]![0]).toMatchObject({
      model: 'unsloth/MiniMax-H3-GGUF',
      prompt: 'Subtle nod',
      durationSeconds: 3
    });
    expect(result.outputs[0]!.metadata).toMatchObject({
      presenterBackend: 'minimax',
      presenterModel: 'unsloth/MiniMax-H3-GGUF'
    });
  });

  it('treats the legacy locmodel backend as minimax', async () => {
    const { workdir, lessonPath } = setup();
    const model = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateModelClip: model
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({ presenterBackend: 'locmodel' }),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(model).toHaveBeenCalledTimes(2);
    expect(result.outputs[0]!.metadata).toMatchObject({ presenterBackend: 'minimax' });
  });

  it('prefers the talking-head service in auto mode when it answers', async () => {
    const { workdir, lessonPath } = setup();
    const talking = clipMock();
    const motion = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateTalkingClip: talking,
      generateMotionClip: motion,
      canUseTalkingClip: async () => true
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(talking).toHaveBeenCalledTimes(2);
    expect(motion).not.toHaveBeenCalled();
    expect(result.outputs[0]!.metadata).toMatchObject({ presenterBackend: 'talkinghead' });
  });

  it('prefers the GPU talking head over the CPU command in auto mode', async () => {
    const { workdir, lessonPath } = setup();
    const command = clipMock();
    const talking = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateClip: command,
      generateTalkingClip: talking,
      canUseTalkingClip: async () => true
    });

    await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(talking).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });

  it('falls back to portrait motion when the talking-head service is down', async () => {
    const { workdir, lessonPath } = setup();
    const talking = clipMock();
    const motion = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateTalkingClip: talking,
      generateMotionClip: motion,
      canUseTalkingClip: async () => false
    });

    await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(talking).not.toHaveBeenCalled();
    expect(motion).toHaveBeenCalledTimes(2);
  });

  it('fails loudly when talkinghead is selected but the service is down', async () => {
    const { workdir, lessonPath } = setup();
    const talking = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateTalkingClip: talking,
      canUseTalkingClip: async () => false
    });

    await expect(executor.run({
      stageRun: stageRun(),
      job: job({ presenterBackend: 'talkinghead' }),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    })).rejects.toThrow(/talking-head service is not reachable/);
    expect(talking).not.toHaveBeenCalled();
  });

  it('falls back to portrait motion in auto mode when no video model is available', async () => {
    const { workdir, lessonPath } = setup();
    const model = clipMock();
    const motion = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateModelClip: model,
      generateMotionClip: motion,
      canUseModelClip: async () => false
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(model).not.toHaveBeenCalled();
    expect(motion).toHaveBeenCalledTimes(2);
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.clips.map((clip: { slideId: string }) => clip.slideId)).toEqual(['m01:title', 'm01:summary']);
    expect(result.outputs[0]!.metadata).toMatchObject({ presenterBackend: 'motion' });
  });

  it('keeps the static portrait when no generator is available at all', async () => {
    const { workdir, lessonPath } = setup();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png'
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.clips).toEqual([]);
    expect(result.outputs[0]!.metadata).toMatchObject({ presenterBackend: 'none' });
  });

  it('fails loudly when minimax is selected but Unsloth is unreachable', async () => {
    const { workdir, lessonPath } = setup();
    const model = clipMock();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateModelClip: model,
      canUseModelClip: async () => false
    });

    await expect(executor.run({
      stageRun: stageRun(),
      job: job({ presenterBackend: 'minimax' }),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    })).rejects.toThrow(/Unsloth Studio has no video model available/);
    expect(model).not.toHaveBeenCalled();
  });

  it('fails loudly when minimax is selected but no video model service is wired', async () => {
    const { workdir, lessonPath } = setup();
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png'
    });

    await expect(executor.run({
      stageRun: stageRun(),
      job: job({ presenterBackend: 'minimax' }),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    })).rejects.toThrow(/MiniMax-H3 presenter is not available/);
  });

  it('runs clips with bounded concurrency and preserves slide order', async () => {
    const { workdir, lessonPath } = setup();
    let inFlight = 0;
    let maxInFlight = 0;
    const generateClip = vi.fn(async (request: { slideId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Make the first slide finish last so ordering must be enforced explicitly.
      await new Promise((resolve) => setTimeout(resolve, request.slideId.endsWith('title') ? 30 : 1));
      inFlight -= 1;
    });
    const executor = createCoursePresenterExecutor({
      resolvePortrait: async () => '/portraits/instructor.png',
      generateClip: generateClip as never,
      concurrency: 2
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(maxInFlight).toBe(2);
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest.clips.map((clip: { slideId: string }) => clip.slideId)).toEqual(['m01:title', 'm01:summary']);
  });
});

describe('applyAvatarClips', () => {
  it('attaches talking-head clips to matching slides', () => {
    const lesson = narratedLesson();
    const merged = applyAvatarClips(lesson as never, {
      portraitPath: '/p.png',
      clips: [{ slideId: 'm01:title', path: '/clips/0.mp4' }]
    });
    expect(merged.slides[0]!.avatarSrc).toBe('/clips/0.mp4');
    expect(merged.slides[1]!.avatarSrc).toBeUndefined();
    expect(merged.presenter.portraitSrc).toBe('/p.png');
  });

  it('uses the imported portrait as a static avatar when there are no clips', () => {
    const lesson = narratedLesson();
    const merged = applyAvatarClips(lesson as never, { portraitPath: '/p.png', clips: [] });
    expect(merged.presenter.portraitSrc).toBe('/p.png');
    expect(merged.slides.every(slide => slide.avatarSrc === undefined)).toBe(true);
  });

  it('returns the lesson unchanged without clips or a portrait', () => {
    const lesson = narratedLesson();
    expect(applyAvatarClips(lesson as never, undefined)).toBe(lesson);
    expect(applyAvatarClips(lesson as never, { portraitPath: '', clips: [] })).toBe(lesson);
  });
});
