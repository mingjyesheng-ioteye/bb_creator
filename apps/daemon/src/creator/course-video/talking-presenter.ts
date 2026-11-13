import { readFile, writeFile } from 'node:fs/promises';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 3_000;

type JobStatus = { id: string; status: 'running' | 'done' | 'failed'; error?: string };

/**
 * Real talking head (SadTalker) on the Windows GPU.
 *
 * The daemon runs in WSL, where there is no GPU, so the model is reached over
 * HTTP: `OPENCREATOR_TALKING_HEAD_URL` points at the small Windows avatar
 * service (`D:\ai\avatar\server.py`, port 8691). Rendering takes minutes, so the
 * service exposes a job queue — POST returns an id, then we poll. Holding one
 * HTTP request open for the whole render trips undici's 5-minute headers
 * timeout (`UND_ERR_HEADERS_TIMEOUT`).
 */
export function createTalkingHeadClipRunner(input: {
  baseUrl: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): GeneratePresenterClip {
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? POLL_INTERVAL_MS;

  return async (request) => {
    const [portrait, audio] = await Promise.all([
      readFile(request.portraitPath),
      readFile(request.audioPath)
    ]);
    const started = await fetch(`${base}/v1/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portrait_b64: portrait.toString('base64'),
        audio_b64: audio.toString('base64'),
        duration: request.durationSeconds > 0.5 ? request.durationSeconds : 4,
        fps: 25
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)])
    });
    if (started.status === 429) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'The talking-head service is busy with another clip; retry the presenter stage.'
      );
    }
    if (!started.ok) {
      const detail = await started.text().catch(() => '');
      throw new CreatorExecutorError(
        'course_presenter_failed',
        `The talking-head service failed to start (HTTP ${started.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
      );
    }
    const { id } = await started.json() as { id: string };
    if (!id) {
      throw new CreatorExecutorError('course_presenter_failed', 'The talking-head service returned no job id');
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await delay(pollIntervalMs, request.signal);
      if (Date.now() > deadline) {
        await fetch(`${base}/v1/avatar/${id}`, { method: 'DELETE' }).catch(() => undefined);
        throw new CreatorExecutorError(
          'course_presenter_failed',
          'The talking-head service timed out; shorten the slide or check the service log.'
        );
      }
      const polled = await fetch(`${base}/v1/avatar/${id}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (polled.status === 404) {
        throw new CreatorExecutorError(
          'course_presenter_failed',
          'The talking-head service lost the job (did it restart?); retry the presenter stage.'
        );
      }
      if (!polled.ok) continue;
      const job = await polled.json() as JobStatus;
      if (job.status === 'failed') {
        throw new CreatorExecutorError(
          'course_presenter_failed',
          `The talking-head service failed${job.error ? `: ${job.error}` : ''}`
        );
      }
      if (job.status === 'done') break;
    }

    const content = await fetch(`${base}/v1/avatar/${id}/content`, {
      signal: AbortSignal.timeout(120_000)
    });
    if (!content.ok) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        `The talking-head service returned no clip (HTTP ${content.status})`
      );
    }
    const video = Buffer.from(await content.arrayBuffer());
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
