import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export const WAN_FILES = {
  textEncoder: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  vae: 'wan_2.1_vae.safetensors',
  t2vHigh: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
  t2vLow: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
  t2vLoraHigh: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
  t2vLoraLow: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
  i2vHigh: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
  i2vLow: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  i2vLoraHigh: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors',
  i2vLoraLow: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors'
} as const;
export const STILL_CHECKPOINT = 'v1-5-pruned-emaonly-fp16.safetensors';

const WAN_FPS = 16;
const WAN_NEGATIVE = 'blurry details, low quality, jpeg artifacts, static, overexposed, deformed, extra fingers, bad hands, watermark, subtitles, text, worst quality';

/** Wan needs 4n+1 frames; snap to the nearest valid count. */
export function wanFrames(frames: number): number {
  const wanted = Math.max(9, Math.round(frames));
  return Math.round((wanted - 1) / 4) * 4 + 1;
}

export function wanSize(size: string, fallback: [number, number] = [832, 480]): [number, number] {
  const match = /^(\d{2,4})x(\d{2,4})$/i.exec(size.trim());
  if (match === null) return fallback;
  // Wan latents are 16 px aligned.
  const align = (value: number) => Math.max(256, Math.round(Number(value) / 16) * 16);
  return [align(Number(match[1])), align(Number(match[2]))];
}

type WanInput = {
  prompt: string;
  width: number;
  height: number;
  frames: number;
  seed: number;
  steps: number;
  prefix: string;
};

function wanSampler(input: {
  steps: number;
  seed: number;
  highModel: [string, number];
  lowModel: [string, number];
  positive: [string, number];
  negative: [string, number];
  latent: [string, number];
  firstId: string;
  secondId: string;
}): ComfyGraph {
  const split = Math.max(1, Math.floor(input.steps / 2));
  const common = {
    steps: input.steps,
    cfg: 1,
    sampler_name: 'euler',
    scheduler: 'simple',
    positive: input.positive,
    negative: input.negative
  };
  return {
    [input.firstId]: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        ...common,
        model: input.highModel,
        latent_image: input.latent,
        add_noise: 'enable',
        noise_seed: input.seed,
        start_at_step: 0,
        end_at_step: split,
        return_with_leftover_noise: 'enable'
      }
    },
    [input.secondId]: {
      class_type: 'KSamplerAdvanced',
      inputs: {
        ...common,
        model: input.lowModel,
        latent_image: [input.firstId, 0],
        add_noise: 'disable',
        noise_seed: 0,
        start_at_step: split,
        end_at_step: 10_000,
        return_with_leftover_noise: 'disable'
      }
    }
  };
}

function wanTail(prefix: string, sampled: string): ComfyGraph {
  return {
    decode: { class_type: 'VAEDecode', inputs: { samples: [sampled, 0], vae: ['vae', 0] } },
    video: { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: WAN_FPS } },
    save: { class_type: 'SaveVideo', inputs: { video: ['video', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' } }
  };
}

function wanLoaders(input: {
  high: string;
  low: string;
  loraHigh: string;
  loraLow: string;
  prompt: string;
}): ComfyGraph {
  return {
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: WAN_FILES.textEncoder, type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: WAN_FILES.vae } },
    positive: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: input.prompt } },
    negative: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: WAN_NEGATIVE } },
    unetHigh: { class_type: 'UNETLoader', inputs: { unet_name: input.high, weight_dtype: 'default' } },
    unetLow: { class_type: 'UNETLoader', inputs: { unet_name: input.low, weight_dtype: 'default' } },
    loraHigh: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unetHigh', 0], lora_name: input.loraHigh, strength_model: 1 } },
    loraLow: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['unetLow', 0], lora_name: input.loraLow, strength_model: 1 } },
    shiftHigh: { class_type: 'ModelSamplingSD3', inputs: { model: ['loraHigh', 0], shift: 5 } },
    shiftLow: { class_type: 'ModelSamplingSD3', inputs: { model: ['loraLow', 0], shift: 5 } }
  };
}

