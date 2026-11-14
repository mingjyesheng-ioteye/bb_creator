import { execFile } from 'node:child_process';
import { readFile, rename, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import type {
  CreateVideoGenerationRequest,
  VideoGenerationResult
} from '@opencreator/protocol';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';
import type { VideoGenerationService } from '../../video-generation/service.js';

/** Motion prompt used when the job does not specify one. */
export const DEFAULT_MINIMAX_PRESENTER_PROMPT =
  'The presenter looks straight at the camera and speaks warmly, natural head movement, '
  + 'occasional blink, relaxed posture and subtle hand gestures, steady framing, '
  + 'soft studio lighting, photorealistic';

/** The local video API accepts 4/5/6/8/10 second jobs; longer slides loop. */
const CLIP_DURATIONS = [4, 5, 6, 8, 10] as const;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 45 * 60_000;

/**
 * Generates the presenter clip with the **local video model**
 * (Unsloth Studio, image-to-video from the portrait).
 *
 * The model animates the portrait (head motion, blinks, gestures) but does not
 * consume the narration audio, so there is no lip-sync: the lesson keeps its own
 * narration track and the composition mutes the clip. Clips shorter than the
 * slide are looped with ffmpeg so the presenter keeps moving for the whole slide.
 */
export function createMinimaxPresenterClipRunner(input: {
  service: VideoGenerationService;
  /** ffmpeg from the creator runtime; without it the raw webm is kept. */
  ffmpegPath?: string;
  /** Output size of the model job. Defaults to 16:9 720p. */
  size?: CreateVideoGenerationRequest['size'];
  pollIntervalMs?: number;
  timeoutMs?: number;
}): GeneratePresenterClip {
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    const portrait = await readFile(request.portraitPath);
    const mime = referenceImageMime(request.portraitPath);
    const duration = clipDuration(request.durationSeconds);
    const created = await input.service.create({
      prompt: request.prompt?.trim() || DEFAULT_MINIMAX_PRESENTER_PROMPT,
      provider: 'local-sd',
      ...(request.model?.trim() ? { model: request.model.trim() } : {}),
      size: input.size ?? '1280x720',
      duration,
      referenceImage: { mime, data: portrait.toString('base64') }
    }, { signal: request.signal });

    const completed = await waitForCompletion({
      service: input.service,
      id: created.id,
      signal: request.signal,
      pollIntervalMs,
      timeoutMs
    });

    const raw = `${request.outputPath}.render`;
    try {
      await input.service.copyTo(completed.id, raw);
      if (input.ffmpegPath === undefined) {
        await rename(raw, request.outputPath);
        return;
      }
      await loopToMp4(input.ffmpegPath, raw, request.outputPath, request.durationSeconds, request.signal);
    } finally {
      await rm(raw, { force: true });
    }
  };
}

async function waitForCompletion(input: {
  service: VideoGenerationService;
  id: string;
  signal: AbortSignal;
  pollIntervalMs: number;
  timeoutMs: number;
}): Promise<VideoGenerationResult> {
  const deadline = Date.now() + input.timeoutMs;
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
    if (Date.now() > deadline) {
      throw new CreatorExecutorError(
        'course_presenter_failed',
        'MiniMax-H3 video generation timed out; shorten the slide, lower the clip size, or raise the timeout'
      );
    }
    await delay(input.pollIntervalMs, input.signal);
  }
}

function clipDuration(seconds: number): CreateVideoGenerationRequest['duration'] {
  const wanted = Number.isFinite(seconds) && seconds > 0 ? seconds : 4;
  const duration = CLIP_DURATIONS.find((value) => value >= Math.ceil(wanted)) ?? CLIP_DURATIONS.at(-1)!;
  return duration;
}

function referenceImageMime(path: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const extension = extname(path).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

/** Loop the generated clip to the slide length and normalise it to mp4. */
function loopToMp4(
  ffmpegPath: string,
  source: string,
  destination: string,
  seconds: number,
  signal: AbortSignal
): Promise<void> {
  const target = Number.isFinite(seconds) && seconds > 0.5 ? seconds : 4;
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y',
      '-stream_loop', '-1',
      '-i', source,
      '-t', target.toFixed(3),
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      destination
    ], { signal, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error) => {
      if (error) {
        reject(new CreatorExecutorError(
          'course_presenter_failed',
          `Could not prepare the MiniMax-H3 presenter clip: ${error.message}`
        ));
      } else {
        resolve();
      }
    });
  });
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
