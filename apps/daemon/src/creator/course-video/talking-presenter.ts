import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 3_000;
/** How long one clip may wait for the single-GPU queue before failing. */
const BUSY_WAIT_MS = 40 * 60_000;
const BUSY_RETRY_MS = 20_000;
/** Pause before re-running a failed GPU job. */
const RETRY_DELAY_MS = 5_000;
const DEFAULT_CHUNK_SECONDS = 10;
const DEFAULT_CHUNK_TRIGGER = 12;
const DEFAULT_CHUNK_PARALLEL = 2;

type JobStatus = { id: string; status: 'running' | 'done' | 'failed'; error?: string };

type JobOptions = {
  timeoutMs: number;
  pollIntervalMs: number;
  busyRetryMs: number;
  /** Extra attempts after a failed job (a flaky GPU crash is often transient). */
  retries: number;
  retryDelayMs: number;
  signal: AbortSignal;
};

/**
 * Real talking head (SadTalker) on the Windows GPU.
 *
 * The daemon runs in WSL, where there is no GPU, so the model is reached over
 * HTTP: `OPENCREATOR_TALKING_HEAD_URL` points at the small Windows avatar
 * service (`D:\ai\avatar\server.py`, port 8691). Rendering takes minutes, so the
 * service exposes a job queue — POST returns an id, then we poll. Holding one
 * HTTP request open for the whole render trips undici's 5-minute headers
 * timeout (`UND_ERR_HEADERS_TIMEOUT`).
 *
 * Long slides are **chunked**: a 2-minute narration is split into ~10 s pieces
 * that render two at a time (the service runs `AVATAR_CONCURRENCY` jobs), then
 * stitched with ffmpeg. That roughly halves the wall clock and makes a retry
 * cheap, because only the failed chunk is re-rendered.
 */
export function createTalkingHeadClipRunner(input: {
  baseUrl: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Retry interval when the service reports 429 (tests use 1 ms). */
  busyRetryMs?: number;
  /** ffmpeg used to split narration and stitch chunks (long slides only). */
  ffmpegPath?: string;
  chunkSeconds?: number;
  chunkTriggerSeconds?: number;
  chunkParallel?: number;
  /** Retries for a failed GPU job (default 1). */
  retries?: number;
  retryDelayMs?: number;
}): GeneratePresenterClip {
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? POLL_INTERVAL_MS;
  const busyRetryMs = input.busyRetryMs ?? BUSY_RETRY_MS;
  const chunkSeconds = input.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  const chunkTrigger = input.chunkTriggerSeconds ?? DEFAULT_CHUNK_TRIGGER;
  const chunkParallel = Math.max(1, input.chunkParallel ?? DEFAULT_CHUNK_PARALLEL);
  const retries = Math.max(0, input.retries ?? 1);
  const retryDelayMs = input.retryDelayMs ?? RETRY_DELAY_MS;

  const payloadFor = (portraitB64: string, audio: Buffer, seconds: number) => JSON.stringify({
    portrait_b64: portraitB64,
    audio_b64: audio.toString('base64'),
    duration: seconds > 0.5 ? seconds : 4,
    fps: 25
  });

  return async (request) => {
    const [portrait, audio] = await Promise.all([
      readFile(request.portraitPath),
      readFile(request.audioPath)
    ]);
    const portraitB64 = portrait.toString('base64');
    const duration = request.durationSeconds > 0.5 ? request.durationSeconds : 4;

    if (input.ffmpegPath === undefined || duration <= chunkTrigger) {
      const video = await runRemoteJob(base, payloadFor(portraitB64, audio, duration), {
        timeoutMs, pollIntervalMs, busyRetryMs, retries, retryDelayMs, signal: request.signal
      });
      await writeFile(request.outputPath, video);
      return;
    }

    const work = await mkdtemp(join(tmpdir(), 'talking-chunks.'));
    try {
      const count = Math.ceil(duration / chunkSeconds);
      const parts: string[] = new Array(count);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= count) return;
          const start = index * chunkSeconds;
          const length = Math.min(chunkSeconds, Math.max(1, duration - start));
          const audioPath = join(work, `audio-${index}.wav`);
          const videoPath = join(work, `clip-${index}.mp4`);
          await runFfmpeg(input.ffmpegPath!, [
            '-y', '-loglevel', 'error',
            '-ss', start.toFixed(3), '-t', length.toFixed(3),
            '-i', request.audioPath,
            '-ac', '1', '-ar', '16000', audioPath
          ], request.signal);
          const chunkAudio = await readFile(audioPath);
          const video = await runRemoteJob(base, payloadFor(portraitB64, chunkAudio, length), {
            timeoutMs, pollIntervalMs, busyRetryMs, retries, retryDelayMs, signal: request.signal
          });
          await writeFile(videoPath, video);
          parts[index] = videoPath;
        }
      };
      await Promise.all(Array.from({ length: Math.min(chunkParallel, count) }, () => worker()));

      const listPath = join(work, 'list.txt');
      await writeFile(listPath, parts.map(path => `file '${path.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      await runFfmpeg(input.ffmpegPath, [
        '-y', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-t', duration.toFixed(3),
        '-c', 'copy', '-movflags', '+faststart', request.outputPath
      ], request.signal);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** A GPU job that failed for a reason worth one more attempt (crash, 5xx). */
class TransientJobError extends CreatorExecutorError {}

/** Start one talking-head job (waiting out 429s), poll it, download the clip. */
async function runRemoteJob(base: string, body: string, options: JobOptions): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await runRemoteJobOnce(base, body, options);
    } catch (error) {
      lastError = error;
      if (attempt >= options.retries || !(error instanceof TransientJobError)) throw error;
      await delay(options.retryDelayMs, options.signal);
    }
  }
  throw lastError;
}

async function runRemoteJobOnce(base: string, body: string, options: JobOptions): Promise<Buffer> {
  const startJob = () => fetch(`${base}/v1/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
  });
  let started = await startJob();
  const busyUntil = Date.now() + BUSY_WAIT_MS;
  while (started.status === 429) {
    if (Date.now() > busyUntil) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'The talking-head service stayed busy for 40 minutes; check it on the GPU host.'
      );
    }
    await delay(options.busyRetryMs, options.signal);
    started = await startJob();
  }
  if (!started.ok) {
    const detail = await started.text().catch(() => '');
    const ErrorType = started.status >= 500 ? TransientJobError : CreatorExecutorError;
    throw new ErrorType(
      'course_presenter_failed',
      `The talking-head service failed to start (HTTP ${started.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
    );
  }
  const { id } = await started.json() as { id: string };
  if (!id) {
    throw new CreatorExecutorError('course_presenter_failed', 'The talking-head service returned no job id');
  }

  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    await delay(options.pollIntervalMs, options.signal);
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
      throw new TransientJobError(
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
  return video;
}

function runFfmpeg(ffmpegPath: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { signal, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error) => {
      if (error) {
        reject(new CreatorExecutorError(
          'course_presenter_failed',
          `Could not prepare the talking-head chunks: ${error.message}`
        ));
      } else {
        resolve();
      }
    });
  });
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
