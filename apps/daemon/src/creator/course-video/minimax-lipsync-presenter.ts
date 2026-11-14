import { readFile, rm, writeFile } from 'node:fs/promises';
import type {
  CreateVideoGenerationRequest,
  VideoGenerationResult
} from '@opencreator/protocol';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';
import type { VideoGenerationService } from '../../video-generation/service.js';
import { DEFAULT_MINIMAX_PRESENTER_PROMPT } from './minimax-presenter.js';

/** The local video API accepts 4/5/6/8/10 second jobs. */
const CLIP_DURATIONS = [4, 5, 6, 8, 10] as const;
const VIDEO_POLL_MS = 2_000;
const VIDEO_TIMEOUT_MS = 60 * 60_000;
const AVATAR_POLL_MS = 3_000;
const AVATAR_TIMEOUT_MS = 30 * 60_000;
const AVATAR_BUSY_WAIT_MS = 40 * 60_000;

type AvatarJob = { id: string; status: 'running' | 'done' | 'failed'; error?: string };

/**
 * MiniMax-H3 motion + Wav2Lip lips.
 *
 * MiniMax's fl2va checkpoint animates the portrait (head motion, blinks,
 * gestures) but cannot use the narration audio, and its ref2va/audio path
 * needs the dense model. This runner gets both: generate the motion clip with
 * MiniMax, then send that clip plus the narration to the Windows avatar
 * service, which runs Wav2Lip over it (mouth only, ~1-2 min for a 6 s clip).
 */
export function createMinimaxLipsyncPresenterClipRunner(input: {
  service: VideoGenerationService;
  avatarBaseUrl: string;
  size?: CreateVideoGenerationRequest['size'];
  pollIntervalMs?: number;
  timeoutMs?: number;
  avatarPollIntervalMs?: number;
  avatarTimeoutMs?: number;
  busyRetryMs?: number;
}): GeneratePresenterClip {
  const base = input.avatarBaseUrl.trim().replace(/\/+$/, '');
  const videoPollMs = input.pollIntervalMs ?? VIDEO_POLL_MS;
  const videoTimeoutMs = input.timeoutMs ?? VIDEO_TIMEOUT_MS;
  const avatarPollMs = input.avatarPollIntervalMs ?? AVATAR_POLL_MS;
  const avatarTimeoutMs = input.avatarTimeoutMs ?? AVATAR_TIMEOUT_MS;
  const busyRetryMs = input.busyRetryMs ?? 20_000;

  return async (request) => {
    const portrait = await readFile(request.portraitPath);
    const audio = await readFile(request.audioPath);
    const created = await input.service.create({
      prompt: request.prompt?.trim() || DEFAULT_MINIMAX_PRESENTER_PROMPT,
      provider: 'local-sd',
      ...(request.model?.trim() ? { model: request.model.trim() } : {}),
      size: input.size ?? '1280x720',
      duration: clipDuration(request.durationSeconds),
      referenceImage: { mime: 'image/png', data: portrait.toString('base64') }
    }, { signal: request.signal });

    const completed = await waitForVideo({
      service: input.service,
      id: created.id,
      signal: request.signal,
      pollIntervalMs: videoPollMs,
      timeoutMs: videoTimeoutMs,
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress })
    });

    const raw = `${request.outputPath}.minimax.mp4`;
    try {
      await input.service.copyTo(completed.id, raw);
      const clip = await readFile(raw);
      request.onProgress?.({ message: 'Wav2Lip: lip-syncing the MiniMax clip' });
      const lipSynced = await runAvatarJob({
        base,
        signal: request.signal,
        body: JSON.stringify({
          video_b64: clip.toString('base64'),
          audio_b64: audio.toString('base64'),
          duration: request.durationSeconds > 0.5 ? request.durationSeconds : 4,
          engine: 'wav2lip',
          fps: 25
        }),
        pollIntervalMs: avatarPollMs,
        timeoutMs: avatarTimeoutMs,
        busyRetryMs
      });
      await writeFile(request.outputPath, lipSynced);
    } finally {
      await rm(raw, { force: true }).catch(() => undefined);
    }
  };
}

async function waitForVideo(input: {
  service: VideoGenerationService;
  id: string;
  signal: AbortSignal;
  pollIntervalMs: number;
  timeoutMs: number;
  onProgress?: (update: { percent?: number; message?: string }) => void;
}): Promise<VideoGenerationResult> {
  const deadline = Date.now() + input.timeoutMs;
  let lastPercent: number | undefined;
  for (;;) {
    input.signal.throwIfAborted();
    const result = await input.service.refresh(input.id, { signal: input.signal });
    if (result.status === 'completed') return result;
    if (result.status === 'failed') {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        `MiniMax-H3 video generation failed${result.error === undefined ? '' : `: ${result.error}`}`
      );
    }
    if (result.progressKnown === true && result.progress !== lastPercent) {
      lastPercent = result.progress;
      input.onProgress?.({
        percent: result.progress,
        message: `MiniMax-H3: ${result.status} (${result.progress}%)`
      });
    }
    if (Date.now() > deadline) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'MiniMax-H3 video generation timed out; shorten the slide or raise the timeout'
      );
    }
    await delay(input.pollIntervalMs, input.signal);
  }
}

async function runAvatarJob(input: {
  base: string;
  body: string;
  signal: AbortSignal;
  pollIntervalMs: number;
  timeoutMs: number;
  busyRetryMs: number;
}): Promise<Buffer> {
  const start = () => fetch(`${input.base}/v1/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: input.body,
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  });
  let started = await start();
  const busyUntil = Date.now() + AVATAR_BUSY_WAIT_MS;
  while (started.status === 429) {
    if (Date.now() > busyUntil) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'The talking-head service stayed busy for 40 minutes; check it on the GPU host.'
      );
    }
    await delay(input.busyRetryMs, input.signal);
    started = await start();
  }
  if (!started.ok) {
    const detail = await started.text().catch(() => '');
    throw new CreatorExecutorError(
      'course_presenter_failed',
      `The talking-head service failed to start the Wav2Lip pass (HTTP ${started.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
    );
  }
  const { id } = await started.json() as { id: string };
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    await delay(input.pollIntervalMs, input.signal);
    if (Date.now() > deadline) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'The Wav2Lip pass timed out; check the avatar service log.'
      );
    }
    const polled = await fetch(`${input.base}/v1/avatar/${id}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000)
    });
    if (polled.status === 404) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'The talking-head service lost the Wav2Lip job (did it restart?); retry the presenter stage.'
      );
    }
    if (!polled.ok) continue;
    const job = await polled.json() as AvatarJob;
    if (job.status === 'failed') {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        `The Wav2Lip pass failed${job.error ? `: ${job.error}` : ''}`
      );
    }
    if (job.status === 'done') break;
  }
  const content = await fetch(`${input.base}/v1/avatar/${id}/content`, {
    signal: AbortSignal.timeout(180_000)
  });
  if (!content.ok) {
    throw new CreatorExecutorError(
      'course_presenter_failed',
      `The talking-head service returned no clip (HTTP ${content.status})`
    );
  }
  const video = Buffer.from(await content.arrayBuffer());
  if (video.length === 0) {
    throw new CreatorExecutorError('course_presenter_failed', 'The Wav2Lip pass returned an empty clip');
  }
  return video;
}

function clipDuration(seconds: number): CreateVideoGenerationRequest['duration'] {
  const wanted = Number.isFinite(seconds) && seconds > 0 ? seconds : 4;
  const duration = CLIP_DURATIONS.find((value) => value >= Math.ceil(wanted)) ?? CLIP_DURATIONS.at(-1)!;
  return duration;
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
