import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTalkingHeadClipRunner,
  planChunks,
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

/** Chunking needs a real ffmpeg; skip when this host has none. */
function resolveFfmpeg(): string | undefined {
  for (const candidate of ['/usr/bin/ffmpeg', 'ffmpeg']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

describe('talking-head presenter', () => {
  it('plans chunks and folds a short tail into the last piece', () => {
    expect(planChunks(42.84, 10)).toEqual([
      { start: 0, length: 10 },
      { start: 10, length: 10 },
      { start: 20, length: 10 },
      { start: 30, length: 12.84 }
    ]);
    // 13 s at 6 s pieces would leave a 1 s tail, which crashes SadTalker.
    expect(planChunks(13, 6)).toEqual([
      { start: 0, length: 6 },
      { start: 6, length: 7 }
    ]);
    expect(planChunks(30, 10)).toEqual([
      { start: 0, length: 10 },
      { start: 10, length: 10 },
      { start: 20, length: 10 }
    ]);
    expect(planChunks(12, 10)).toEqual([{ start: 0, length: 12 }]);
    expect(planChunks(2.5, 10)).toEqual([{ start: 0, length: 3 }]);
  });

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
      pollIntervalMs: 1,
      retries: 0
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

  it('retries a failed GPU job once before giving up', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    let jobs = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/avatar')) {
        jobs += 1;
        return jsonResponse({ id: `job_${jobs}`, status: 'running' }, 202);
      }
      if (url.endsWith(`/v1/avatar/job_${jobs}/content`)) {
        return new Response(Buffer.from('mp4-retry'), { status: 200 });
      }
      return jsonResponse({ id: `job_${jobs}`, status: jobs === 1 ? 'failed' : 'done', error: 'ROCm crash' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await createTalkingHeadClipRunner({
      baseUrl: 'http://127.0.0.1:8691',
      pollIntervalMs: 1,
      retryDelayMs: 1
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm02:body',
      index: 1,
      durationSeconds: 4,
      signal: new AbortController().signal
    });

    expect(jobs).toBe(2);
    expect(readFileSync(outputPath).toString()).toBe('mp4-retry');
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

  it('splits a long slide into parallel chunks and stitches them', async () => {
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg === undefined) return;

    tempDir = mkdtempSync(join(tmpdir(), 'talking-chunks-'));
    const portraitPath = join(tempDir, 'portrait.png');
    const audioPath = join(tempDir, 'narration.wav');
    const outputPath = join(tempDir, 'avatar.mp4');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=blue:s=160x96:d=1', '-frames:v', '1', portraitPath]);
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=r=16000:cl=mono', '-t', '24', audioPath]);
    const chunkPath = join(tempDir, 'chunk.mp4');
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'testsrc=s=160x96:r=16:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-t', '6', chunkPath]);
    const chunkBytes = readFileSync(chunkPath);

    let jobs = 0;
    const durations: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/avatar')) {
        jobs += 1;
        durations.push(JSON.parse(String(init?.body)).duration);
        return jsonResponse({ id: `job_${jobs}`, status: 'running' }, 202);
      }
      if (url.endsWith('/content')) {
        return new Response(chunkBytes, { status: 200 });
      }
      return jsonResponse({ id: 'job', status: 'done' });
    }));

    await createTalkingHeadClipRunner({
      baseUrl: 'http://127.0.0.1:8691',
      pollIntervalMs: 1,
      ffmpegPath: ffmpeg,
      chunkSeconds: 6,
      chunkTriggerSeconds: 12,
      chunkParallel: 2
    })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm03:long',
      index: 2,
      durationSeconds: 24,
      signal: new AbortController().signal
    });

    expect(jobs).toBe(4);
    expect(durations).toEqual([6, 6, 6, 6]);
    const duration = Number(execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outputPath
    ]).toString().trim());
    expect(duration).toBeGreaterThan(23);
    expect(duration).toBeLessThan(25);
  });

  it('reports reachability from /health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(false);
    expect(await talkingHeadReachable('')).toBe(false);
  });
});