/** Wan 2.2 14B text-to-video with the LightX2V 4-step LoRAs (two-expert sampling). */
export function buildWanTextToVideo(input: WanInput): ComfyGraph {
  return {
    ...wanLoaders({
      high: WAN_FILES.t2vHigh,
      low: WAN_FILES.t2vLow,
      loraHigh: WAN_FILES.t2vLoraHigh,
      loraLow: WAN_FILES.t2vLoraLow,
      prompt: input.prompt
    }),
    latent: {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: { width: input.width, height: input.height, length: wanFrames(input.frames), batch_size: 1 }
    },
    ...wanSampler({
      steps: input.steps,
      seed: input.seed,
      highModel: ['shiftHigh', 0],
      lowModel: ['shiftLow', 0],
      positive: ['positive', 0],
      negative: ['negative', 0],
      latent: ['latent', 0],
      firstId: 'sampleHigh',
      secondId: 'sampleLow'
    }),
    ...wanTail(input.prefix, 'sampleLow')
  };
}

/** Wan 2.2 14B image-to-video; the still becomes the first frame. */
export function buildWanImageToVideo(input: WanInput & { imageName: string }): ComfyGraph {
  return {
    ...wanLoaders({
      high: WAN_FILES.i2vHigh,
      low: WAN_FILES.i2vLow,
      loraHigh: WAN_FILES.i2vLoraHigh,
      loraLow: WAN_FILES.i2vLoraLow,
      prompt: input.prompt
    }),
    image: { class_type: 'LoadImage', inputs: { image: input.imageName } },
    conditioning: {
      class_type: 'WanImageToVideo',
      inputs: {
        width: input.width,
        height: input.height,
        length: wanFrames(input.frames),
        batch_size: 1,
        positive: ['positive', 0],
        negative: ['negative', 0],
        vae: ['vae', 0],
        start_image: ['image', 0]
      }
    },
    ...wanSampler({
      steps: input.steps,
      seed: input.seed,
      highModel: ['shiftHigh', 0],
      lowModel: ['shiftLow', 0],
      positive: ['conditioning', 0],
      negative: ['conditioning', 1],
      latent: ['conditioning', 2],
      firstId: 'sampleHigh',
      secondId: 'sampleLow'
    }),
    ...wanTail(input.prefix, 'sampleLow')
  };
}

/** Single still image from a Stable Diffusion 1.5 checkpoint. */
export function buildStillImage(input: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  prefix: string;
}): ComfyGraph {
  return {
    checkpoint: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: STILL_CHECKPOINT } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: input.width, height: input.height, batch_size: 1 } },
    positive: { class_type: 'CLIPTextEncode', inputs: { text: input.prompt.slice(0, 400), clip: ['checkpoint', 1] } },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, logo, blurry, low quality', clip: ['checkpoint', 1] } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        seed: input.seed, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['checkpoint', 0], positive: ['positive', 0], negative: ['negative', 0], latent_image: ['latent', 0]
      }
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['checkpoint', 2] } },
    save: { class_type: 'SaveImage', inputs: { filename_prefix: input.prefix, images: ['decode', 0] } }
  };
}

export type ComfyOutputFile = { filename: string; subfolder: string; type: string };
type HistoryEntry = {
  status?: { status_str?: string; messages?: unknown[] };
  outputs?: Record<string, Record<string, unknown>>;
};

export class ComfyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComfyError';
  }
}

export type ComfyHealth = { online: boolean; vramFreeGb?: number };

export async function comfyHealth(baseUrl: string, timeoutMs = 2_500): Promise<ComfyHealth> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { online: false };
    const payload = await response.json() as { devices?: Array<{ vram_free?: number }> };
    const free = payload.devices?.[0]?.vram_free;
    return {
      online: true,
      ...(typeof free === 'number' ? { vramFreeGb: Math.round((free / 1024 ** 3) * 10) / 10 } : {})
    };
  } catch {
    return { online: false };
  }
}

