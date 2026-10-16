import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  courseLessonCanvasForRatio,
  courseLessonTotalFrames,
  readCourseLessonRatio,
  type CourseLessonModule
} from '@opencreator/protocol';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { readStickmanRemotionRuntime, type StickmanRemotionRuntime } from '../stickman/remotion-runtime.js';
import { validateMediaFile } from '../validators/media.js';
import { COURSE_VIDEO_FPS } from './constants.js';
import type { CourseRenderRequest } from './render-contract.js';

type ValidateVideo = (path: string, ffprobePath: string) => Promise<{
  duration: number;
  width?: number;
  height?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}>;

/**
 * Renders the narrated course lesson with the shared `CourseLessonLandscape`
 * composition from the managed Remotion component. The worker starts a local
 * asset server for the per-slide narration clips, so media never needs to be
 * embedded in the props.
 */
export function createCourseRenderExecutor(input: {
  ffprobePath: string;
  runtimeRoot: string;
  workerEntrypoint?: string;
  runtime?: StickmanRemotionRuntime;
  ensureRuntime?(stage: Parameters<CreatorExecutor['run']>[0]): Promise<StickmanRemotionRuntime>;
  validateVideo?: ValidateVideo;
}): CreatorExecutor {
  const validateVideo = input.validateVideo ?? validateMediaFile;
  return {
    id: 'course-video-remotion',
    async run(stage) {
      const artifact = stage.inputArtifacts.find((candidate) => (
        candidate.kind === 'course-narrated-lesson' && candidate.status === 'completed'
      ));
      if (artifact?.path === null || artifact?.path === undefined) {
        throw new CreatorExecutorError('creator_stage_input_missing', 'The narrated course lesson is required');
      }
      const lesson = JSON.parse(await readFile(artifact.path, 'utf8')) as CourseLessonModule;
      const ratio = readCourseLessonRatio(stage.job.state.ratio);
      const canvas = courseLessonCanvasForRatio(ratio);
      const fps = COURSE_VIDEO_FPS;
      const totalFrames = courseLessonTotalFrames(lesson, fps);

      const runtime = input.runtime ?? (input.ensureRuntime
        ? await input.ensureRuntime(stage)
        : readStickmanRemotionRuntime(input.runtimeRoot));
      const outputPath = join(stage.workdir, 'lesson.mp4');
      const requestPath = join(stage.workdir, 'course-render-request.json');
      const resultPath = join(stage.workdir, 'course-render-result.json');
      const request: CourseRenderRequest = {
        lessonPath: artifact.path,
        outputPath,
        bundlePath: runtime.bundlePath,
        browserExecutable: runtime.browserExecutable,
        ...(runtime.rendererEntry ? { rendererEntry: runtime.rendererEntry } : {}),
        workdir: stage.workdir,
        jobRoot: dirname(stage.workdir),
        runtimeRoot: runtime.root,
        ratio,
        fps,
        width: canvas.width,
        height: canvas.height,
        totalFrames
      };
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

      const workerEntrypoint = input.workerEntrypoint ?? resolveDefaultWorkerEntrypoint();
      try {
        stage.reportProgress({ phase: 'rendering', percent: 5, message: 'Rendering course lesson.' });
        await runWorker(workerEntrypoint, requestPath, resultPath, stage.signal);
        const result = JSON.parse(await readFile(resultPath, 'utf8')) as { ok?: boolean; error?: string };
        if (result.ok !== true) {
          throw new CreatorExecutorError('course_render_failed', result.error ?? 'Course render worker failed');
        }
        const media = await validateVideo(outputPath, input.ffprobePath);
        const expectedDuration = totalFrames / fps;
        const tolerance = Math.max(0.15, 2 / fps);
        if (
          media.width !== canvas.width
          || media.height !== canvas.height
          || !media.hasVideo
          || !media.hasAudio
          || Math.abs(media.duration - expectedDuration) > tolerance
        ) {
          throw new CreatorExecutorError(
            'course_render_invalid',
            `Rendered video must be decodable ${canvas.width}x${canvas.height} media with matching audio duration`
          );
        }
        return {
          outputs: [{
            kind: 'course-video',
            status: 'completed',
            path: outputPath,
            sourceArtifactIds: [artifact.id],
            metadata: {
              ...media,
              ratio,
              fps,
              totalFrames,
              fileName: 'lesson.mp4',
              mimeType: 'video/mp4',
              renderEngine: 'remotion',
              renderKind: 'course-lesson'
            }
          }]
        };
      } catch (error) {
        await Promise.all([rm(outputPath, { force: true }), rm(resultPath, { force: true })]);
        if (stage.signal.aborted) {
          throw new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled');
        }
        throw error;
      }
    }
  };
}

function runWorker(
  workerEntrypoint: string,
  requestPath: string,
  resultPath: string,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CreatorExecutorError('creator_stage_canceled', 'Creator stage was canceled'));
      return;
    }
    const isTypeScript = extname(workerEntrypoint).toLowerCase() === '.ts';
    const worker = new Worker(pathToFileURL(workerEntrypoint), {
      argv: [requestPath, resultPath],
      execArgv: isTypeScript
        ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]
        : [],
      stderr: true
    });
    let stderr = '';
    let settled = false;
    worker.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => { void worker.terminate(); };
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', (error) => fail(new CreatorExecutorError('course_render_worker_failed', error.message)));
    worker.once('exit', async (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve();
      else {
        const result = await readFile(resultPath, 'utf8')
          .then((contents) => JSON.parse(contents) as { ok?: boolean; error?: string })
          .catch(() => null);
        reject(new CreatorExecutorError(
          result?.ok === false ? 'course_render_failed' : 'course_render_worker_failed',
          result?.error || stderr.slice(-2_000) || `Course render worker exited with code ${code}`
        ));
      }
    });
  });
}

function resolveDefaultWorkerEntrypoint(): string {
  const sourceExtension = extname(fileURLToPath(import.meta.url)).toLowerCase();
  const workerExtension = sourceExtension === '.ts' ? '.ts' : '.js';
  return fileURLToPath(new URL(`./render-worker${workerExtension}`, import.meta.url));
}
