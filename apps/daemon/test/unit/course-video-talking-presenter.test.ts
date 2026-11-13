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

describe('talking-head presenter', () => {
  it('posts the portrait and narration and stores the returned clip', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    const fetchMock = vi.fn(async () => new Response(Buffer.from('mp4-bytes'), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createTalkingHeadClipRunner({ baseUrl: 'http://127.0.0.1:8691/' })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 12.5,
      signal: new AbortController().signal
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8691/v1/avatar');
    const body = JSON.parse(String(init.body));
    expect(body.duration).toBe(12.5);
    expect(Buffer.from(body.portrait_b64, 'base64').toString()).toBe('portrait-bytes');
    expect(Buffer.from(body.audio_b64, 'base64').toString()).toBe('audio-bytes');
    expect(readFileSync(outputPath).toString()).toBe('mp4-bytes');
  });

  it('surfaces a service error with its message', async () => {
    const { portraitPath, audioPath, outputPath } = setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"busy"}', { status: 429 })));

    await expect(createTalkingHeadClipRunner({ baseUrl: 'http://127.0.0.1:8691' })({
      portraitPath,
      audioPath,
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 4,
      signal: new AbortController().signal
    })).rejects.toThrow(/HTTP 429/);
  });

  it('reports reachability from /health', async () => {
    const ok = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', ok);
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    expect(await talkingHeadReachable('http://127.0.0.1:8691')).toBe(false);
    expect(await talkingHeadReachable('')).toBe(false);
  });
});
