import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCourseDeliveryExecutor,
  type CourseMediaUploadRequest
} from '../../src/creator/course-video/deliver-executor.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function lesson(source: Record<string, unknown> | undefined) {
  return {
    schemaVersion: '1',
    id: 'm01',
    brand: 'Arc Mercer',
    courseTitle: 'Understanding Behavior',
    moduleTitle: 'Functions',
    moduleIndex: 1,
    moduleTotal: 1,
    presenter: { mode: 'placeholder', layout: 'pip-br', name: 'Instructor', role: 'Training Instructor', accentColor: '#FFD166' },
    slides: [{ id: 'm01:title', kind: 'title', heading: 'Functions', bullets: [], narration: 'Intro' }],
    ...(source ? { source } : {})
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
    id: 'deliver-stage', jobId: 'course-video-job', stageId: 'deliver', executor: 'course-delivery',
    status: 'running', dispatchStatus: 'claimed', claimOwner: 'test', claimExpiresAt: null, attempt: 1,
    idempotencyKey: null, scopeKey: null, inputFingerprint: null, progress: {}, errorCode: null,
    errorMessage: null, startedAt: new Date().toISOString(), finishedAt: null
  };
}

function artifact(kind: string, path: string, metadata: Record<string, unknown> = {}): CreatorArtifact {
  return {
    id: `${kind}-artifact`, jobId: 'course-video-job', kind, version: 1, status: 'completed', path,
    scopeKey: null, inputFingerprint: null, sha256: null, sourceArtifactIds: [], metadata: metadata as CreatorArtifact['metadata'],
    createdAt: new Date().toISOString()
  };
}

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'course-video-delivery-'));
  const workdir = join(tempDir, 'work');
  mkdirSync(workdir);
  const videoPath = join(tempDir, 'lesson.mp4');
  writeFileSync(videoPath, 'mp4-bytes');
  const lessonPath = join(tempDir, 'course-narrated-lesson.json');
  return { workdir, videoPath, lessonPath };
}

const source = {
  courseId: 'course-1',
  versionId: 'version-3',
  slug: 'understanding-behavior',
  moduleKey: 'm01',
  sourceHash: 'h'
};

describe('course video delivery executor', () => {
  it('uploads the rendered video to the bb_exam version media endpoint', async () => {
    const { workdir, videoPath, lessonPath } = setup();
    writeFileSync(lessonPath, JSON.stringify(lesson(source)));
    const uploadMedia = vi.fn(async (_request: CourseMediaUploadRequest) => ({ url: 'https://trainer.example/signed' }));
    const executor = createCourseDeliveryExecutor({
      resolveBaseUrl: async () => 'https://trainer.example',
      resolveToken: async () => 'token',
      uploadMedia
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-video', videoPath, { fileName: 'lesson.mp4' }), artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      courseId: 'course-1',
      versionId: 'version-3',
      moduleKey: 'm01',
      kind: 'lesson_video',
      mimeType: 'video/mp4'
    }));
    expect(result.outputs[0]).toMatchObject({ kind: 'course-delivery', status: 'completed' });
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest).toMatchObject({ uploaded: true, url: 'https://trainer.example/signed', moduleKey: 'm01' });
  });

  it('degrades to a skipped manifest when bb_exam is not configured', async () => {
    const { workdir, videoPath, lessonPath } = setup();
    writeFileSync(lessonPath, JSON.stringify(lesson(source)));
    const uploadMedia = vi.fn();
    const executor = createCourseDeliveryExecutor({
      resolveBaseUrl: async () => '',
      resolveToken: async () => '',
      uploadMedia
    });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-video', videoPath), artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(uploadMedia).not.toHaveBeenCalled();
    const manifest = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(manifest).toMatchObject({ uploaded: false, reason: 'unconfigured' });
  });

  it('rejects a lesson without bb_exam provenance', async () => {
    const { workdir, videoPath, lessonPath } = setup();
    writeFileSync(lessonPath, JSON.stringify(lesson(undefined)));
    const executor = createCourseDeliveryExecutor({
      resolveBaseUrl: async () => 'https://trainer.example',
      resolveToken: async () => 'token',
      uploadMedia: vi.fn()
    });

    await expect(executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-video', videoPath), artifact('course-narrated-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    })).rejects.toMatchObject({ code: 'course_lesson_source_missing' });
  });
});
