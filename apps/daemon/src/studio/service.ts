import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { delimiter, extname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { existsSync } from 'node:fs';
import type {
  CreateStudioJobRequest,
  StudioCapabilitiesResponse,
  StudioCapability,
  StudioComponentStatus,
  StudioJob,
  StudioRunnerId,
  StudioUploadResponse
} from '@opencreator/protocol';
import type { VideoGenerationService } from '../video-generation/service.js';
import {
  StudioValidationError,
  capabilityDefinitions,
  findCapability,
  publicParams,
  resolveParams,
  type CapabilityDefinition
} from './catalog.js';
import { comfyHealth, comfyInstalledModels, missingWanFiles, STILL_CHECKPOINT } from './comfyui.js';
import { listPiperVoices, pythonHasFasterWhisper, type StudioEnvironment } from './environment.js';
import { isStudioJobId, createStudioJobStore } from './jobs.js';
import { runStudioCapability } from './runners.js';
import { createStudioWorker, type UnslothVideoProbe } from './worker.js';

export class StudioError extends Error {
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'STUDIO_JOB_NOT_FOUND' | 'STUDIO_UPLOAD_NOT_FOUND' | 'STUDIO_MEDIA_NOT_READY' | 'STUDIO_STORAGE_FAILED',
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

const HEAVY_RUNNERS = new Set<StudioRunnerId>([
  'wan-text-to-video', 'wan-image-to-video', 'minimax-text-to-video', 'minimax-image-to-video',
  'narrated-visual', 'world', 'motion', 'captions'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const UPLOAD_ID = /^[a-f0-9]{16}$/;
const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = 30_000;

export type StudioService = ReturnType<typeof createStudioService>;

export function createStudioService(input: {
  env: StudioEnvironment;
  videoGeneration?: VideoGenerationService;
  unslothVideo: () => Promise<UnslothVideoProbe>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const { env } = input;
  const now = input.now ?? (() => new Date());
  const store = createStudioJobStore({ root: env.jobsRoot, now });
  const worker = createStudioWorker({ env, unslothVideo: input.unslothVideo, now });
  const controllers = new Map<string, AbortController>();
  const lanes = {
    heavy: { limit: 1, active: 0, queue: [] as Array<() => void> },
    light: { limit: 2, active: 0, queue: [] as Array<() => void> }
  };
  let statusCache: { at: number; value: StudioCapabilitiesResponse } | undefined;
  let whisperCache: { at: number; ok: boolean } | undefined;
  let ready: Promise<void> | undefined;

  function startup(): Promise<void> {
    ready ??= (async () => {
      await mkdir(env.uploadsRoot, { recursive: true, mode: 0o700 });
      await mkdir(env.jobsRoot, { recursive: true, mode: 0o700 });
      await store.recoverInterrupted();
      await pruneUploads();
    })();
    return ready;
  }

  async function pruneUploads(): Promise<void> {
    const cutoff = Date.now() - UPLOAD_RETENTION_MS;
    for (const name of await readdir(env.uploadsRoot).catch(() => [] as string[])) {
      const path = join(env.uploadsRoot, name);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && info.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  function onPath(command: string | undefined): boolean {
    if (command === undefined) return false;
    if (command.includes('/')) return existsSync(command);
    return (process.env.PATH ?? '').split(delimiter).some(dir => dir.length > 0 && existsSync(join(dir, command)));
  }

  async function hasWhisper(): Promise<boolean> {
    if (env.python === undefined) return false;
    if (whisperCache !== undefined && Date.now() - whisperCache.at < 5 * 60_000) return whisperCache.ok;
    const ok = await pythonHasFasterWhisper(env.python);
    whisperCache = { at: Date.now(), ok };
    return ok;
  }

  async function computeStatus(): Promise<StudioCapabilitiesResponse> {
    const voices = listPiperVoices(env.voicesDir);
    const [comfy, models, unsloth, whisper] = await Promise.all([
      comfyHealth(env.comfyUrl),
      comfyInstalledModels(env.comfyUrl),
      input.unslothVideo(),
      hasWhisper()
    ]);
    const ffmpeg = env.ffmpeg !== undefined;
    const ffprobe = env.ffprobe !== undefined;
    const piper = env.piper !== undefined && voices.length > 0;
    const hyperframes = onPath(env.hyperframes[0]);
    const wanReason = (mode: 'text' | 'image'): string => {
      if (!comfy.online) return 'GPU worker offline: start ComfyUI from this page';
      if (models === undefined) return '';
      const missing = missingWanFiles(models, mode);
      return missing.length === 0 ? '' : `ComfyUI is missing ${missing.join(', ')}`;
    };
    const reasons: Record<StudioRunnerId, string> = {
      'wan-text-to-video': wanReason('text'),
      'wan-image-to-video': wanReason('image'),
      'minimax-text-to-video': unsloth.online ? '' : unsloth.reason,
      'minimax-image-to-video': unsloth.online ? '' : unsloth.reason,
      'narrated-visual': !comfy.online
        ? 'GPU worker offline: start ComfyUI from this page'
        : models !== undefined && !models.CheckpointLoaderSimple?.includes(STILL_CHECKPOINT)
          ? `ComfyUI is missing ${STILL_CHECKPOINT}`
          : !piper ? 'Piper voices are not installed (run pnpm studio:setup)' : !ffmpeg ? 'ffmpeg is not installed' : '',
      world: hyperframes ? '' : 'HyperFrames needs Node.js (npx) on PATH',
      motion: hyperframes ? '' : 'HyperFrames needs Node.js (npx) on PATH',
      documentary: ffmpeg && ffprobe ? '' : 'ffmpeg and ffprobe are not installed',
      trim: ffmpeg ? '' : 'ffmpeg is not installed',
      reframe: ffmpeg && ffprobe ? '' : 'ffmpeg and ffprobe are not installed',
      grade: ffmpeg ? '' : 'ffmpeg is not installed',
      captions: !ffmpeg ? 'ffmpeg is not installed' : whisper ? '' : 'faster-whisper is not installed (run pnpm studio:setup)',
      speech: piper ? '' : 'Piper voices are not installed (run pnpm studio:setup)',
      upscale: ffmpeg ? '' : 'ffmpeg is not installed',
      course: ''
    };
    const components: StudioComponentStatus[] = [
      { id: 'ffmpeg', label: 'ffmpeg', available: ffmpeg && ffprobe, detail: env.ffmpeg ?? 'not found' },
      { id: 'piper', label: 'Piper voices', available: piper, detail: piper ? `${voices.length} voice(s)` : 'not installed' },
      { id: 'whisper', label: 'faster-whisper', available: whisper, detail: whisper ? 'ready' : 'not installed' },
      { id: 'comfyui', label: 'ComfyUI', available: comfy.online, detail: comfy.online ? 'online' : 'offline' },
      { id: 'unsloth', label: 'Unsloth video', available: unsloth.online, detail: unsloth.online ? 'model loaded' : unsloth.reason },
      { id: 'hyperframes', label: 'HyperFrames', available: hyperframes, detail: env.hyperframes.join(' ') }
    ];
    return {
      capabilities: capabilityDefinitions.map((definition): StudioCapability => {
        const { defaults: _defaults, ...rest } = definition;
        const reason = reasons[definition.runner];
        return { ...rest, params: publicParams(definition, voices), runnable: reason === '', reason };
      }),
      components,
      checkedAt: now().toISOString()
    };
  }

  async function capabilities(refresh = false): Promise<StudioCapabilitiesResponse> {
    if (!refresh && statusCache !== undefined && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    const value = await computeStatus();
    statusCache = { at: Date.now(), value };
    return value;
  }

  // ---- uploads -----------------------------------------------------------------

  async function readUpload(id: string): Promise<{ path: string; kind: 'image' | 'video'; fileName: string }> {
    if (!UPLOAD_ID.test(id)) throw new StudioError('STUDIO_UPLOAD_NOT_FOUND', 'Upload not found', 404);
    try {
      const meta = JSON.parse(await readFile(join(env.uploadsRoot, `${id}.json`), 'utf8')) as {
        fileName: string; kind: 'image' | 'video'; extension: string;
      };
      return { path: join(env.uploadsRoot, `${id}${meta.extension}`), kind: meta.kind, fileName: meta.fileName };
    } catch {
      throw new StudioError('STUDIO_UPLOAD_NOT_FOUND', 'Upload not found', 404);
    }
  }

  async function saveUpload(request: { fileName: string; source: Readable }): Promise<StudioUploadResponse> {
    await startup();
    const extension = extname(request.fileName).toLowerCase();
    const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : undefined;
    if (kind === undefined) throw new StudioError('VALIDATION_FAILED', 'Unsupported file type', 400);
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    const id = randomBytes(8).toString('hex');
    const path = join(env.uploadsRoot, `${id}${extension}`);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) callback(new StudioError('VALIDATION_FAILED', 'The file is too large', 413));
        else callback(null, chunk);
      }
    });
    try {
      await pipeline(request.source, counter, createWriteStream(path, { mode: 0o600 }));
    } catch (error) {
      await rm(path, { force: true });
      if (error instanceof StudioError) throw error;
      throw new StudioError('STUDIO_STORAGE_FAILED', 'The upload could not be stored', 500);
    }
    if (bytes === 0) {
      await rm(path, { force: true });
      throw new StudioError('VALIDATION_FAILED', 'The upload is empty', 400);
    }
    const fileName = request.fileName.replace(/[^\w .()-]/g, '_').slice(0, 120) || `upload${extension}`;
    await writeFile(join(env.uploadsRoot, `${id}.json`), JSON.stringify({ fileName, kind, extension }), { mode: 0o600 });
    return { id, fileName, bytes, kind };
  }

  // ---- jobs ------------------------------------------------------------------------

  function schedule(lane: keyof typeof lanes, start: () => Promise<void>): void {
    const target = lanes[lane];
    const launch = () => {
      target.active += 1;
      void start().finally(() => {
        target.active -= 1;
        target.queue.shift()?.();
      });
    };
    if (target.active < target.limit) launch();
    else target.queue.push(launch);
  }

  async function execute(job: StudioJob, definition: CapabilityDefinition, request: {
    prompt: string; params: Record<string, string | number>; inputPath?: string;
  }): Promise<void> {
    const controller = controllers.get(job.id);
    if (controller === undefined || controller.signal.aborted) {
      await store.update(job.id, { status: 'cancelled', finishedAt: now().toISOString() });
      controllers.delete(job.id);
      return;
    }
    const outputPath = store.outputPath(job);
    let log: string[] = [];
    let pending: Partial<StudioJob> = {};
    let dirty = false;
    let timer: NodeJS.Timeout | undefined;
    const flush = async () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!dirty) return;
      const patch = pending;
      pending = {};
      dirty = false;
      await store.update(job.id, { ...patch, log });
    };
    const queueFlush = () => { timer ??= setTimeout(() => void flush(), 700); };
    await store.update(job.id, { status: 'running', startedAt: now().toISOString() });
    try {
      await runStudioCapability({
        definition,
        prompt: request.prompt,
        params: request.params,
        ...(request.inputPath === undefined ? {} : { inputPath: request.inputPath }),
        jobDir: store.directory(job.id),
        outputPath,
        env,
        signal: controller.signal,
        report: update => {
          pending = { ...pending, ...(update.percent === undefined ? {} : { percent: update.percent }), ...(update.message === undefined ? {} : { message: update.message }) };
          dirty = true;
          queueFlush();
        },
        log: line => {
          log = [...log, line.slice(0, 300)].slice(-40);
          dirty = true;
          queueFlush();
        },
        ...(input.videoGeneration === undefined ? {} : { videoGeneration: input.videoGeneration }),
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl })
      });
      const info = await stat(outputPath).catch(() => undefined);
      if (info === undefined || info.size < 2048) throw new Error('The tool finished but the output is empty');
      await flush();
      await store.update(job.id, {
        status: 'done',
        percent: 100,
        finishedAt: now().toISOString(),
        media: {
          fileName: `${definition.id}-${job.id}${definition.output === 'audio' ? '.wav' : '.mp4'}`,
          mime: definition.output === 'audio' ? 'audio/wav' : 'video/mp4',
          bytes: info.size
        }
      });
    } catch (error) {
      await flush();
      if (controller.signal.aborted) {
        await store.update(job.id, { status: 'cancelled', finishedAt: now().toISOString() });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await store.update(job.id, { status: 'error', error: message.slice(0, 1200), finishedAt: now().toISOString() });
      }
    } finally {
      controllers.delete(job.id);
    }
  }

  async function createJob(request: CreateStudioJobRequest): Promise<StudioJob> {
    await startup();
    const definition = findCapability(request.capability);
    if (definition === undefined) throw new StudioError('VALIDATION_FAILED', `Unknown capability "${request.capability}"`, 400);
    if (definition.template !== undefined) {
      throw new StudioError('VALIDATION_FAILED', `${definition.title} is built with the ${definition.template} template`, 400);
    }
    const prompt = (request.prompt ?? '').trim().slice(0, 4_000);
    if (definition.promptRequired && prompt.length === 0) throw new StudioError('VALIDATION_FAILED', 'A prompt is required', 400);
    let inputPath: string | undefined;
    if (definition.input !== 'none') {
      if (request.uploadId === undefined || request.uploadId === '') {
        if (definition.inputRequired) throw new StudioError('VALIDATION_FAILED', `This capability needs an uploaded ${definition.input}`, 400);
      } else {
        const upload = await readUpload(request.uploadId);
        if (upload.kind !== definition.input) {
          throw new StudioError('VALIDATION_FAILED', `This capability needs an uploaded ${definition.input}`, 400);
        }
        inputPath = upload.path;
      }
    }
    let params;
    try {
      params = resolveParams(definition, request.params, listPiperVoices(env.voicesDir));
    } catch (error) {
      if (error instanceof StudioValidationError) throw new StudioError('VALIDATION_FAILED', error.message, 400);
      throw error;
    }
    const job = await store.create({
      capability: definition.id,
      title: definition.title,
      mediaKind: definition.output,
      prompt: prompt.length > 0 ? prompt : definition.title
    });
    controllers.set(job.id, new AbortController());
    schedule(HEAVY_RUNNERS.has(definition.runner) ? 'heavy' : 'light', () =>
      execute(job, definition, { prompt, params, ...(inputPath === undefined ? {} : { inputPath }) })
    );
    return job;
  }

  async function cancelJob(id: string): Promise<StudioJob> {
    const job = await getJob(id);
    if (job.status !== 'queued' && job.status !== 'running') return job;
    controllers.get(id)?.abort(new Error('cancelled'));
    if (job.status === 'queued') {
      return (await store.update(id, { status: 'cancelled', finishedAt: now().toISOString() })) ?? job;
    }
    return job;
  }

  async function getJob(id: string): Promise<StudioJob> {
    await startup();
    const job = await store.get(id);
    if (job === undefined) throw new StudioError('STUDIO_JOB_NOT_FOUND', 'Studio job not found', 404);
    return job;
  }

  return {
    startup,
    capabilities,
    saveUpload,
    createJob,
    getJob,
    cancelJob,
    async listJobs(): Promise<StudioJob[]> {
      await startup();
      return await store.list();
    },
    async deleteJob(id: string): Promise<void> {
      const job = await getJob(id);
      if (job.status === 'queued' || job.status === 'running') {
        throw new StudioError('VALIDATION_FAILED', 'Cancel the job before deleting it', 409);
      }
      await store.remove(id);
    },
    async media(id: string): Promise<{ path: string; mime: string; fileName: string; bytes: number }> {
      const job = await getJob(id);
      if (job.status !== 'done' || job.media === undefined) {
        throw new StudioError('STUDIO_MEDIA_NOT_READY', 'The media is not ready', 404);
      }
      return { path: store.outputPath(job), ...job.media };
    },
    worker,
    isJobId: isStudioJobId
  };
}

