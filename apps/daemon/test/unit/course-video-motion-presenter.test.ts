import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortraitMotionClipRunner } from '../../src/creator/course-video/motion-presenter.js';
import { resolveCreatorExecutable } from '../../src/creator/media-tools.js';

const ffmpeg = resolveCreatorExecutable({ name: 'ffmpeg' });
let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe.skipIf(ffmpeg === undefined)('portrait motion presenter', () => {
  it('turns the portrait into a clip as long as the slide', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'motion-presenter-'));
    const portraitPath = join(tempDir, 'portrait.png');
    execFileSync(ffmpeg!, [
      '-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=#334155:s=480x640', '-frames:v', '1', portraitPath
    ]);
    const outputPath = join(tempDir, 'motion.mp4');

    await createPortraitMotionClipRunner({ ffmpegPath: ffmpeg! })({
      portraitPath,
      audioPath: join(tempDir, 'narration.mp3'),
      outputPath,
      slideId: 'm01:title',
      index: 0,
      durationSeconds: 3,
      signal: new AbortController().signal
    });

    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(1_000);
  }, 30_000);
});
