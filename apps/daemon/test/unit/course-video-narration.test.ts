import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCourseNarrationExecutor } from '../../src/creator/course-video/narration-executor.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function lesson() {
  return {
    schemaVersion: '1',
    id: 'm01',
    brand: 'Arc Mercer',
    courseTitle: 'Understanding Behavior',
    moduleTitle: 'Functions',
    moduleIndex: 1,
    moduleTotal: 1,
    presenter: { mode: 'placeholder', layout: 'pip-br', name: 'Instructor', role: 'Training Instructor', accentColor: '#FFD166' },
    slides: [
      { id: 'm01:title', kind: 'title', heading: 'Functions', bullets: [], narration: 'Intro text' },
      { id: 'm01:summary', kind: 'summary', heading: 'Summary', bullets: [], narration: 'Summary text' }
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
    id: 'narration-stage', jobId: 'course-video-job', stageId: 'narration', executor: 'course-narration',
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

describe('course video narration executor', () => {
  it('synthesizes every slide and writes a narrated lesson', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-narration-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const lessonPath = join(tempDir, 'course-lesson.json');
    writeFileSync(lessonPath, JSON.stringify(lesson()));
    const synthesizeSlide = vi.fn(async ({ index }: { index: number }) => ({
      path: join(workdir, `slide-${index}.mp3`),
      durationSeconds: 2 + index,
      captions: [{ word: 'Hi', start: 0, end: 0.5 }]
    }));
    const executor = createCourseNarrationExecutor({ synthesizeSlide });

    const result = await executor.run({
      stageRun: stageRun(),
      job: job({ voice: 'en-US-AvaNeural', rate: '-4%' }),
      inputArtifacts: [artifact('course-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    });

    expect(synthesizeSlide).toHaveBeenCalledTimes(2);
    expect(result.outputs[0]).toMatchObject({ kind: 'course-narrated-lesson', status: 'completed' });
    const narrated = JSON.parse(readFileSync(result.outputs[0]!.path!, 'utf8'));
    expect(narrated.slides).toHaveLength(2);
    expect(narrated.slides[0].audioSrc).toContain('slide-0.mp3');
    // 2s + 0.7s tail, at 30fps → 81 frames
    expect(narrated.slides[0].durationInFrames).toBe(81);
    expect(narrated.slides[0].captions).toEqual([{ word: 'Hi', start: 0, end: 0.5 }]);
    expect(narrated.slides[1].durationInFrames).toBe(111);
  });

  it('rejects a lesson with no slides', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'course-video-narration-'));
    const workdir = join(tempDir, 'work');
    mkdirSync(workdir);
    const lessonPath = join(tempDir, 'course-lesson.json');
    writeFileSync(lessonPath, JSON.stringify({ ...lesson(), slides: [] }));
    const executor = createCourseNarrationExecutor({ synthesizeSlide: vi.fn() });
    await expect(executor.run({
      stageRun: stageRun(),
      job: job({}),
      inputArtifacts: [artifact('course-lesson', lessonPath)],
      workdir,
      signal: new AbortController().signal,
      reportProgress: vi.fn()
    })).rejects.toMatchObject({ code: 'course_lesson_invalid' });
  });
});
