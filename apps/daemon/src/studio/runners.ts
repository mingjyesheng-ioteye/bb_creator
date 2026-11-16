import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VideoGenerationService } from '../video-generation/service.js';
import type { CapabilityDefinition, ResolvedParams } from './catalog.js';
import { StudioValidationError } from './catalog.js';
import { buildMotionComposition, buildWorldProject, deriveWorldSpec } from './compositions.js';
import {
  ComfyError,
  buildStillImage,
  buildWanImageToVideo,
  buildWanTextToVideo,
  comfyCancel,
  comfyDownload,
  comfyHealth,
  comfyInstalledModels,
  comfySubmit,
  comfyUploadImage,
  comfyWait,
  missingWanFiles,
  wanFrames,
  wanSize,
  type ComfyGraph,
  type ComfyOutputFile
} from './comfyui.js';
import { buildSrt, synthesizeSpeech, transcribeMedia } from './audio.js';
import type { StudioEnvironment } from './environment.js';
import {
  burnSubtitlesArgs,
  crossfadeArgs,
  gradeArgs,
  isGradeProfile,
  isReframeAspect,
  lanczosUpscaleArgs,
  normalizeClipArgs,
  probeMedia,
  reframeArgs,
  reframeCrop,
  runFfmpeg,
  stillWithAudioArgs,
  trimArgs
} from './ffmpeg.js';
import { renderComposition, writeComposition } from './hyperframes.js';
import { StudioUnavailableError } from './process.js';
import { fetchStockClips } from './stock.js';

export type StudioRunContext = {
  definition: CapabilityDefinition;
  prompt: string;
  params: ResolvedParams;
  inputPath?: string;
  jobDir: string;
  outputPath: string;
  env: StudioEnvironment;
  signal: AbortSignal;
  report(update: { percent?: number; message?: string }): void;
  log(line: string): void;
  videoGeneration?: VideoGenerationService;
  fetchImpl?: typeof fetch;
};

export async function runStudioCapability(ctx: StudioRunContext): Promise<void> {
  switch (ctx.definition.runner) {
    case 'wan-text-to-video': return await runWan(ctx, 'text');
    case 'wan-image-to-video': return await runWan(ctx, 'image');
    case 'minimax-text-to-video': return await runMinimax(ctx, false);
    case 'minimax-image-to-video': return await runMinimax(ctx, true);
    case 'narrated-visual': return await runNarratedVisual(ctx);
    case 'world': return await runWorld(ctx);
    case 'motion': return await runMotion(ctx);
    case 'documentary': return await runDocumentary(ctx);
    case 'trim': return await runTrim(ctx);
    case 'reframe': return await runReframe(ctx);
    case 'grade': return await runGrade(ctx);
    case 'captions': return await runCaptions(ctx);
    case 'speech': return await runSpeech(ctx);
    case 'upscale': return await runUpscale(ctx);
    case 'course':
      throw new StudioValidationError('Course videos are built with the Course Video template');
  }
}

export function requireFfmpeg(env: StudioEnvironment): string {
  if (env.ffmpeg === undefined) throw new StudioUnavailableError('ffmpeg is not installed');
  return env.ffmpeg;
}

function requireFfprobe(env: StudioEnvironment): string {
  if (env.ffprobe === undefined) throw new StudioUnavailableError('ffprobe is not installed');
  return env.ffprobe;
}

function requireInput(ctx: StudioRunContext): string {
  if (ctx.inputPath === undefined) throw new StudioValidationError('This capability needs an uploaded file');
  return ctx.inputPath;
}

function requirePrompt(ctx: StudioRunContext): string {
  const text = ctx.prompt.trim();
  if (text.length === 0) throw new StudioValidationError('A prompt is required');
  return text;
}

function numberParam(ctx: StudioRunContext, name: string): number | undefined {
  const value = ctx.params[name];
  return typeof value === 'number' ? value : undefined;
}

function stringParam(ctx: StudioRunContext, name: string): string | undefined {
  const value = ctx.params[name];
  return typeof value === 'string' ? value : undefined;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function dimensions(size: string | undefined, fallback: [number, number]): [number, number] {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size ?? '');
  return match === null ? fallback : [Number(match[1]), Number(match[2])];
}

// ---- ComfyUI -------------------------------------------------------------

