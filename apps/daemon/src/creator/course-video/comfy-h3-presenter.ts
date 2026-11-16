import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { CreatorExecutorError } from '../executor.js';
import type { GeneratePresenterClip } from './presenter-executor.js';

const FPS = 24;
/** Head start before the first word, so the mouth is already moving. */
const LEAD_SECONDS = 0.5;
/** 345 frames is H3's cap (~14.4 s); chunk long narration below it. */
const MAX_FRAMES = 345;
const CHUNK_TARGET_SECONDS = 10.5;
const CHUNK_MAX_SECONDS = 12.5;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 4_000;
const MAX_POLL_FAILURES = 10;

const UNET = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors';
const TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors';
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors';
const LORA = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors';

type ComfyOutput = {
  images?: Array<{ filename?: string; subfolder?: string; type?: string }>;
};

type ComfyHistoryEntry = {
  status?: { status_str?: string; completed?: boolean; messages?: unknown };
  outputs?: Record<string, ComfyOutput>;
};

/**
 * MiniMax-H3 reference-to-video (R2V) presenter through the Windows ComfyUI.
 *
 * The daemon runs in CPU-only WSL; ComfyUI on the host has the native
 * `MiniMaxH3ReferenceToVideo` node plus the Comfy-Org pruned INT8 ref2va
 * checkpoint and the 4-step turbo LoRA. H3 copies the reference narration
 * (`<Audio 1>: fully_copy`) and drives the lips from it, so there is no
 * Wav2Lip pass.
 *
 * A 5.9 s clip at 864x480 / 4 steps takes ~6 minutes including model load. The
 * clip is rendered with a 0.5 s lead (the mouth starts before the first word)
 * and then trimmed back to the slide duration, because the lesson track keeps
 * its own narration audio. Long narration is split into ~10.5 s pieces (H3
 * caps one generation at 345 frames), rendered one at a time and concatenated.
 */
