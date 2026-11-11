import { describe, expect, it } from 'vitest';
import { resolveCreatorMediaTool } from '../../src/creator/media-tools.js';

describe('creator media tools', () => {
  it('finds ffprobe on PATH for POSIX runtimes', () => {
    const resolved = resolveCreatorMediaTool({
      name: 'ffprobe',
      searchPath: '/opt/bin:/usr/local/bin:/usr/bin',
      platform: 'linux',
      exists: path => path === '/usr/bin/ffprobe'
    });

    expect(resolved).toBe('/usr/bin/ffprobe');
  });

  it('tries Windows executable extensions before the bare name', () => {
    const resolved = resolveCreatorMediaTool({
      name: 'ffmpeg',
      searchPath: 'C:\\tools;C:\\ffmpeg\\bin',
      platform: 'win32',
      exists: path => path === 'C:\\ffmpeg\\bin\\ffmpeg.exe'
    });

    expect(resolved).toBe('C:\\ffmpeg\\bin\\ffmpeg.exe');
  });

  it('prefers an explicit override and reports a missing override as unavailable', () => {
    const exists = (path: string) => path === '/usr/bin/ffprobe';

    expect(resolveCreatorMediaTool({
      name: 'ffprobe',
      overridePath: '/opt/ffprobe',
      searchPath: '/usr/bin',
      platform: 'linux',
      exists
    })).toBeUndefined();
    expect(resolveCreatorMediaTool({
      name: 'ffprobe',
      overridePath: '/usr/bin/ffprobe',
      searchPath: '/opt/bin',
      platform: 'linux',
      exists
    })).toBe('/usr/bin/ffprobe');
  });

  it('returns undefined when PATH has no matching executable', () => {
    expect(resolveCreatorMediaTool({
      name: 'ffmpeg',
      searchPath: '/opt/bin::',
      platform: 'linux',
      exists: () => false
    })).toBeUndefined();
  });
});