async function ensureComfy(ctx: StudioRunContext, requirement: 'text' | 'image' | 'still'): Promise<void> {
  const health = await comfyHealth(ctx.env.comfyUrl);
  if (!health.online) {
    throw new StudioUnavailableError('The GPU worker is offline. Start ComfyUI from the Studio page and retry.');
  }
  const installed = await comfyInstalledModels(ctx.env.comfyUrl);
  if (installed === undefined) return;
  if (requirement === 'still') {
    if (!installed.CheckpointLoaderSimple?.includes('v1-5-pruned-emaonly-fp16.safetensors')) {
      throw new StudioUnavailableError('ComfyUI is missing the checkpoint v1-5-pruned-emaonly-fp16.safetensors');
    }
    return;
  }
  const missing = missingWanFiles(installed, requirement);
  if (missing.length > 0) {
    throw new StudioUnavailableError(`ComfyUI is missing Wan 2.2 model files: ${missing.join(', ')}`);
  }
}

async function runGraph(ctx: StudioRunContext, graph: ComfyGraph, label: string): Promise<ComfyOutputFile[]> {
  const promptId = await comfySubmit(ctx.env.comfyUrl, graph, ctx.signal);
  const cancel = () => void comfyCancel(ctx.env.comfyUrl, promptId);
  ctx.signal.addEventListener('abort', cancel, { once: true });
  ctx.log(`ComfyUI accepted the ${label} job`);
  try {
    return await comfyWait(ctx.env.comfyUrl, promptId, {
      signal: ctx.signal,
      timeoutMs: 60 * 60_000,
      onTick: elapsed => ctx.report({ message: `ComfyUI is rendering (${(elapsed / 60_000).toFixed(1)} min)` })
    });
  } finally {
    ctx.signal.removeEventListener('abort', cancel);
  }
}

async function downloadFirst(ctx: StudioRunContext, files: ComfyOutputFile[], pattern: RegExp, destination: string): Promise<void> {
  const file = files.find(entry => pattern.test(entry.filename));
  if (file === undefined) throw new ComfyError('ComfyUI finished without producing an output file');
  await comfyDownload(ctx.env.comfyUrl, file, destination, ctx.signal);
}

async function runWan(ctx: StudioRunContext, mode: 'text' | 'image'): Promise<void> {
  const prompt = requirePrompt(ctx);
  await ensureComfy(ctx, mode);
  const [width, height] = wanSize(ctx.definition.defaults?.size ?? '832x480');
  const common = {
    prompt, width, height,
    frames: wanFrames(ctx.definition.defaults?.frames ?? 81),
    seed: randomSeed(), steps: 4, prefix: 'studio_wan'
  };
  let graph: ComfyGraph;
  if (mode === 'image') {
    ctx.report({ message: 'Uploading the reference image' });
    const imageName = await comfyUploadImage(ctx.env.comfyUrl, requireInput(ctx), ctx.signal);
    graph = buildWanImageToVideo({ ...common, imageName });
  } else {
    graph = buildWanTextToVideo(common);
  }
  const outputs = await runGraph(ctx, graph, 'Wan 2.2');
  ctx.report({ message: 'Downloading the clip' });
  await downloadFirst(ctx, outputs, /\.(mp4|webm|mov)$/i, ctx.outputPath);
}

// ---- MiniMax-H3 through the Unsloth video service --------------------------

async function runMinimax(ctx: StudioRunContext, withImage: boolean): Promise<void> {
  const service = ctx.videoGeneration;
  if (service === undefined) throw new StudioUnavailableError('The local video service is not available');
  const prompt = requirePrompt(ctx);
  let referenceImage: { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: string } | undefined;
  if (withImage) {
    const path = requireInput(ctx);
    const lower = path.toLowerCase();
    referenceImage = {
      mime: lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png',
      data: (await readFile(path)).toString('base64')
    };
  }
  const created = await service.create({
    prompt,
    provider: 'local-sd',
    size: '1280x720',
    duration: 6,
    ...(numberParam(ctx, 'steps') === undefined ? {} : { steps: numberParam(ctx, 'steps')! }),
    ...(referenceImage === undefined ? {} : { referenceImage })
  }, { signal: ctx.signal });
  ctx.log(`MiniMax-H3 job ${created.id}`);
  const deadline = Date.now() + 60 * 60_000;
  for (;;) {
    ctx.signal.throwIfAborted();
    const result = await service.refresh(created.id, { signal: ctx.signal });
    if (result.status === 'completed') {
      await service.copyTo(result.id, ctx.outputPath);
      return;
    }
    if (result.status === 'failed') throw new Error(`MiniMax-H3 failed${result.error === undefined ? '' : `: ${result.error}`}`);
    ctx.report({
      ...(result.progressKnown === true ? { percent: result.progress } : {}),
      message: `MiniMax-H3 ${result.status}${result.progressKnown === true ? ` (${result.progress}%)` : ''}`
    });
    if (Date.now() > deadline) throw new Error('MiniMax-H3 timed out');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(ctx.signal.reason); }, { once: true });
    });
  }
}