export function createComfyH3PresenterClipRunner(input: {
  baseUrl: string;
  steps?: number;
  width?: number;
  height?: number;
  /** ffmpeg used to pad the narration and trim the lead from the clip. */
  ffmpegPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): GeneratePresenterClip {
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  const ffmpeg = input.ffmpegPath ?? 'ffmpeg';
  const steps = Math.max(1, Math.round(input.steps ?? 4));
  const width = input.width ?? 864;
  const height = input.height ?? 480;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? POLL_INTERVAL_MS;

  return async (request) => {
    if (base.length === 0) {
      throw new CreatorExecutorError(
        'course_presenter_unavailable',
        'ComfyUI is not configured. Set COMFYUI_URL or start ComfyUI on the GPU host.'
      );
    }
    const duration = request.durationSeconds > 0.5 ? request.durationSeconds : 4;
    const work = await mkdtemp(join(tmpdir(), 'bb-comfy-h3-'));
    try {
      const silences = await probeSilences(ffmpeg, request.audioPath, request.signal);
      const chunks = planChunks(duration, silences);
      request.onProgress?.({
        message: `ComfyUI H3: ${duration.toFixed(1)}s narration -> ${chunks.length} chunk(s), ${width}x${height}, ${steps} steps`
      });
      const portraitName = await upload(base, request.portraitPath, 'bbh3_portrait', request.signal);
      const seed = Math.floor(Math.random() * 2 ** 31);
      const clips: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const length = alignFrames(chunk.length + LEAD_SECONDS);
        if (length > MAX_FRAMES) {
          throw new CreatorExecutorError(
            'course_presenter_failed',
            `H3 chunk ${index + 1} needs ${length} frames, above its ${MAX_FRAMES}-frame cap`
          );
        }
        const seconds = length / FPS;
        const chunkWav = join(work, `chunk_${index}.wav`);
        const padded = join(work, `chunk_${index}_padded.wav`);
        await extractChunk(ffmpeg, request.audioPath, chunk.start, chunk.length, chunkWav, request.signal);
        await runFfmpeg(ffmpeg, [
          '-y', '-loglevel', 'error', '-i', chunkWav,
          '-af', `adelay=${Math.round(LEAD_SECONDS * 1000)}|${Math.round(LEAD_SECONDS * 1000)},apad`,
          '-t', seconds.toFixed(3), '-ar', '32000', '-ac', '1', padded
        ], request.signal);
        request.onProgress?.({
          message: `ComfyUI H3 chunk ${index + 1}/${chunks.length}: ${chunk.start.toFixed(1)}-${(chunk.start + chunk.length).toFixed(1)}s (${length} frames)`
        });
        const audioName = await upload(base, padded, 'bbh3_voice', request.signal);
        const promptId = await submit(base, {
          graph: buildGraph({
            portraitName,
            audioName,
            prompt: buildPrompt(
              wordSlice(request.text ?? '', chunk.start, chunk.length, duration),
              request.prompt ?? ''
            ),
            width,
            height,
            length,
            steps,
            seed,
            prefix: `bbh3/avatar_${randomUUID().slice(0, 8)}`
          }),
          signal: request.signal
        });
        const entry = await waitForHistory(base, promptId, {
          timeoutMs,
          pollIntervalMs,
          signal: request.signal,
          ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress })
        });
        const rendered = join(work, `chunk_${index}_raw.mp4`);
        await download(base, entry, rendered, request.signal);
        const trimmed = chunks.length === 1 ? request.outputPath : join(work, `chunk_${index}.mp4`);
        await trimChunk(ffmpeg, rendered, chunk.length, trimmed, request.signal);
        clips.push(trimmed);
      }
      if (clips.length > 1) {
        await concatChunks(ffmpeg, clips, request.outputPath, work, request.signal);
      }
      const written = await stat(request.outputPath).catch(() => undefined);
      if (written === undefined || written.size === 0) {
        throw new CreatorExecutorError('course_presenter_failed', 'ComfyUI H3 produced an empty clip');
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}

/** Snap a duration to H3's 5-mod-17 frame lattice (same as the template). */
export function alignFrames(seconds: number): number {
  const frames = Math.max(5, Math.round(Math.max(0.2, seconds) * FPS));
  const remainder = (((5 - (frames % 17)) % 17) + 17) % 17;
  return frames + remainder;
}

type Chunk = { start: number; length: number };

function planChunks(duration: number, silences: Array<[number, number]>): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (duration - start > CHUNK_MAX_SECONDS) {
    const regionStart = start + 3;
    const regionEnd = Math.min(duration, start + CHUNK_MAX_SECONDS);
    const target = start + CHUNK_TARGET_SECONDS;
    const candidates: number[] = [];
    for (const [silenceStart, silenceEnd] of silences) {
      const left = Math.max(silenceStart, regionStart);
      const right = Math.min(silenceEnd, regionEnd);
      if (right - left >= 0.15) candidates.push((left + right) / 2);
    }
    let cut = candidates.length > 0
      ? candidates.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best))
      : target;
    cut = Math.max(start + 3, Math.min(cut, start + CHUNK_MAX_SECONDS));
    chunks.push({ start, length: cut - start });
    start = cut;
  }
  if (duration - start > 0.05) chunks.push({ start, length: duration - start });
  if (chunks.length > 1 && chunks[chunks.length - 1]!.length < 3) {
    const tail = chunks.pop()!;
    const previous = chunks[chunks.length - 1]!;
    previous.length += tail.length;
  }
  return chunks;
}

function wordSlice(text: string, start: number, length: number, duration: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || duration <= 0) return '';
  const left = Math.max(0, Math.min(words.length, Math.round(words.length * start / duration)));
  const right = Math.max(left, Math.min(words.length, Math.round(words.length * (start + length) / duration)));
  return words.slice(left, right).join(' ');
}

