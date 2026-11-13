import { execFile } from 'node:child_process';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';

/**
 * Last-resort presenter: a slow Ken Burns move over the portrait.
 *
 * Courses without a lip-sync command or a running video model used to render a
 * frozen portrait, which reads as a broken avatar. A 1-2 second CPU ffmpeg pass
 * per slide gives the picture gentle zoom/pan motion instead — still no lip
 * sync, but the presenter is visibly alive. Used only as the `auto` fallback.
 */
export function createPortraitMotionClipRunner(input: {
  ffmpegPath: string;
  width?: number;
  height?: number;
  fps?: number;
}): GeneratePresenterClip {
  const width = even(input.width ?? 720);
  const height = even(input.height ?? 480);
  const fps = input.fps ?? 30;
  const workWidth = even(width * 2);
  const workHeight = even(height * 2);

  return async (request) => {
    const seconds = Number.isFinite(request.durationSeconds) && request.durationSeconds > 0.5
      ? request.durationSeconds
      : 4;
    // 0.0007 zoom per frame ≈ 1.06x over 90 frames: enough to feel alive, not a dolly.
    const filter = [
      `scale=${workWidth}:${workHeight}:force_original_aspect_ratio=increase`,
      `crop=${workWidth}:${workHeight}`,
      `zoompan=z='min(1+0.0007*on,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
      'format=yuv420p'
    ].join(',');
    await new Promise<void>((resolve, reject) => {
      execFile(input.ffmpegPath, [
        '-y',
        '-loglevel', 'error',
        '-loop', '1',
        '-i', request.portraitPath,
        '-t', seconds.toFixed(3),
        '-vf', filter,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-movflags', '+faststart',
        request.outputPath
      ], { signal: request.signal, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error) => {
        if (error) {
          reject(new CreatorExecutorError(
            'course_presenter_failed',
            `Could not animate the presenter portrait: ${error.message}`
          ));
        } else {
          resolve();
        }
      });
    });
  };
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
