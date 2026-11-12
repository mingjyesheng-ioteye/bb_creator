import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateVideoGenerationRequest,
  VideoGenerationResult
} from '@opencreator/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocModelPresenterClipRunner } from '../../src/creator/course-video/locmodel-presenter.js';
import type {
  VideoGenerationOperationOptions,
  VideoGenerationService
} from '../../src/video-generation/service.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'locmodel-presenter-'));
  const portraitPath = join(tempDir, 'portrait.png');
  writeFileSync(portraitPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { portraitPath, outputPath: join(tempDir, 'avatar-00.mp4') };
}

function result(overrides: Partial<VideoGenerationResult> = {}): VideoGenerationResult {
  const now = new Date().toISOString();
  return {
    id: 'job_abcdefghijkl',
    prompt: 'presenter',
    provider: 'local-sd',
    model: 'sd-cpp-local',
    videoSize: '1280x720',
    duration: 10,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function fakeService(options: { failWith?: string } = {}) {
  const create = vi.fn(async (
    _request: CreateVideoGenerationRequest,
    _options?: VideoGenerationOperationOptions
  ) => result());
  let polls = 0;
  const refresh = vi.fn(async (
    _id: string,
    _options?: VideoGenerationOperationOptions
  ) => {
    polls += 1;
    if (options.failWith !== undefined) return result({ status: 'failed', error: options.failWith });
    return polls > 1 ? result({ status: 'completed', progress: 100 }) : result({ status: 'in_progress', progress: 50 });
  });
  const copyTo = vi.fn(async (_id: string, destination: string) => {
    writeFileSync(destination, 'rendered');
    return result({ status: 'completed', progress: 100 });
  });
  const service = {
    create,
    refresh,
    copyTo,
    get: vi.fn(async () => result()),
    read: vi.fn(async () => ({ result: result(), content: Buffer.alloc(0) }))
  } as unknown as VideoGenerationService;
  return { service, create, refresh, copyTo };
}

describe('LocModel presenter clip runner', () => {
  it('animates the portrait with the selected video model', async () => {
    const { portraitPath, outputPath } = setup();
    const { service, create, copyTo } = fakeService();

    await createLocModelPresenterClipRunner({ service, pollIntervalMs: 1 })({
      portraitPath,
      audioPath: join(tempDir, 'narration.mp3'),
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 12.4,
      model: 'wan2.2-ti2v-5b/Wan2.2-TI2V-5B-Q8_0.gguf',
      prompt: 'Presenter nods once',
      signal: new AbortController().signal
    });

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0];
    expect(request).toMatchObject({
      provider: 'local-sd',
      model: 'wan2.2-ti2v-5b/Wan2.2-TI2V-5B-Q8_0.gguf',
      prompt: 'Presenter nods once',
      size: '1280x720',
      // 12.4 s exceeds the 10 s job cap; ffmpeg would loop the clip afterwards.
      duration: 10,
      referenceImage: { mime: 'image/png' }
    });
    expect(request.referenceImage!.data).toBe(Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
    expect(copyTo).toHaveBeenCalledTimes(1);
    expect(existsSync(outputPath)).toBe(true);
  });

  it('uses the built-in motion prompt and the smallest fitting duration', async () => {
    const { portraitPath, outputPath } = setup();
    const { service, create } = fakeService();

    await createLocModelPresenterClipRunner({ service, pollIntervalMs: 1 })({
      portraitPath,
      audioPath: join(tempDir, 'narration.mp3'),
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 4.2,
      signal: new AbortController().signal
    });

    const request = create.mock.calls[0]![0];
    expect(request.duration).toBe(5);
    expect(request.prompt).toMatch(/speaks warmly/);
    expect(request.model).toBeUndefined();
  });

  it('surfaces a failed LocModel job', async () => {
    const { portraitPath, outputPath } = setup();
    const { service } = fakeService({ failWith: 'out of memory' });

    await expect(createLocModelPresenterClipRunner({ service, pollIntervalMs: 1 })({
      portraitPath,
      audioPath: join(tempDir, 'narration.mp3'),
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 4,
      signal: new AbortController().signal
    })).rejects.toThrow(/out of memory/);
  });
});