/** Model files installed in ComfyUI, keyed by the loader node that lists them. */
export async function comfyInstalledModels(baseUrl: string): Promise<Record<string, string[]> | undefined> {
  const loaders: Array<[string, string]> = [
    ['UNETLoader', 'unet_name'],
    ['CLIPLoader', 'clip_name'],
    ['VAELoader', 'vae_name'],
    ['LoraLoaderModelOnly', 'lora_name'],
    ['CheckpointLoaderSimple', 'ckpt_name']
  ];
  try {
    const entries = await Promise.all(loaders.map(async ([node, field]) => {
      const response = await fetch(`${baseUrl}/object_info/${node}`, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return [node, [] as string[]] as const;
      const payload = await response.json() as Record<string, { input?: { required?: Record<string, unknown[]> } }>;
      const options = payload[node]?.input?.required?.[field]?.[0];
      return [node, Array.isArray(options) ? options.map(String) : []] as const;
    }));
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

export function missingWanFiles(installed: Record<string, string[]>, mode: 'text' | 'image'): string[] {
  const has = (node: string, file: string) => installed[node]?.includes(file) ?? false;
  const wanted: Array<[string, string]> = [
    ['CLIPLoader', WAN_FILES.textEncoder],
    ['VAELoader', WAN_FILES.vae],
    ...(mode === 'text'
      ? [
        ['UNETLoader', WAN_FILES.t2vHigh], ['UNETLoader', WAN_FILES.t2vLow],
        ['LoraLoaderModelOnly', WAN_FILES.t2vLoraHigh], ['LoraLoaderModelOnly', WAN_FILES.t2vLoraLow]
      ] as Array<[string, string]>
      : [
        ['UNETLoader', WAN_FILES.i2vHigh], ['UNETLoader', WAN_FILES.i2vLow],
        ['LoraLoaderModelOnly', WAN_FILES.i2vLoraHigh], ['LoraLoaderModelOnly', WAN_FILES.i2vLoraLow]
      ] as Array<[string, string]>)
  ];
  return wanted.filter(([node, file]) => !has(node, file)).map(([, file]) => file);
}

export async function comfyUploadImage(baseUrl: string, path: string, signal: AbortSignal): Promise<string> {
  const name = `studio_${randomUUID().slice(0, 10)}${extname(path).toLowerCase() || '.png'}`;
  const form = new FormData();
  form.set('image', new Blob([await readFile(path) as unknown as BlobPart]), name);
  form.set('type', 'input');
  const response = await fetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  });
  if (!response.ok) throw new ComfyError(`ComfyUI rejected the upload (HTTP ${response.status})`);
  const payload = await response.json().catch(() => null) as { name?: unknown } | null;
  return typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : name;
}

export async function comfySubmit(baseUrl: string, graph: ComfyGraph, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'opencreator-studio' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ComfyError(`ComfyUI rejected the workflow (HTTP ${response.status}): ${body.slice(0, 800)}`);
  }
  const payload = await response.json().catch(() => null) as { prompt_id?: unknown } | null;
  if (typeof payload?.prompt_id !== 'string' || payload.prompt_id.length === 0) {
    throw new ComfyError('ComfyUI returned no prompt id');
  }
  return payload.prompt_id;
}

/** Ask ComfyUI to drop a queued prompt and interrupt it if it is the one running. */
export async function comfyCancel(baseUrl: string, promptId: string): Promise<void> {
  const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined);
  await post('/queue', { delete: [promptId] });
  await post('/interrupt', { prompt_id: promptId });
}

export async function comfyWait(baseUrl: string, promptId: string, input: {
  signal: AbortSignal;
  timeoutMs: number;
  pollMs?: number;
  onTick?: (elapsedMs: number) => void;
}): Promise<ComfyOutputFile[]> {
  const started = Date.now();
  const pollMs = input.pollMs ?? 3_000;
  let failures = 0;
  for (;;) {
    input.signal.throwIfAborted();
    if (Date.now() - started > input.timeoutMs) throw new ComfyError('ComfyUI timed out');
    await sleep(pollMs, input.signal);
    let entry: HistoryEntry | undefined;
    try {
      const response = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      entry = (await response.json() as Record<string, HistoryEntry>)[promptId];
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) throw error;
      failures += 1;
      if (failures >= 10) {
        throw new ComfyError(`ComfyUI became unreachable: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (entry?.status?.status_str === 'error') {
      throw new ComfyError(`ComfyUI failed: ${JSON.stringify(entry.status).slice(0, 1200)}`);
    }
    if (entry?.status?.status_str === 'success') return collectOutputs(entry);
    input.onTick?.(Date.now() - started);
  }
}

function collectOutputs(entry: HistoryEntry): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = [];
  for (const output of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'videos', 'gifs']) {
      const list = output[key];
      if (!Array.isArray(list)) continue;
      for (const item of list as Array<Record<string, unknown>>) {
        if (typeof item.filename !== 'string') continue;
        files.push({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : 'output'
        });
      }
    }
  }
  return files;
}

export async function comfyDownload(
  baseUrl: string,
  file: ComfyOutputFile,
  destination: string,
  signal: AbortSignal
): Promise<void> {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const response = await fetch(`${baseUrl}/view?${query.toString()}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)])
  });
  if (!response.ok) throw new ComfyError(`ComfyUI returned HTTP ${response.status} for ${basename(file.filename)}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
