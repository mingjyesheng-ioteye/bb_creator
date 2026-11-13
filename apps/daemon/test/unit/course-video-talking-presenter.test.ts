import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTalkingHeadClipRunner,
  talkingHeadReachable
} from '../../src/creator/course-video/talking-presenter.js';

let tempDir = '';

afterEach(() => {
  vi.unstubAllGlobals();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'talking-presenter-'));
  const portraitPath = join(tempDir, 'portrait.png');
  const audioPath = join(tempDir, 'narration.mp3');
  writeFileSync(portraitPath, Buffer.from('portrait-bytes'));
  writeFileSync(audioPath, Buffer.from('audio-bytes'));
  return { portraitPath, audioPath, outputPath: join(tempDir, 'avatar.mp4') };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('talking-head presenter', () => {
  it('starts a job, polls it, and stores the returned clip', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    let polls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/avatar')) return jsonResponse({ id: 'job_1', status: 'running' }, 202);
      if (url.endsWith('/v1/avatar/job_1/content')) {
        return new Response(Buffer.from('mp4-bytes'), { status: 200 });
      }
      polls += 1;
      return jsonResponse({ id: 'job_1', status: polls > 1 ? 'done' : 'running' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await createTalkingHeadClipRunner({
      baseUrl: 'http://127.0.0.1:8691/',
      pollIntervalMs: 1
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 12.5,
      signal: new AbortController().signal
    });

    const start = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(start[0]).toBe('http://127.0.0.1:8691/v1/avatar');
    const body = JSON.parse(String(start[1].body));
    expect(body.duration).toBe(12.5);
    expect(Buffer.from(body.portrait_b64, 'base64').toString()).toBe('portrait-bytes');
    expect(Buffer.from(body.audio_b64, 'base64').toString()).toBe('audio-bytes');
    expect(readFileSync(outputPath).toString()).toBe('mp4-bytes');
  });

  it('surfaces a failed job with its message', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/avatar')) return jsonResponse({ id: 'job_2', status: 'running' }, 202);
      return jsonResponse({ id: 'job_2', status: 'failed', error: 'CUDA out of memory' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createTalkingHeadClipRunner({
      baseUrl: 'http://127.0.0.1:8691',
      pollIntervalMs: 1
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 4,
      signal: new AbortController().signal
    })).rejects.toThrow(/out of memory/);
  });

  it('waits for the busy service instead of failing', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    let starts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/avatar')) {
        starts += 1;
        if (starts === 1) return new Response('{"error":"busy"}', { status: 429 });
        return jsonResponse({ id: 'job_3', status: 'running' }, 202);
      }
      if (url.endsWith('/v1/avatar/job_3/content')) {
        return new Response(Buffer.from('mp4-after-wait'), { status: 200 });
      }
      return jsonResponse({ id: 'job_3', status: 'done' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await createTalkingHeadClipRunner({
      baseUrl: 'http://127.0.0.1:8691',
      pollIntervalMs: 1,
      busyRetryMs: 1
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 4,
      signal: new AbortController().signal
    });

    expect(starts).toBe(2);
    expect(readFileSync(outputPath).toString()).toBe('mp4-after-wait');
  });

  it('reports reachability from /health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(false);
    expect(await talkingHeadReachable('')).toBe(false);
  });
});
