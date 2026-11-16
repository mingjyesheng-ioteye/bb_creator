import type { StudioWorkerActionResponse, StudioWorkerStatus } from '@opencreator/protocol';
import { comfyHealth } from './comfyui.js';
import type { StudioEnvironment } from './environment.js';
import { runCommand } from './process.js';

export type UnslothVideoProbe = { online: boolean; reason: string };

/** Is Unsloth Studio answering with a video model resident? */
export async function probeUnslothVideo(baseUrl: string, apiKey: string): Promise<UnslothVideoProbe> {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (base.length === 0) return { online: false, reason: 'No local video engine URL is configured' };
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey.trim().length > 0) headers.Authorization = `Bearer ${apiKey.trim()}`;
  try {
    const response = await fetch(`${base}/api/inference/video/status`, { headers, signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return { online: false, reason: `Unsloth Studio answered HTTP ${response.status}` };
    const status = await response.json().catch(() => undefined) as { loaded?: unknown } | undefined;
    return status?.loaded === true
      ? { online: true, reason: '' }
      : { online: false, reason: 'No video model is loaded in Unsloth Studio (load MiniMax-H3)' };
  } catch {
    return { online: false, reason: `Unsloth Studio is not reachable at ${base}` };
  }
}

async function reachable(url: string, acceptAuth = false): Promise<{ online: boolean; payload?: unknown }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    if (acceptAuth && (response.status === 401 || response.status === 403)) return { online: true };
    if (!response.ok) return { online: false };
    return { online: true, payload: await response.json().catch(() => undefined) };
  } catch {
    return { online: false };
  }
}

export type StudioWorker = ReturnType<typeof createStudioWorker>;

/** Health and control of the GPU host (ComfyUI, the avatar service and the local LLM). */
export function createStudioWorker(input: {
  env: StudioEnvironment;
  unslothVideo: () => Promise<UnslothVideoProbe>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  let cache: { at: number; value: StudioWorkerStatus } | undefined;
  const canControl = input.env.powershell !== undefined;

  async function status(force = false): Promise<StudioWorkerStatus> {
    if (!force && cache !== undefined && Date.now() - cache.at < 10_000) return cache.value;
    const [comfy, avatar, llm, unsloth] = await Promise.all([
      comfyHealth(input.env.comfyUrl),
      reachable(`${input.env.avatarUrl}/health`),
      reachable(`${input.env.llmUrl}/v1/models`, true),
      input.unslothVideo()
    ]);
    const engine = (avatar.payload as { engine?: unknown } | undefined)?.engine;
    const value: StudioWorkerStatus = {
      mode: comfy.online && llm.online ? 'mixed' : comfy.online ? 'video' : llm.online ? 'llm' : 'idle',
      comfyui: { online: comfy.online, ...(comfy.vramFreeGb === undefined ? {} : { vramFreeGb: comfy.vramFreeGb }) },
      avatar: { online: avatar.online, ...(typeof engine === 'string' ? { engine } : {}) },
      llm: { online: llm.online },
      unslothVideo: { online: unsloth.online, reason: unsloth.reason },
      canControl,
      checkedAt: now().toISOString()
    };
    cache = { at: Date.now(), value };
    return value;
  }

  async function powershell(command: string): Promise<{ ok: boolean; detail: string }> {
    if (input.env.powershell === undefined) return { ok: false, detail: 'PowerShell is not available on this host' };
    try {
      const result = await runCommand(input.env.powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        signal: AbortSignal.timeout(120_000),
        timeoutMs: 120_000
      });
      return { ok: true, detail: result.stdout.trim().slice(-300) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }

  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

  return {
    status,
    /** Start ComfyUI and the cheap-when-idle avatar service. */
    async start(): Promise<StudioWorkerActionResponse> {
      const steps = {
        comfyui: await powershell(`Start-ScheduledTask -TaskName ${quote(input.env.comfyTask)}; 'started'`),
        avatar: await powershell(`Start-ScheduledTask -TaskName ${quote(input.env.avatarTask)} -ErrorAction SilentlyContinue | Out-Null; 'started'`)
      };
      cache = undefined;
      return { ok: steps.comfyui.ok, steps };
    },
    /** Stop ComfyUI; the local LLM keeps running in its own app. */
    async stop(): Promise<StudioWorkerActionResponse> {
      let comfyui: { ok: boolean; detail: string };
      if (input.env.cmd === undefined) {
        comfyui = { ok: false, detail: 'cmd.exe is not available on this host' };
      } else {
        try {
          await runCommand(input.env.cmd, ['/c', input.env.comfyStopCommand], {
            signal: AbortSignal.timeout(120_000),
            timeoutMs: 120_000
          });
          comfyui = { ok: true, detail: 'stopped' };
        } catch (error) {
          comfyui = { ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
        }
      }
      cache = undefined;
      return { ok: comfyui.ok, steps: { comfyui } };
    }
  };
}
