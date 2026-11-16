import { StudioCommandError, runCommand } from './process.js';

export const reframeAspects = {
  portrait: [9, 16],
  vertical_4_5: [4, 5],
  square: [1, 1],
  landscape: [16, 9],
  cinematic: [21, 9]
} as const;
export type ReframeAspect = keyof typeof reframeAspects;

export const gradeProfiles = {
  cinematic_warm: {
    description: 'Warm shadows and orange highlights with a gentle lift',
    filter: "colorbalance=rs=0.08:gs=0.02:bs=-0.05:rh=0.06:gh=0.02:bh=-0.04,curves=all='0/0.03 0.25/0.22 0.5/0.5 0.75/0.78 1/0.97',eq=contrast=1.05:saturation=1.1"
  },
  cinematic_cool: {
    description: 'Teal shadows with warm skin highlights',
    filter: "colorbalance=rs=-0.02:gs=-0.03:bs=0.08:rh=0.06:gh=-0.02:bh=-0.06,curves=all='0/0.02 0.25/0.2 0.5/0.48 0.75/0.78 1/0.98',eq=contrast=1.08:saturation=1.05"
  },
  moody_dark: {
    description: 'Crushed blacks and muted colour',
    filter: "curves=all='0/0.05 0.15/0.12 0.5/0.45 0.85/0.82 1/0.95',eq=contrast=1.12:saturation=0.8:brightness=-0.03"
  },
  bright_clean: {
    description: 'Lifted shadows and vivid colour',
    filter: "curves=all='0/0.05 0.25/0.3 0.5/0.55 0.75/0.8 1/1',eq=saturation=1.15:brightness=0.02"
  },
  vintage_film: {
    description: 'Faded film tint',
    filter: "colorbalance=rs=0.06:gs=0.03:bs=-0.03:rm=0.03:bh=-0.02,curves=all='0/0.06 0.25/0.25 0.5/0.5 0.75/0.74 1/0.94',eq=saturation=0.85:contrast=0.95"
  },
  high_contrast: {
    description: 'Punchy contrast for dynamic footage',
    filter: "curves=all='0/0 0.2/0.12 0.5/0.5 0.8/0.88 1/1',eq=contrast=1.2:saturation=1.1"
  },
  neutral: {
    description: 'Light level correction only',
    filter: 'eq=contrast=1.02:saturation=1.02:brightness=0.01'
  }
} as const;
export type GradeProfile = keyof typeof gradeProfiles;

const VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '160k'];
const FASTSTART = ['-movflags', '+faststart'];

export function isReframeAspect(value: string): value is ReframeAspect {
  return Object.hasOwn(reframeAspects, value);
}

export function isGradeProfile(value: string): value is GradeProfile {
  return Object.hasOwn(gradeProfiles, value);
}

/** Cut `[start, end)` and re-encode, so the cut is frame accurate on any codec. */
export function trimArgs(input: { source: string; output: string; start: number; end?: number }): string[] {
  const args = ['-ss', seconds(input.start), '-i', input.source];
  if (input.end !== undefined) args.push('-t', seconds(Math.max(0.1, input.end - input.start)));
  return [...args, ...VIDEO_ENCODE, ...AUDIO_ENCODE, ...FASTSTART, input.output];
}

/** Largest crop of the target aspect ratio that fits in the frame, with even dimensions. */
export function reframeCrop(input: {
  width: number;
  height: number;
  aspect: ReframeAspect;
  /** Horizontal focus 0..1 (0.5 centres the crop). */
  focusX?: number;
}): { width: number; height: number; x: number; y: number } {
  const [aw, ah] = reframeAspects[input.aspect];
  const ratio = aw / ah;
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  let width = input.width;
  let height = input.height;
  if (input.width / input.height > ratio) width = even(input.height * ratio);
  else height = even(input.width / ratio);
  const focus = Math.min(1, Math.max(0, input.focusX ?? 0.5));
  return {
    width,
    height,
    x: Math.round((input.width - width) * focus),
    y: Math.round((input.height - height) / 2)
  };
}

export function reframeArgs(input: {
  source: string;
  output: string;
  crop: { width: number; height: number; x: number; y: number };
}): string[] {
  const { width, height, x, y } = input.crop;
  return [
    '-i', input.source,
    '-vf', `crop=${width}:${height}:${x}:${y},setsar=1`,
    ...VIDEO_ENCODE, ...AUDIO_ENCODE, ...FASTSTART, input.output
  ];
}

