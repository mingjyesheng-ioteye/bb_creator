import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { CourseLessonModule } from '@opencreator/protocol';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { COURSE_VIDEO_FPS } from './constants.js';

export type CourseAvatarClip = { slideId: string; path: string };

export type PresenterEngine = 'sadtalker' | 'musetalk' | 'wav2lip' | 'latentsync';

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
  /** Narration length of the slide, in seconds (0 when the slide is silent). */
  durationSeconds: number;
  /** Optional video model id (MiniMax-H3) and motion prompt from the job state. */
  model?: string;
  prompt?: string;
  /** Lip-sync engine on the avatar service; omit for the service default. */
  engine?: PresenterEngine;
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
  /**
   * Lip-sync clip generator. Omit it when no presenter command is configured:
   * the imported portrait then renders as a static avatar instead of producing
   * clip paths whose files were never written.
   */
  generateClip?: GeneratePresenterClip;
  /**
   * Video-model clip generator (the local Unsloth / MiniMax-H3 video
   * model). It animates the portrait with head motion and gestures; it does not
   * lip-sync, so the narration audio still comes from the lesson track.
   */
  generateModelClip?: GeneratePresenterClip;
  /**
   * Cheap CPU fallback (Ken Burns over the portrait). `auto` uses it when no
   * lip-sync command is configured and the video model is unreachable, so the
   * presenter is never just a frozen still.
   */
  generateMotionClip?: GeneratePresenterClip;
  /** Real lip-sync talking head (MuseTalk on the Windows GPU, over HTTP). */
  generateTalkingClip?: GeneratePresenterClip;
  /**
   * Optional reachability probe for the model backend. `auto` only uses the
   * video model when this resolves true, so a host without Unsloth keeps
   * rendering the static portrait instead of failing the stage.
   */
  canUseModelClip?(): Promise<boolean>;
  /** Reachability probe for the talking-head service. */
  canUseTalkingClip?(): Promise<boolean>;
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

      const portraitPath = stage.job.state.presenterEnabled === false
        ? ''
        : readString(stage.job.state.portraitPath) || await input.resolvePortrait(readString(stage.job.state.portraitPath));
      const only = readIndexList(stage.job.state.presenterSlides);
      const total = lesson.slides.length;
      const clips: CourseAvatarClip[] = [];
      const backend = readBackend(stage.job.state.presenterBackend);
      const engine: PresenterEngine | undefined =
        backend === 'wav2lip' || backend === 'latentsync' ? backend : undefined;
      const model = readString(stage.job.state.presenterModel);
      const prompt = readString(stage.job.state.presenterPrompt);
      const generateClip = await resolveClipGenerator({
        backend,
        commandClip: input.generateClip,
        modelClip: input.generateModelClip,
        talkingClip: input.generateTalkingClip,
        motionClip: input.generateMotionClip,
        canUseModelClip: input.canUseModelClip,
        canUseTalkingClip: input.canUseTalkingClip
      });

      if (portraitPath && generateClip !== undefined) {
        const targets: Array<{ index: number; slideId: string; audioPath: string; durationSeconds: number }> = [];
        for (let index = 0; index < total; index += 1) {
          const slide = lesson.slides[index]!;
          if (!slide.audioSrc) continue;
          if (only !== undefined && !only.includes(index)) continue;
          targets.push({
            index,
            slideId: slide.id,
            audioPath: slide.audioSrc,
            durationSeconds: (slide.durationInFrames ?? 0) / COURSE_VIDEO_FPS
          });
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
        // The video model is a single GPU queue: run one clip at a time so the
        // Unsloth server does not thrash VRAM (the command backend can fan out).
        // The video model and the talking-head service are single-GPU backends:
        // run one clip at a time. ffmpeg motion clips can fan out on the CPU.
        const concurrency = generateClip === input.generateModelClip
          || generateClip === input.generateTalkingClip
          ? 1
          : resolvePresenterConcurrency(input.concurrency);
        await mapWithConcurrency(targets, concurrency, async (target, position) => {
          const outputPath = join(stage.workdir, `avatar-${String(target.index).padStart(2, '0')}.mp4`);
          await generateClip({
            portraitPath,
            audioPath: target.audioPath,
            outputPath,
            slideId: target.slideId,
            index: target.index,
            durationSeconds: target.durationSeconds,
            ...(engine ? { engine } : {}),
            ...(model ? { model } : {}),
            ...(prompt ? { prompt } : {}),
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
            presenterBackend: generateClip === undefined
              ? 'none'
              : generateClip === input.generateModelClip
                ? 'minimax'
                : generateClip === input.generateTalkingClip
                  ? (engine ?? 'talkinghead')
                  : generateClip === input.generateMotionClip ? 'motion' : 'command',
            ...(model ? { presenterModel: model } : {}),
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

const DEFAULT_PRESENTER_CONCURRENCY_CAP = 8;

/**
 * Resolve how many talking-head clips to generate in parallel. Each clip is a
 * separate CPU/GPU-heavy process. The Wav2Lip wrapper caps each clip's thread
 * pools (OMP_NUM_THREADS etc.) so parallelism scales with cores instead of
 * thrashing; without that cap, 8 parallel clips were slower than sequential.
 * Defaults to a CPU-derived value capped at 8.
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

/** Presenter engine: lip-sync command, talking-head service, or a video model. */
export type CoursePresenterBackend =
  | 'auto'
  | 'command'
  | 'locmodel'
  | 'minimax'
  | 'talkinghead'
  | 'wav2lip'
  | 'latentsync';

function readBackend(value: unknown): CoursePresenterBackend {
  // `locmodel` is the pre-Unsloth name for the video-model backend; old jobs and
  // saved sessions still carry it.
  if (value === 'locmodel') return 'minimax';
  return value === 'command'
    || value === 'minimax'
    || value === 'talkinghead'
    || value === 'wav2lip'
    || value === 'latentsync'
    ? value
    : 'auto';
}

/**
 * Pick the clip generator for the requested backend. `auto` prefers the
 * lip-sync command (exact mouth movement) and falls back to the video model —
 * but only when the model server actually answers, so a course that used to
 * render a static portrait keeps rendering instead of failing. An explicit
 * `minimax` that cannot be reached fails loudly.
 */
async function resolveClipGenerator(input: {
  backend: CoursePresenterBackend;
  commandClip: GeneratePresenterClip | undefined;
  modelClip: GeneratePresenterClip | undefined;
  talkingClip: GeneratePresenterClip | undefined;
  motionClip: GeneratePresenterClip | undefined;
  canUseModelClip: (() => Promise<boolean>) | undefined;
  canUseTalkingClip: (() => Promise<boolean>) | undefined;
}): Promise<GeneratePresenterClip | undefined> {
  if (input.backend === 'command') return input.commandClip;
  if (input.backend === 'minimax') {
    if (input.modelClip === undefined) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'The MiniMax-H3 presenter is not available. Start Unsloth Studio and load a video model in its local video settings.'
      );
    }
    if (input.canUseModelClip !== undefined && !(await input.canUseModelClip())) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'Unsloth Studio has no video model available. Load MiniMax-H3 (or enable Settings → API → Model auto-switch), then retry the presenter stage.'
      );
    }
    return input.modelClip;
  }
  if (input.backend === 'wav2lip' || input.backend === 'latentsync') {
    if (input.talkingClip === undefined) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'The talking-head service is not configured. Set OPENCREATOR_TALKING_HEAD_URL and start the avatar service on the GPU host.'
      );
    }
    if (input.canUseTalkingClip !== undefined && !(await input.canUseTalkingClip())) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'The talking-head service is not reachable. Start the avatar service on the GPU host, then retry the presenter stage.'
      );
    }
    return input.talkingClip;
  }
  if (input.backend === 'talkinghead') {
    if (input.talkingClip === undefined) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'The talking-head service is not configured. Set OPENCREATOR_TALKING_HEAD_URL and start the avatar service on the GPU host.'
      );
    }
    if (input.canUseTalkingClip !== undefined && !(await input.canUseTalkingClip())) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'The talking-head service is not reachable. Start the avatar service on the GPU host, then retry the presenter stage.'
      );
    }
    return input.talkingClip;
  }
  // `auto` prefers the GPU talking head, then a lip-sync command (CPU fallback),
  // then the cheap Ken Burns pass. MiniMax-H3 is excluded here on
  // purpose: it does not lip-sync and takes ~20 minutes per 4-second clip.
  if (input.talkingClip !== undefined
      && (input.canUseTalkingClip === undefined || await input.canUseTalkingClip())) {
    return input.talkingClip;
  }
  if (input.commandClip !== undefined) return input.commandClip;
  return input.motionClip;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readIndexList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const indices = value.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0);
  return indices.length > 0 ? indices : undefined;
}