async function probeSilences(
  ffmpeg: string,
  audio: string,
  signal: AbortSignal
): Promise<Array<[number, number]>> {
  try {
    const { stderr } = await runCapture(ffmpeg, [
      '-hide_banner', '-i', audio, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'
    ], signal);
    const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map(match => Number(match[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map(match => Number(match[1]));
    return starts.map((at, index) => [at, ends[index] ?? at + 0.25] as [number, number]);
  } catch {
    return [];
  }
}

async function extractChunk(
  ffmpeg: string,
  audio: string,
  start: number,
  length: number,
  out: string,
  signal: AbortSignal
): Promise<void> {
  await runFfmpeg(ffmpeg, [
    '-y', '-loglevel', 'error', '-ss', start.toFixed(3), '-t', length.toFixed(3),
    '-i', audio, '-ar', '32000', '-ac', '1', out
  ], signal);
}

async function trimChunk(
  ffmpeg: string,
  raw: string,
  length: number,
  out: string,
  signal: AbortSignal
): Promise<void> {
  await runFfmpeg(ffmpeg, [
    '-y', '-loglevel', 'error', '-ss', LEAD_SECONDS.toFixed(3), '-i', raw,
    '-t', length.toFixed(3), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-movflags', '+faststart', out
  ], signal);
}

async function concatChunks(
  ffmpeg: string,
  clips: string[],
  out: string,
  work: string,
  signal: AbortSignal
): Promise<void> {
  const listing = join(work, 'concat.txt');
  await writeFile(listing, clips.map(clip => `file '${clip.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  try {
    await runFfmpeg(ffmpeg, [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', out
    ], signal);
  } catch {
    await runFfmpeg(ffmpeg, [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listing,
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), out
    ], signal);
  }
}

function runCapture(exe: string, args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { signal, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new CreatorExecutorError('course_presenter_failed', `ffmpeg probe failed: ${error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function buildGraph(input: {
  portraitName: string;
  audioName: string;
  prompt: string;
  width: number;
  height: number;
  length: number;
  steps: number;
  seed: number;
  prefix: string;
}): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: input.portraitName } },
    '2': { class_type: 'LoadAudio', inputs: { audio: input.audioName } },
    '3': { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: TEXT_ENCODER, type: 'minimax', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: VIDEO_VAE } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: AUDIO_VAE } },
    '7': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['3', 0], lora_name: LORA, strength_model: 1 } },
    '8': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        clip: ['4', 0], vae: ['5', 0], audio_vae: ['6', 0],
        prompt: input.prompt, width: input.width, height: input.height,
        length: input.length, ref_image_size: 'match',
        'ref_images.ref_image_0': ['1', 0],
        'ref_audios.ref_audio_0': ['2', 0]
      }
    },
    '9': { class_type: 'BasicScheduler', inputs: { model: ['7', 0], scheduler: 'simple', steps: input.steps, denoise: 1 } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '11': { class_type: 'RandomNoise', inputs: { noise_seed: input.seed } },
    '12': { class_type: 'BasicGuider', inputs: { model: ['7', 0], conditioning: ['8', 0] } },
    '13': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['11', 0], guider: ['12', 0], sampler: ['10', 0],
        sigmas: ['9', 0], latent_image: ['8', 1]
      }
    },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['5', 0] } },
    '15': { class_type: 'VAEDecodeAudio', inputs: { samples: ['13', 0], vae: ['6', 0] } },
    '16': { class_type: 'CreateVideo', inputs: { images: ['14', 0], audio: ['15', 0], fps: FPS } },
    '17': { class_type: 'SaveVideo', inputs: { video: ['16', 0], filename_prefix: input.prefix, format: 'mp4' } }
  };
}

function buildPrompt(text: string, extra: string): string {
  const spoken = text.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  const tag = spoken.length > 0
    ? ` (S1) speaks the English line <d>[English] "${spoken}"</d>`
    : '';
  const extraLine = extra.trim().length > 0 ? ` ${extra.trim()}` : '';
  return `subject_definitions:
<Picture 1> is the exact first frame of [Shot 1] at 00:00.000. <Picture 1> shows (S1), the presenter.
<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track.${tag}

detailed_description:
[Shot 1] The shot begins from <Picture 1> as the exact first frame at 00:00.000. (S1) looks straight at the camera and speaks naturally, lips, jaw and facial expression moving precisely in sync with the English words in <Audio 1>. Natural blinks, small relaxed head movement, subtle shoulder motion, steady eye contact. Fixed medium close-up framing, no cuts, no camera movement. Photorealistic, consistent identity, stable face, stable hair, clean skin texture.${extraLine}

overall_soundscape:
<Audio 1> only, copied exactly as the complete final audio track. No additional speech, ambience, crowd noise, music, or sound effects.

non_diegetic_music:
<Audio 1> only.
`;
}

