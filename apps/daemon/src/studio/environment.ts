import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { runCommand } from './process.js';

export const DEFAULT_PIPER_VOICE = 'en_US-lessac-medium';

export type StudioEnvironment = {
  home: string;
  jobsRoot: string;
  uploadsRoot: string;
  voicesDir: string;
  ffmpeg?: string;
  ffprobe?: string;
  piper?: string;
  python?: string;
  comfyUrl: string;
  avatarUrl: string;
  llmUrl: string;
  hyperframes: string[];
  /** WSL path of the Windows-side render root; unset renders locally. */
  windowsRenderRoot?: string;
  windowsFfmpegBin?: string;
  powershell?: string;
  cmd?: string;
  comfyTask: string;
  avatarTask: string;
  comfyStopCommand: string;
  transcribeScript: string;
};

export type ResolveStudioEnvironmentInput = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  ffmpegPath?: string;
  ffprobePath?: string;
  exists?: (path: string) => boolean;
};

/**
 * Resolve every external dependency of the Studio from the environment. Nothing
 * here points outside bb_creator's own data directory unless a variable says so.
 */
export function resolveStudioEnvironment(input: ResolveStudioEnvironmentInput): StudioEnvironment {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const home = resolve(env.OPENCREATOR_STUDIO_HOME?.trim() || join(input.dataDir, 'studio'));
  const venvBin = join(home, 'venv', 'bin');
  const lookup = (name: string, override: string | undefined, fallback?: string): string | undefined => {
    const explicit = override?.trim();
    if (explicit) return exists(explicit) ? explicit : undefined;
    if (fallback !== undefined && exists(fallback)) return fallback;
    return findOnPath(name, env.PATH ?? '', exists);
  };
  const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const cmd = '/mnt/c/Windows/System32/cmd.exe';
  const windowsRenderRoot = env.OPENCREATOR_STUDIO_WINDOWS_RENDER_ROOT?.trim();
  const hyperframes = (env.OPENCREATOR_STUDIO_HYPERFRAMES?.trim() || 'npx --yes hyperframes')
    .split(/\s+/)
    .filter(part => part.length > 0);
  return {
    home,
    jobsRoot: join(home, 'jobs'),
    uploadsRoot: join(home, 'uploads'),
    voicesDir: resolve(env.OPENCREATOR_STUDIO_VOICES?.trim() || join(home, 'voices')),
    ...(input.ffmpegPath === undefined ? optional('ffmpeg', findOnPath('ffmpeg', env.PATH ?? '', exists)) : { ffmpeg: input.ffmpegPath }),
    ...(input.ffprobePath === undefined ? optional('ffprobe', findOnPath('ffprobe', env.PATH ?? '', exists)) : { ffprobe: input.ffprobePath }),
    ...optional('piper', lookup('piper', env.OPENCREATOR_STUDIO_PIPER, join(venvBin, 'piper'))),
    ...optional('python', lookup('python3', env.OPENCREATOR_STUDIO_PYTHON, join(venvBin, 'python'))),
    comfyUrl: trimUrl(env.COMFYUI_URL, 'http://127.0.0.1:8188'),
    avatarUrl: trimUrl(env.OPENCREATOR_TALKING_HEAD_URL, 'http://127.0.0.1:8691'),
    llmUrl: trimUrl(env.OPENCREATOR_STUDIO_LLM_URL, 'http://127.0.0.1:8888'),
    hyperframes,
    ...(windowsRenderRoot ? { windowsRenderRoot } : {}),
    ...(env.OPENCREATOR_STUDIO_WINDOWS_FFMPEG_BIN?.trim() ? { windowsFfmpegBin: env.OPENCREATOR_STUDIO_WINDOWS_FFMPEG_BIN.trim() } : {}),
    ...(exists(powershell) ? { powershell } : {}),
    ...(exists(cmd) ? { cmd } : {}),
    comfyTask: env.OPENCREATOR_STUDIO_COMFY_TASK?.trim() || 'ComfyUI (manual)',
    avatarTask: env.OPENCREATOR_STUDIO_AVATAR_TASK?.trim() || 'Avatar service (SadTalker)',
    comfyStopCommand: env.OPENCREATOR_STUDIO_COMFY_STOP?.trim() || 'C:\\ComfyUI\\stop-comfyui.cmd',
    transcribeScript: resolve(
      new URL('../../resources/studio/transcribe.py', import.meta.url).pathname
    )
  };
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

function trimUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, '');
}

/** Piper voices installed in the voices directory (the `.onnx` file stem). */
export function listPiperVoices(voicesDir: string): string[] {
  try {
    return readdirSync(voicesDir)
      .filter(name => name.endsWith('.onnx') && existsSync(join(voicesDir, `${name}.json`)))
      .map(name => name.slice(0, -'.onnx'.length))
      .sort();
  } catch {
    return [];
  }
}

/** True when the interpreter can import faster-whisper. */
export async function pythonHasFasterWhisper(python: string): Promise<boolean> {
  try {
    await runCommand(python, ['-c', 'import faster_whisper'], {
      signal: AbortSignal.timeout(20_000)
    });
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string, searchPath: string, exists: (path: string) => boolean): string | undefined {
  for (const entry of searchPath.split(delimiter)) {
    const directory = entry.trim();
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
