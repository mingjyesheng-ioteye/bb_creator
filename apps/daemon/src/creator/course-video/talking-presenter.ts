import { readFile, writeFile } from 'node:fs/promises';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * Real talking head (MuseTalk) on the Windows GPU.
 *
 * The daemon runs in WSL, where there is no GPU, so the model is reached over
 * HTTP: `OPENCREATOR_TALKING_HEAD_URL` points at the small Windows avatar
 * service (`D:\ai\avatar\server.py`, port 8691). It returns a lip-synced mp4
 * for the portrait + narration pair, already looped to the slide length.
 */
export function createTalkingHeadClipRunner(input: {
  baseUrl: string;
  timeoutMs?: number;
}): GeneratePresenterClip {
  const endpoint = `${input.baseUrl.trim().replace(/\/+$/, '')}/v1/avatar`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const [portrait, audio] = await Promise.all([
      readFile(request.portraitPath),
      readFile(request.audioPath)
    ]);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portrait_b64: portrait.toString('base64'),
        audio_b64: audio.toString('base64'),
        duration: request.durationSeconds > 0.5 ? request.durationSeconds : 4,
        fps: 25
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new CreatorExecutorError(
        'course_presenter_failed',
        `The talking-head service failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
      );
    }
    const video = Buffer.from(await response.arrayBuffer());
    if (video.length === 0) {
      throw new CreatorExecutorError('course_presenter_failed', 'The talking-head service returned an empty clip');
    }
    await writeFile(request.outputPath, video);
  };
}

/** Is the service up? Used by the presenter stage and the preflight. */
export async function talkingHeadReachable(baseUrl: string, timeoutMs = 2_500): Promise<boolean> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.length === 0) return false;
  try {
    const response = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}