// ---- narrated stills ---------------------------------------------------------

async function runNarratedVisual(ctx: StudioRunContext): Promise<void> {
  const text = requirePrompt(ctx);
  const ffmpeg = requireFfmpeg(ctx.env);
  await ensureComfy(ctx, 'still');
  const [width, height] = dimensions(ctx.definition.defaults?.size, [832, 480]);
  ctx.report({ message: 'Generating the visual' });
  const outputs = await runGraph(ctx, buildStillImage({ prompt: text, width, height, seed: randomSeed(), prefix: 'studio_still' }), 'still');
  const still = join(ctx.jobDir, 'still.png');
  await downloadFirst(ctx, outputs, /\.(png|jpg|jpeg|webp)$/i, still);
  ctx.report({ message: 'Recording the narration' });
  const voice = join(ctx.jobDir, 'voice.wav');
  await synthesizeSpeech({ env: ctx.env, text, ...(stringParam(ctx, 'voice') === undefined ? {} : { voice: stringParam(ctx, 'voice')! }), output: voice, signal: ctx.signal });
  ctx.report({ message: 'Assembling the video' });
  await runFfmpeg(ffmpeg, stillWithAudioArgs({ image: still, audio: voice, output: ctx.outputPath }), ctx.signal);
}

// ---- HyperFrames compositions ------------------------------------------------------

async function runMotion(ctx: StudioRunContext): Promise<void> {
  const text = requirePrompt(ctx);
  const [width, height] = dimensions(ctx.definition.defaults?.size, [1280, 720]);
  const workspace = join(ctx.jobDir, 'composition');
  await writeComposition(workspace, buildMotionComposition({ text, duration: numberParam(ctx, 'duration') ?? 6, width, height }));
  ctx.report({ message: 'Rendering the composition' });
  await renderComposition({ env: ctx.env, workspace, output: ctx.outputPath, signal: ctx.signal, onLine: ctx.log });
}

async function runWorld(ctx: StudioRunContext): Promise<void> {
  const prompt = requirePrompt(ctx);
  const [width, height] = dimensions(ctx.definition.defaults?.size, [1280, 720]);
  const spec = deriveWorldSpec({ prompt, seed: 42, duration: numberParam(ctx, 'duration') ?? 8, width, height });
  const workspace = join(ctx.jobDir, 'world');
  await writeComposition(workspace, buildWorldProject(spec));
  ctx.report({ message: `Rendering a ${spec.landform} world (${spec.theme})` });
  await renderComposition({ env: ctx.env, workspace, output: ctx.outputPath, signal: ctx.signal, onLine: ctx.log });
}

// ---- documentary ----------------------------------------------------------------------

