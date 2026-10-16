import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
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
  /** Max clips generated in parallel. Defaults to OPENCREATOR_PRESENTER_CONCURRENCY or a CPU-based value. */
  concurrency?: number;
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
        const targets: Array<{ index: number; slideId: string; audioPath: string }> = [];
        for (let index = 0; index < total; index += 1) {
          const slide = lesson.slides[index]!;
          if (!slide.audioSrc) continue;
          if (only !== undefined && !only.includes(index)) continue;
          targets.push({ index, slideId: slide.id, audioPath: slide.audioSrc });
        }
        const generated: Array<CourseAvatarClip | undefined> = new Array(targets.length);
        let done = 0;
        const report = () => stage.reportProgress({
          phase: 'generating_presenter',
          percent: targets.length === 0 ? 100 : Math.round((done / targets.length) * 100),
          completed: done,
          failed: 0,
          total: targets.length
        });
        report();
        await mapWithConcurrency(targets, resolvePresenterConcurrency(input.concurrency), async (target, position) => {
          const outputPath = join(stage.workdir, `avatar-${String(target.index).padStart(2, '0')}.mp4`);
          await input.generateClip({
            portraitPath,
            audioPath: target.audioPath,
            outputPath,
            slideId: target.slideId,
            index: target.index,
            signal: stage.signal
          });
          generated[position] = { slideId: target.slideId, path: outputPath };
          done += 1;
          report();
        });
        for (const clip of generated) {
          if (clip) clips.push(clip);
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

const DEFAULT_PRESENTER_CONCURRENCY_CAP = 4;

/**
 * Resolve how many talking-head clips to generate in parallel. Each clip is a
 * separate CPU/GPU-heavy process, so too much parallelism oversubscribes the
 * machine (measured: 4 is ~2x faster than sequential, 8 is slower than
 * sequential). Defaults to a CPU-derived value capped at 4.
 */
function resolvePresenterConcurrency(requested: number | undefined): number {
  if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 1) {
    return requested;
  }
  const fromEnv = Number(process.env.OPENCREATOR_PRESENTER_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) {
    return fromEnv;
  }
  return Math.max(1, Math.min(DEFAULT_PRESENTER_CONCURRENCY_CAP, Math.floor(cpus().length / 4)));
}

/** Run `fn` over `items` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  const run = async () => {
    while (true) {
      const current = next;
      next += 1;
      if (current >= items.length) return;
      await fn(items[current]!, current);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readIndexList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const indices = value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0);
  return indices.length > 0 ? indices : undefined;
}
