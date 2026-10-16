import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CourseLessonModule } from '@opencreator/protocol';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';

export type CourseAvatarClip = { slideId: string; path: string };

export type CourseAvatarManifest = {
  portraitPath: string;
  clips: CourseAvatarClip[];
};

export type GeneratePresenterClip = (request: {
  portraitPath: string;
  audioPath: string;
  outputPath: string;
  slideId: string;
  index: number;
  signal: AbortSignal;
}) => Promise<void>;

/**
 * Generates one lip-synced talking-head clip per slide from the slide's
 * narration audio plus a presenter portrait, and writes a `course-avatar`
 * manifest. When no portrait is available it writes an empty manifest, so the
 * render falls back to the static presenter portrait.
 */
export function createCoursePresenterExecutor(input: {
  resolvePortrait(statePortrait: string): Promise<string>;
  generateClip: GeneratePresenterClip;
}): CreatorExecutor {
  return {
    id: 'course-presenter',
    async run(stage) {
      const artifact = stage.inputArtifacts.find((candidate) => (
        candidate.kind === 'course-narrated-lesson' && candidate.status === 'completed'
      ));
      if (artifact?.path === null || artifact?.path === undefined) {
        throw new CreatorExecutorError('creator_stage_input_missing', 'The narrated course lesson is required');
      }
      const lesson = JSON.parse(await readFile(artifact.path, 'utf8')) as CourseLessonModule;

      const portraitPath = readString(stage.job.state.portraitPath) || await input.resolvePortrait(readString(stage.job.state.portraitPath));
      const only = readIndexList(stage.job.state.presenterSlides);
      const total = lesson.slides.length;
      const clips: CourseAvatarClip[] = [];

      if (portraitPath) {
        for (let index = 0; index < total; index += 1) {
          const slide = lesson.slides[index]!;
          if (!slide.audioSrc) continue;
          if (only !== undefined && !only.includes(index)) continue;
          stage.reportProgress({
            phase: 'generating_presenter',
            percent: Math.round((index / total) * 100),
            completed: index,
            failed: 0,
            total
          });
          const outputPath = join(stage.workdir, `avatar-${String(index).padStart(2, '0')}.mp4`);
          await input.generateClip({
            portraitPath,
            audioPath: slide.audioSrc,
            outputPath,
            slideId: slide.id,
            index,
            signal: stage.signal
          });
          clips.push({ slideId: slide.id, path: outputPath });
        }
      }

      const manifest: CourseAvatarManifest = { portraitPath, clips };
      const path = join(stage.workdir, 'course-avatar.json');
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
      stage.reportProgress({ phase: 'completed', percent: 100, completed: total, failed: 0, total });
      return {
        outputs: [{
          kind: 'course-avatar',
          status: 'completed',
          path,
          sourceArtifactIds: [artifact.id],
          metadata: {
            portraitPath,
            clipCount: clips.length,
            skipped: portraitPath ? 0 : 1,
            fileName: 'course-avatar.json',
            mimeType: 'application/json'
          }
        }]
      };
    }
  };
}

/**
 * Default clip generator: runs a lip-sync command template. Placeholders
 * `{portrait}`, `{audio}` and `{out}` are substituted; the command runs through
 * a shell so wrapper scripts and absolute paths work.
 */
export function createCommandPresenterClipRunner(input: {
  command: string;
  cwd?: string;
}): GeneratePresenterClip {
  return async (request) => {
    const command = input.command
      .replaceAll('{portrait}', shellQuote(request.portraitPath))
      .replaceAll('{audio}', shellQuote(request.audioPath))
      .replaceAll('{out}', shellQuote(request.outputPath));
    await runShell(command, input.cwd, request.signal);
  };
}

function runShell(command: string, cwd: string | undefined, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-lc', command], {
      ...(cwd === undefined ? {} : { cwd }),
      signal,
      timeout: 3_600_000,
      maxBuffer: 64 * 1024 * 1024
    }, (error) => {
      if (error) reject(new CreatorExecutorError('course_presenter_failed', `Presenter command failed: ${error.message}`));
      else resolve();
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readIndexList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const indices = value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0);
  return indices.length > 0 ? indices : undefined;
}
