import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCourseImportExecutor } from '../../src/creator/course-video/import-executor.js';
import { createCoursePlanExecutor } from '../../src/creator/course-video/plan-executor.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function coursePayload() {
  return {
    success: true,
    course: {
      id: 'course-1',
      slug: 'understanding-behavior',
      versionId: 'version-3',
      title: 'Understanding Behavior',
      passingThreshold: 0.8,
      branding: { organization: 'Arc Mercer' },
      modules: [
        {
          moduleKey: 'm01',
          order: 1,
          title: 'Functions and Causes of Behavior',
          level: 'Entry',
          summary: 'Most behavior has a purpose.',
          objectives: ['Identify the function of behavior'],
          blocks: [{ id: 'b1', title: 'Why', body: 'Behavior is communication.', kind: 'teaching' }],
          conversation: [{ id: 't1', role: 'instructor', text: 'What comes before?' }],
          quiz: [
            {
              questionId: 'q1',
              order: 1,
              prompt: 'Functions are…',
              options: [
                { id: 'a', text: 'Obtain and escape' },
                { id: 'b', text: 'Happy and sad' }
              ],
              correctOptionId: 'a'
            }
          ]
        },
        {
          moduleKey: 'm02',
          order: 2,
          title: 'Understanding Behavior',
          level: 'Entry',
          summary: '',
          objectives: [],
          blocks: [],
          conversation: [],
          quiz: []
        }
      ]
    }
  };
}

function job(state: Record<string, unknown>): CreatorJob {
  const now = new Date().toISOString();
  return {
    id: 'course-video-job',
    projectId: 'project-1',
    templateId: 'course-video',
    templateVersion: 1,
    status: 'running',
    revision: 0,
    state: state as CreatorJob['state'],
    agentThreadId: null,
    stages: [],
    artifacts: [],
    providerRequests: [],
    activities: [],
    createdAt: now,
    updatedAt: now
  };
}

function stageRun(executor: string): CreatorStageRun {
  return {
    id: `${executor}-stage`,
    jobId: 'course-video-job',
    stageId: executor,
    executor,
    status: 'running',
    dispatchStatus: 'claimed',
    claimOwner: 'test',
    claimExpiresAt: null,
    attempt: 1,
    idempotencyKey: null,
    scopeKey: null,
    inputFingerprint: null,
    progress: {},
    errorCode: null,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
}

function artifact(kind: string, path: string, sha256: string | null = null): CreatorArtifact {
  return {
    id: `${kind}-artifact`,
    jobId: 'course-video-job',
    kind,
    version: 1,
    status: 'completed',
    path,
    scopeKey: null,
    inputFingerprint: null,
    sha256,
    sourceArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

describe('course video import executor', () => {
  it('imports the published course through the public API', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-import-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const fetchCourse = vi.fn(async () => coursePayload());
    const executor = createCourseImportExecutor({
      resolveBaseUrl: async () => 'https://trainer.example',
      resolveToken: async () => 'token',
      fetchCourse
    });

    const result = await executor.run({
      stageRun: stageRun('course-import'),
      job: job({ courseSlug: 'understanding-behavior' }),
      inputArtifacts: [],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(fetchCourse).toHaveBeenCalledWith(expect.objectContaining({ slug: 'understanding-behavior', baseUrl: 'https://trainer.example' }));
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ kind: 'course-spec', status: 'completed' });
    const written = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(written.modules).toHaveLength(2);
  });

  it('rejects a missing slug and an unexpected payload', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-import-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const executor = createCourseImportExecutor({
      resolveBaseUrl: async () => 'https://trainer.example',
      resolveToken: async () => '',
      fetchCourse: async () => coursePayload()
    });
    const base = {
      stageRun: stageRun('course-import'),
      inputArtifacts: [],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    };
    await expect(executor.run({ ...base, job: job({ courseSlug: '' }) })).rejects.toMatchObject({ code: 'course_slug_missing' });

    const bad = createCourseImportExecutor({
      resolveBaseUrl: async () => 'https://trainer.example',
      resolveToken: async () => '',
      fetchCourse: async () => ({ success: true, course: { id: 'x' } })
    });
    await expect(bad.run({ ...base, job: job({ courseSlug: 'x' }) })).rejects.toMatchObject({ code: 'course_payload_invalid' });
  });
});

describe('course video plan executor', () => {
  it('normalizes the first module into a course lesson', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-plan-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const specPath = join(tempDir, 'course-spec.json');
    writeFileSync(specPath, JSON.stringify(coursePayload().course));

    const executor = createCoursePlanExecutor();
    const result = await executor.run({
      stageRun: stageRun('course-plan'),
      job: job({ courseSlug: 'understanding-behavior', moduleKey: '' }),
      inputArtifacts: [artifact('course-spec', specPath, 'a'.repeat(64))],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(result.outputs[0]).toMatchObject({ kind: 'course-lesson', status: 'completed' });
    const lesson = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(lesson.id).toBe('m01');
    expect(lesson.moduleIndex).toBe(1);
    expect(lesson.moduleTotal).toBe(2);
    expect(lesson.source).toMatchObject({ versionId: 'version-3', sourceHash: 'a'.repeat(64) });
    expect(lesson.assessment.passingPercent).toBe(80);
  });

  it('selects an explicit module and rejects an unknown one', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-plan-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const specPath = join(tempDir, 'course-spec.json');
    writeFileSync(specPath, JSON.stringify(coursePayload().course));
    const executor = createCoursePlanExecutor();
    const base = {
      stageRun: stageRun('course-plan'),
      inputArtifacts: [artifact('course-spec', specPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    };

    const selected = await executor.run({ ...base, job: job({ moduleKey: 'm02' }) });
    expect(JSON.parse(readFileSync(selected.outputs[0]!.path!, 'utf8')).id).toBe('m02');

    await expect(executor.run({ ...base, job: job({ moduleKey: 'nope' }) })).rejects.toMatchObject({ code: 'course_module_missing' });
  });
});