async function runDocumentary(ctx: StudioRunContext): Promise<void> {
  const ffmpeg = requireFfmpeg(ctx.env);
  const ffprobe = requireFfprobe(ctx.env);
  const queries = ctx.prompt.split(',').map(part => part.trim()).filter(part => part.length > 0).slice(0, 8);
  if (queries.length === 0) throw new StudioValidationError('Give one or more search phrases, comma separated');
  ctx.report({ message: 'Searching Archive.org, NASA and Wikimedia' });
  const clips = await fetchStockClips({
    queries,
    perQuery: numberParam(ctx, 'clips_per_query') ?? 3,
    directory: join(ctx.jobDir, 'clips'),
    signal: ctx.signal,
    log: ctx.log,
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl })
  });
  if (clips.length === 0) throw new Error('No footage found for those phrases');
  const normalized: string[] = [];
  const durations: number[] = [];
  for (const [index, clip] of clips.entries()) {
    ctx.report({ message: `Preparing clip ${index + 1} of ${clips.length}` });
    const path = join(ctx.jobDir, `clip${index}.mp4`);
    try {
      await runFfmpeg(ffmpeg, normalizeClipArgs({ source: clip.path, output: path, width: 1280, height: 720, fps: 30, maxSeconds: 3 }), ctx.signal);
      durations.push((await probeMedia(ffprobe, path, ctx.signal)).duration);
      normalized.push(path);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log(`Skipped ${clip.title}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  if (normalized.length === 0) throw new Error('Could not prepare the downloaded clips');
  const fade = Math.min(0.6, Math.min(...durations) / 3);
  ctx.report({ message: 'Cutting the montage' });
  await runFfmpeg(ffmpeg, crossfadeArgs({ clips: normalized, durations, output: ctx.outputPath, fade }), ctx.signal);
  await writeFile(join(ctx.jobDir, 'sources.txt'), `${clips.map(clip => `${clip.title}\t${clip.license}\t${clip.url}`).join('\n')}\n`);
}

// ---- ffmpeg transforms -------------------------------------------------------------------

async function runTrim(ctx: StudioRunContext): Promise<void> {
  const start = numberParam(ctx, 'start_seconds') ?? 0;
  const end = numberParam(ctx, 'end_seconds');
  if (end !== undefined && end <= start) throw new StudioValidationError('End must be after the start');
  await runFfmpeg(requireFfmpeg(ctx.env), trimArgs({ source: requireInput(ctx), output: ctx.outputPath, start, ...(end === undefined ? {} : { end }) }), ctx.signal);
}

async function runReframe(ctx: StudioRunContext): Promise<void> {
  const aspect = stringParam(ctx, 'target_aspect') ?? 'portrait';
  if (!isReframeAspect(aspect)) throw new StudioValidationError(`Unknown aspect "${aspect}"`);
  const source = requireInput(ctx);
  const info = await probeMedia(requireFfprobe(ctx.env), source, ctx.signal);
  const crop = reframeCrop({ width: info.width, height: info.height, aspect, ...(numberParam(ctx, 'focus_x') === undefined ? {} : { focusX: numberParam(ctx, 'focus_x')! }) });
  await runFfmpeg(requireFfmpeg(ctx.env), reframeArgs({ source, output: ctx.outputPath, crop }), ctx.signal);
}

async function runGrade(ctx: StudioRunContext): Promise<void> {
  const profile = stringParam(ctx, 'profile') ?? 'cinematic_warm';
  if (!isGradeProfile(profile)) throw new StudioValidationError(`Unknown look "${profile}"`);
  await runFfmpeg(requireFfmpeg(ctx.env), gradeArgs({
    source: requireInput(ctx), output: ctx.outputPath, profile, intensity: numberParam(ctx, 'intensity') ?? 1
  }), ctx.signal);
}

async function runUpscale(ctx: StudioRunContext): Promise<void> {
  const scale = Number(stringParam(ctx, 'scale') ?? 2);
  if (scale !== 2 && scale !== 4) throw new StudioValidationError('Scale must be 2 or 4');
  await runFfmpeg(requireFfmpeg(ctx.env), lanczosUpscaleArgs({ source: requireInput(ctx), output: ctx.outputPath, scale }), ctx.signal);
}

async function runCaptions(ctx: StudioRunContext): Promise<void> {
  const source = requireInput(ctx);
  const ffmpeg = requireFfmpeg(ctx.env);
  ctx.report({ message: 'Transcribing speech' });
  const transcript = await transcribeMedia({
    env: ctx.env,
    source,
    output: join(ctx.jobDir, 'transcript.json'),
    modelSize: stringParam(ctx, 'model_size') ?? 'base',
    signal: ctx.signal,
    onLine: ctx.log
  });
  if (transcript.segments.length === 0) throw new Error('No speech was found in the clip');
  const subtitles = join(ctx.jobDir, 'captions.srt');
  await writeFile(subtitles, buildSrt(transcript.segments), 'utf8');
  ctx.report({ message: `Burning ${transcript.language} captions` });
  await runFfmpeg(ffmpeg, burnSubtitlesArgs({ source, subtitles, output: ctx.outputPath }), ctx.signal);
}

async function runSpeech(ctx: StudioRunContext): Promise<void> {
  await synthesizeSpeech({
    env: ctx.env,
    text: requirePrompt(ctx),
    ...(stringParam(ctx, 'voice') === undefined ? {} : { voice: stringParam(ctx, 'voice')! }),
    output: ctx.outputPath,
    signal: ctx.signal
  });
}