/** Grade with a preset; intensity below 1 blends the graded picture over the original. */
export function gradeArgs(input: {
  source: string;
  output: string;
  profile: GradeProfile;
  intensity: number;
}): string[] {
  const filter = gradeProfiles[input.profile].filter;
  const intensity = Math.min(1, Math.max(0, input.intensity));
  const tail = [...VIDEO_ENCODE, '-c:a', 'copy', ...FASTSTART, input.output];
  if (intensity >= 0.999) return ['-i', input.source, '-vf', filter, ...tail];
  const mix = `A*${(1 - intensity).toFixed(3)}+B*${intensity.toFixed(3)}`;
  return [
    '-i', input.source,
    '-filter_complex', `[0:v]split=2[orig][raw];[raw]${filter}[graded];[orig][graded]blend=all_expr='${mix}'[out]`,
    '-map', '[out]', '-map', '0:a?',
    ...tail
  ];
}

/** Lanczos upscale with light sharpening; used when no neural upscaler is installed. */
export function lanczosUpscaleArgs(input: { source: string; output: string; scale: number }): string[] {
  return [
    '-i', input.source,
    '-vf', `scale=iw*${input.scale}:ih*${input.scale}:flags=lanczos,unsharp=5:5:0.7:3:3:0.3`,
    ...VIDEO_ENCODE, '-c:a', 'copy', ...FASTSTART, input.output
  ];
}

/** Hold a still picture over narration audio. */
export function stillWithAudioArgs(input: { image: string; audio: string; output: string }): string[] {
  return [
    '-loop', '1', '-i', input.image, '-i', input.audio,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
    '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    ...AUDIO_ENCODE, '-shortest', ...FASTSTART, input.output
  ];
}

/** Burn an SRT file into the picture. */
export function burnSubtitlesArgs(input: {
  source: string;
  subtitles: string;
  output: string;
  fontSize?: number;
}): string[] {
  const style = `FontSize=${input.fontSize ?? 22},Outline=2,Shadow=0,MarginV=36,Alignment=2`;
  return [
    '-i', input.source,
    '-vf', `subtitles=filename='${escapeFilterValue(input.subtitles)}':force_style='${style}'`,
    ...VIDEO_ENCODE, '-c:a', 'copy', ...FASTSTART, input.output
  ];
}

/** Escape a value placed inside single quotes in an ffmpeg filter graph. */
export function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

/** Conform a clip to a common frame size and rate so clips can be crossfaded. */
export function normalizeClipArgs(input: {
  source: string;
  output: string;
  width: number;
  height: number;
  fps: number;
  maxSeconds?: number;
}): string[] {
  const filter = `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${input.fps},format=yuv420p`;
  return [
    '-i', input.source,
    ...(input.maxSeconds === undefined ? [] : ['-t', seconds(input.maxSeconds)]),
    '-an', '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    input.output
  ];
}

/** Concatenate normalized clips with crossfades. A single clip is copied. */
export function crossfadeArgs(input: {
  clips: string[];
  durations: number[];
  output: string;
  fade: number;
}): string[] {
  const inputs = input.clips.flatMap(clip => ['-i', clip]);
  if (input.clips.length === 1) {
    return [...inputs, '-c', 'copy', ...FASTSTART, input.output];
  }
  const parts: string[] = [];
  let label = '0:v';
  let elapsed = input.durations[0]!;
  for (let index = 1; index < input.clips.length; index += 1) {
    const offset = Math.max(0, elapsed - input.fade);
    const next = index === input.clips.length - 1 ? 'out' : `v${index}`;
    parts.push(`[${label}][${index}:v]xfade=transition=fade:duration=${input.fade}:offset=${offset.toFixed(3)}[${next}]`);
    label = next;
    elapsed = offset + input.durations[index]!;
  }
  return [
    ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[out]',
    ...VIDEO_ENCODE, ...FASTSTART, input.output
  ];
}

function seconds(value: number): string {
  return value.toFixed(3);
}

export type MediaInfo = {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
};

type FfprobeJson = {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  format?: { duration?: string };
};

export async function probeMedia(ffprobe: string, path: string, signal: AbortSignal): Promise<MediaInfo> {
  const { stdout } = await runCommand(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path
  ], { signal, timeoutMs: 60_000 });
  const parsed = JSON.parse(stdout) as FfprobeJson;
  const video = parsed.streams?.find(stream => stream.codec_type === 'video');
  if (video?.width === undefined || video.height === undefined) {
    throw new StudioCommandError('The input has no video stream', null, '');
  }
  const duration = Number(parsed.format?.duration ?? video.duration ?? 0);
  return {
    width: video.width,
    height: video.height,
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: parsed.streams?.some(stream => stream.codec_type === 'audio') ?? false
  };
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 60 * 60_000
): Promise<void> {
  await runCommand(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    signal,
    timeoutMs
  });
}