async function upload(
  base: string,
  path: string,
  prefix: string,
  signal: AbortSignal
): Promise<string> {
  const name = `${prefix}_${randomUUID().slice(0, 10)}${extname(path).toLowerCase() || '.png'}`;
  const data = await readFile(path);
  const form = new FormData();
  form.set('image', new Blob([data as unknown as BlobPart]), name);
  form.set('type', 'input');
  const response = await fetch(`${base}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  });
  if (!response.ok) {
    throw new CreatorExecutorError(
      'course_presenter_failed',
      `ComfyUI rejected the upload (HTTP ${response.status})`
    );
  }
  const payload = await response.json().catch(() => null) as { name?: unknown } | null;
  return typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : name;
}

async function submit(
  base: string,
  input: {
    graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    signal: AbortSignal;
  }
): Promise<string> {
  const response = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input.graph, client_id: 'bb-creator-h3' }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CreatorExecutorError(
      'course_presenter_failed',
      `ComfyUI rejected the H3 graph (HTTP ${response.status}): ${body.slice(0, 800)}`
    );
  }
  const payload = await response.json().catch(() => null) as { prompt_id?: unknown } | null;
  if (typeof payload?.prompt_id !== 'string' || payload.prompt_id.length === 0) {
    throw new CreatorExecutorError('course_presenter_failed', 'ComfyUI returned no prompt id');
  }
  return payload.prompt_id;
}

async function waitForHistory(
  base: string,
  promptId: string,
  input: {
    timeoutMs: number;
    pollIntervalMs: number;
    signal: AbortSignal;
    onProgress?: (update: { percent?: number; message?: string }) => void;
  }
): Promise<ComfyHistoryEntry> {
  const started = Date.now();
  let failures = 0;
  let lastNote = 0;
  for (;;) {
    if (Date.now() - started > input.timeoutMs) {
      throw new CreatorExecutorError('course_presenter_failed', 'ComfyUI H3 generation timed out');
    }
    await delay(input.pollIntervalMs, input.signal);
    let payload: Record<string, ComfyHistoryEntry>;
    try {
      const response = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json() as Record<string, ComfyHistoryEntry>;
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) throw error;
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new CreatorExecutorError(
          'course_presenter_failed',
          `ComfyUI became unreachable during the H3 render: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      continue;
    }
    const entry = payload[promptId];
    if (entry !== undefined) {
      const state = entry.status?.status_str;
      if (state === 'success') return entry;
      if (state === 'error') {
        throw new CreatorExecutorError(
          'course_presenter_failed',
          `ComfyUI H3 failed: ${JSON.stringify(entry.status).slice(0, 1200)}`
        );
      }
    }
    const elapsed = Date.now() - started;
    if (elapsed - lastNote > 45_000) {
      lastNote = elapsed;
      input.onProgress?.({ message: `ComfyUI H3 running ${(elapsed / 60_000).toFixed(1)} min` });
    }
  }
}

async function download(
  base: string,
  entry: ComfyHistoryEntry,
  out: string,
  signal: AbortSignal
): Promise<void> {
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const item of output.images ?? []) {
      const filename = item.filename ?? '';
      if (!filename.toLowerCase().endsWith('.mp4')) continue;
      const query = new URLSearchParams({
        filename,
        subfolder: item.subfolder ?? '',
        type: item.type ?? 'output'
      });
      const response = await fetch(`${base}/view?${query.toString()}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)])
      });
      if (!response.ok) {
        throw new CreatorExecutorError(
          'course_presenter_failed',
          `ComfyUI returned HTTP ${response.status} for the clip`
        );
      }
      const data = await response.arrayBuffer();
      if (data.byteLength === 0) {
        throw new CreatorExecutorError('course_presenter_failed', 'ComfyUI returned an empty clip');
      }
      await writeFile(out, Buffer.from(data));
      return;
    }
  }
  throw new CreatorExecutorError('course_presenter_failed', 'ComfyUI finished without a video output');
}

function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, {
      signal,
      timeout: 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new CreatorExecutorError(
          'course_presenter_failed',
          `ffmpeg failed for the H3 clip: ${error.message}${stderr ? ` (${stderr.slice(-400)})` : ''}`
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
      reject(new CreatorExecutorError('course_presenter_failed', 'Presenter generation was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CreatorExecutorError('course_presenter_failed', 'Presenter generation was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
