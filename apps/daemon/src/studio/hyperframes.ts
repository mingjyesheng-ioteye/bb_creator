import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CompositionFiles } from './compositions.js';
import type { StudioEnvironment } from './environment.js';
import { runCommand } from './process.js';

export async function writeComposition(directory: string, files: CompositionFiles): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, 'utf8');
  }
}

export type RenderCompositionInput = {
  env: StudioEnvironment;
  workspace: string;
  output: string;
  fps?: number;
  quality?: 'draft' | 'looks' | 'delivery';
  signal: AbortSignal;
  onLine?: (line: string) => void;
};

/**
 * Render a HyperFrames project to MP4. Rendering happens locally unless a
 * Windows render root is configured, in which case the project is copied there
 * so Chrome can use the host GPU for WebGL scenes.
 */
export async function renderComposition(input: RenderCompositionInput): Promise<void> {
  const fps = String(input.fps ?? 30);
  const quality = input.quality ?? 'draft';
  const [executable, ...base] = input.env.hyperframes;
  if (executable === undefined) throw new Error('No HyperFrames command is configured');
  if (input.env.windowsRenderRoot !== undefined && input.env.cmd !== undefined) {
    await renderOnWindows({ ...input, fps, quality });
    return;
  }
  await runCommand(executable, [...base, 'render', '--output', input.output, '--fps', fps, '--quality', quality, '--quiet'], {
    cwd: input.workspace,
    signal: input.signal,
    timeoutMs: 45 * 60_000,
    ...(input.onLine === undefined ? {} : { onLine: input.onLine })
  });
  await assertRendered(input.output);
}

async function renderOnWindows(input: Omit<RenderCompositionInput, 'fps' | 'quality'> & { fps: string; quality: string }): Promise<void> {
  const root = input.env.windowsRenderRoot!;
  const target = join(root, basename(dirname(input.workspace)) || 'job');
  await removeBestEffort(target);
  await mkdir(dirname(target), { recursive: true });
  try {
    await cp(input.workspace, target, { recursive: true });
    const ffmpegPrefix = input.env.windowsFfmpegBin === undefined ? '' : `set PATH=${input.env.windowsFfmpegBin};%PATH% && `;
    const command = `${ffmpegPrefix}${input.env.hyperframes.join(' ')} render --output renders/final.mp4 --fps ${input.fps} --quality ${input.quality} --quiet`;
    await runCommand(input.env.cmd!, ['/c', command], {
      cwd: target,
      signal: input.signal,
      timeoutMs: 45 * 60_000,
      ...(input.onLine === undefined ? {} : { onLine: input.onLine })
    });
    const produced = join(target, 'renders', 'final.mp4');
    await assertRendered(produced);
    await mkdir(dirname(input.output), { recursive: true });
    await cp(produced, input.output);
    input.onLine?.('Rendered on the Windows host GPU');
  } finally {
    await removeBestEffort(target);
    await pruneStale(root);
  }
}

/** Windows can keep a render folder locked for a moment; a failed cleanup must never fail the job. */
async function removeBestEffort(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
}

/** Remove leftovers of earlier renders whose folders were still locked at the time. */
async function pruneStale(root: string): Promise<void> {
  const cutoff = Date.now() - 60 * 60_000;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < cutoff) await removeBestEffort(path);
  }
}

async function assertRendered(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || info.size < 2048) throw new Error('HyperFrames produced no video');
}
