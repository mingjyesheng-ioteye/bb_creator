import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMinimaxLipsyncPresenterClipRunner } from '../../src/creator/course-video/minimax-lipsync-presenter.js';
import type { VideoGenerationService } from '../../src/video-generation/service.js';

let tempDir = '';

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'minimax-lipsync-'));
  const portraitPath = join(tempDir, 'portrait.png');
  const audioPath = join(tempDir, 'narration.wav');
  writeFileSync(portraitPath, Buffer.from('portrait'));
  writeFileSync(audioPath, Buffer.from('audio'));
  return { portraitPath, audioPath, outputPath: join(tempDir, 'avatar.mp4') };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('MiniMax + Wav2Lip presenter', () => {
  it('generates a MiniMax clip and lip-syncs it through the avatar service', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    const create = vi.fn(async () => ({ id: 'video_1', status: 'queued', progress: 0 }));
    const refresh = vi.fn(async () => ({ id: 'video_1', status: 'completed', progress: 100 }));
    const copyTo = vi.fn(async (_id: string, destination: string) => {
      writeFileSync(destination, 'minimax-clip');
      return { id: 'video_1', status: 'completed', progress: 100 };
    });
    const service = { create, refresh, copyTo } as unknown as VideoGenerationService;

    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/avatar')) {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ id: 'job_1', status: 'running' }, 202);
      }
      if (url.endsWith('/v1/avatar/job_1')) return json({ id: 'job_1', status: 'done' });
      if (url.endsWith('/content')) return new Response(Buffer.from('lip-synced'), { status: 200 });
      return new Response('not found', { status: 404 });
    }));

    await createMinimaxLipsyncPresenterClipRunner({
      service,
      avatarBaseUrl: 'http://127.0.0.1:8691',
      pollIntervalMs: 1,
      avatarPollIntervalMs: 1,
      busyRetryMs: 1
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 6,
      signal: new AbortController().signal
    });

    expect(create).toHaveBeenCalledTimes(1);
    const request = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request).toMatchObject({
      provider: 'local-sd',
      duration: 6,
      referenceImage: { mime: 'image/png' }
    });
    expect(body).toMatchObject({ engine: 'wav2lip', fps: 25, duration: 6 });
    expect(Buffer.from(String(body.video_b64), 'base64').toString()).toBe('minimax-clip');
    expect(readFileSync(outputPath).toString()).toBe('lip-synced');
  });
});
