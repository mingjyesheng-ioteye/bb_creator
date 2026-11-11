import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export type CreatorMediaToolName = 'ffmpeg' | 'ffprobe';

export type ResolveCreatorMediaToolInput = {
  name: CreatorMediaToolName;
  /**
   * Explicit path from configuration. When set, it is authoritative: a missing
   * file reports the tool as unavailable instead of silently falling back to
   * whatever happens to be on PATH.
   */
  overridePath?: string;
  /** Search path used when no override is configured. Defaults to process.env.PATH. */
  searchPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
};

/**
 * Resolve ffmpeg/ffprobe from an explicit configuration path or the process
 * PATH. The bundled KrillinAI manifest is preferred by the caller when it
 * declares an executable; this helper covers runtimes installed system-wide
 * (for example the Linux packages used by the local daemon).
 */
export function resolveCreatorMediaTool(input: ResolveCreatorMediaToolInput): string | undefined {
  const exists = input.exists ?? existsSync;
  const override = input.overridePath?.trim();
  if (override !== undefined && override.length > 0) {
    return exists(override) ? override : undefined;
  }
  const platform = input.platform ?? process.platform;
  const searchPath = input.searchPath ?? process.env.PATH ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? win32.join : posix.join;
  const candidates = platform === 'win32'
    ? [`${input.name}.exe`, `${input.name}.cmd`, `${input.name}.bat`, input.name]
    : [input.name];
  for (const entry of searchPath.split(separator)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory.length === 0) continue;
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if (exists(path)) return path;
    }
  }
  return undefined;
}
