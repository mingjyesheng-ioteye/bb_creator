import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CreatorLocalModelInfo } from '@opencreator/protocol';

const MAX_DEPTH = 4;
const COMPONENT_DIRECTORIES = new Set([
  'common',
  'downloads',
  'vae',
  'text_encoders',
  'clip_vision',
  'loras',
  'lora',
  'embeddings',
  'audio'
]);
const COMPONENT_FILE = /(?:^|[_.-])(?:vae|encoder|mmproj|clip|t5|llm|text|audio|connector)(?:[_.-]|$)/i;

/**
 * Best-effort discovery of the models LocModel downloaded. LocModel keeps its
 * model root in `%LOCALAPPDATA%\\LocModel\\settings.json` (`models_dir`) and
 * stores diffusion models under `<models_dir>/image`.
 */
export async function readLocModelDownloadedModels(): Promise<CreatorLocalModelInfo[]> {
  const settings = await readLocModelSettings();
  if (settings === undefined) return [];
  const modelsDir = typeof settings.models_dir === 'string' ? settings.models_dir.trim() : '';
  if (modelsDir.length === 0) return [];
  const accessibleModelsDir = toAccessiblePath(modelsDir);
  const roots: Array<{ directory: string; kind: CreatorLocalModelInfo['kind'] }> = [
    { directory: join(accessibleModelsDir, 'image'), kind: 'image' },
    { directory: join(accessibleModelsDir, 'video'), kind: 'video' }
  ];
  const models: CreatorLocalModelInfo[] = [];
  for (const root of roots) {
    let files: string[];
    try {
      files = await walk(root.directory, 0);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.gguf')) continue;
      const name = basename(file);
      if (COMPONENT_FILE.test(name)) continue;
      const directory = basename(dirname(file));
      if (COMPONENT_DIRECTORIES.has(directory.toLowerCase())) continue;
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(file)).size;
      } catch {
        continue;
      }
      const quantization = readQuantization(name);
      const kind: CreatorLocalModelInfo['kind'] = root.kind === 'video'
        || isVideoModel(directory, name)
        ? 'video'
        : 'image';
      models.push({
        id: `${kind}/${directory}/${name}`,
        name: humanizeModelName(directory, quantization),
        kind,
        path: file,
        sizeBytes,
        ...(quantization === undefined ? {} : { quantization })
      });
    }
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

function isVideoModel(directory: string, name: string): boolean {
  return /(?:wan|video|ti2v|i2v|t2v|minimax|hyperflow|fl2va|flf2v|svd|ltx|cogvideo|mochi|hunyuan)/i
    .test(`${directory}/${name}`);
}

async function readLocModelSettings(): Promise<Record<string, unknown> | undefined> {
  for (const candidate of await settingsCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function settingsCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  if (process.env.LOCMODEL_SETTINGS_FILE) candidates.push(process.env.LOCMODEL_SETTINGS_FILE);
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'LocModel', 'settings.json'));
  candidates.push(join(homedir(), 'AppData', 'Local', 'LocModel', 'settings.json'));
  candidates.push(join(homedir(), '.local', 'share', 'LocModel', 'settings.json'));
  if (process.platform === 'linux') {
    try {
      for (const user of await readdir('/mnt/c/Users')) {
        candidates.push(`/mnt/c/Users/${user}/AppData/Local/LocModel/settings.json`);
      }
    } catch {
      // Not running under WSL.
    }
  }
  return candidates;
}

function toAccessiblePath(value: string): string {
  if (process.platform !== 'linux') return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (match === null) return value;
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
}

async function walk(directory: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (COMPONENT_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      files.push(...await walk(path, depth + 1));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function readQuantization(filename: string): string | undefined {
  const match = /(Q\d+(?:_[A-Z0-9]+)+|Q\d+_\d+|BF16|F16|F32)/i.exec(filename);
  return match?.[1]?.toUpperCase();
}

function humanizeModelName(directory: string, quantization: string | undefined): string {
  const normalized = directory
    .replace(/^unsloth__/i, '')
    .replace(/-GGUF$/i, '');
  const spaced = normalized
    .replace(/qwen-image/i, 'Qwen-Image')
    .replace(/z-image/i, 'Z-Image')
    .replace(/minimax/i, 'MiniMax')
    .replace(/hyperflow/i, 'HyperFlow')
    .replace(/wan(\d)/i, 'Wan$1')
    .replace(/ti2v/i, 'TI2V')
    .replace(/i2v/i, 'I2V')
    .replace(/t2v/i, 'T2V')
    .replace(/(\d)([a-z])\b/g, (_, digit: string, letter: string) => digit + letter.toUpperCase())
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = spaced
    .split(' ')
    .map(part => /^[A-Z0-9.-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    .replace(/\bQwen Image\b/g, 'Qwen-Image')
    .replace(/\bZ Image\b/g, 'Z-Image');
  return quantization === undefined || title.toUpperCase().includes(quantization)
    ? title
    : `${title} ${quantization}`;
}
