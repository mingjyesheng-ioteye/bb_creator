import { describe, expect, it } from 'vitest';
import { resolveCreatorExecutable } from '../../src/creator/media-tools.js';

describe('creator media tools', () => {
  it('finds ffprobe on PATH for POSIX runtimes', () => {
    const resolved = resolveCreatorExecutable({
      name: 'ffprobe',
      searchPath: '/opt/bin:/usr/local/bin:/usr/bin',
      platform: 'linux',
      exists: path => path === '/usr/bin/ffprobe'
    });

    expect(resolved).toBe('/usr/bin/ffprobe');
  });

  it('finds the edge-tts CLI on PATH', () => {
    const resolved = resolveCreatorExecutable({
      name: 'edge-tts',
      searchPath: '/usr/local/bin:/home/user/.local/bin',
      platform: 'linux',
      exists: path => path === '/home/user/.local/bin/edge-tts'
    });

    expect(resolved).toBe('/home/user/.local/bin/edge-tts');
  });

  it('tries Windows executable extensions before the bare name', () => {
    const resolved = resolveCreatorExecutable({
      name: 'ffmpeg',
      searchPath: 'C:\\tools;C:\\ffmpeg\\bin',
      platform: 'win32',
      exists: path => path === 'C:\\ffmpeg\\bin\\ffmpeg.exe'
    });

    expect(resolved).toBe('C:\\ffmpeg\\bin\\ffmpeg.exe');
  });

  it('prefers an explicit override and reports a missing override as unavailable', () => {
    const exists = (path: string) => path === '/usr/bin/ffprobe';

    expect(resolveCreatorExecutable({
      name: 'ffprobe',
      overridePath: '/opt/ffprobe',
      searchPath: '/usr/bin',
      platform: 'linux',
      exists
    })).toBeUndefined();
    expect(resolveCreatorExecutable({
      name: 'ffprobe',
      overridePath: '/usr/bin/ffprobe',
      searchPath: '/opt/bin',
      platform: 'linux',
      exists
    })).toBe('/usr/bin/ffprobe');
  });

  it('returns undefined when PATH has no matching executable', () => {
    expect(resolveCreatorExecutable({
      name: 'ffmpeg',
      searchPath: '/opt/bin::',
      platform: 'linux',
      exists: () => false
    })).toBeUndefined();
  });
});
