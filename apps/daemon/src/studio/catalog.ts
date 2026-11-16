import {
  type StudioCapability,
  type StudioParam
} from '@opencreator/protocol';
import { DEFAULT_PIPER_VOICE } from './environment.js';
import { gradeProfiles, reframeAspects } from './ffmpeg.js';

export type CapabilityDefinition = Omit<StudioCapability, 'runnable' | 'reason' | 'params'> & {
  params: StudioParam[];
  /** Defaults the runner applies on top of the user's values (size, frames). */
  defaults?: { size?: string; frames?: number };
};

const voiceParam: StudioParam = { name: 'voice', type: 'select', label: 'Voice', default: DEFAULT_PIPER_VOICE };

const base: Pick<CapabilityDefinition, 'input' | 'inputRequired' | 'promptRequired' | 'output' | 'params'> = {
  input: 'none',
  inputRequired: false,
  promptRequired: true,
  output: 'video',
  params: []
};

export const capabilityDefinitions: CapabilityDefinition[] = [
  {
    ...base, id: 'cinematic', group: 'Make something new', title: 'Cinematic shots',
    blurb: 'Chases, frozen moments and giant-scale reveals from a few sentences.',
    runner: 'wan-text-to-video', needs: 'ComfyUI + Wan 2.2', defaults: { size: '832x480', frames: 81 },
    promptHint: 'Photoreal cinematic shot: a rally car tears through a forest stage at dusk, dust plume behind it, long lens, no text.'
  },
  {
    ...base, id: 'one-take', group: 'Make something new', title: 'Impossible one-take shots',
    blurb: 'One continuous camera move through several worlds without a cut.',
    runner: 'wan-text-to-video', needs: 'ComfyUI + Wan 2.2', defaults: { size: '832x480', frames: 81 },
    promptHint: 'One unbroken shot: a guard runs as a painting floods a gallery, water becomes ship deck, then desert sand, camera never cuts.'
  },
  {
    ...base, id: 'products', group: 'Make something new', title: 'Bring your product to life',
    blurb: 'One product photo in; it comes apart and snaps back together.',
    runner: 'wan-image-to-video', input: 'image', inputRequired: true,
    needs: 'ComfyUI + Wan 2.2 (image-to-video)', defaults: { size: '832x480', frames: 81 },
    promptHint: 'The product separates into its parts in a dark studio, parts hang in an exploded view, then reassemble exactly as the first frame.'
  },
  {
    ...base, id: 'commercials', group: 'Make something new', title: 'Product commercials',
    blurb: 'Premium studio lighting, slow push-ins and clean hero reveals.',
    runner: 'wan-text-to-video', needs: 'ComfyUI + Wan 2.2', defaults: { size: '832x480', frames: 81 },
    promptHint: 'Premium product commercial: matte black headphones on a glossy floor, soft rim light, slow push-in, haze in the light beams, no text.'
  },
  {
    ...base, id: 'broll', group: 'Make something new', title: 'B-roll for lessons',
    blurb: 'Muted, text-free clips that sit behind narration.',
    runner: 'wan-text-to-video', needs: 'ComfyUI + Wan 2.2', defaults: { size: '832x480', frames: 49 },
    promptHint: 'Smooth cinematic b-roll, soft focus, muted colours, slow camera drift, no text, no people.'
  },
  {
    ...base, id: 'minimax', group: 'Make something new', title: 'MiniMax-H3 (local)',
    blurb: 'MiniMax-H3 on the local GPU through Unsloth Studio: cinematic motion, lighting and camera moves.',
    runner: 'minimax-text-to-video', needs: 'Unsloth Studio + MiniMax-H3',
    params: [{ name: 'steps', type: 'number', label: 'Steps', default: 10, min: 1, max: 50 }],
    promptHint: 'A slow cinematic dolly through a rain-soaked neon alley, reflections on wet asphalt, shallow depth of field, no text.'
  },
  {
    ...base, id: 'minimax-i2v', group: 'Make something new', title: 'MiniMax-H3 from a still',
    blurb: 'Bring an uploaded image to life with MiniMax-H3 on the local GPU.',
    runner: 'minimax-image-to-video', input: 'image', inputRequired: true, needs: 'Unsloth Studio + MiniMax-H3',
    params: [{ name: 'steps', type: 'number', label: 'Steps', default: 10, min: 1, max: 50 }],
    promptHint: 'The subject breathes and looks at the camera, gentle head movement, soft studio light, no text.'
  },
  {
    ...base, id: 'presenter', group: 'Make something new', title: 'AI presenter videos',
    blurb: 'A generated still with spoken narration (Piper). No lip-sync, fully offline.',
    runner: 'narrated-visual', needs: 'ComfyUI + Piper', defaults: { size: '480x832' }, params: [voiceParam],
    promptHint: 'A calm presenter explains the two functions of behaviour in a bright studio.'
  },
  {
    ...base, id: '3d-worlds', group: 'Make something new', title: '3D worlds & character animation',
    blurb: 'A deterministic Three.js world built from your prompt and rendered to video.',
    runner: 'world', needs: 'HyperFrames (Node + Chrome)', defaults: { size: '1280x720' },
    params: [{ name: 'duration', type: 'number', label: 'Seconds', default: 8, min: 3, max: 30 }],
    promptHint: 'Misty highlands with pine forests, a stone bridge and a distant observatory at sunrise.'
  },
  {
    ...base, id: 'motion', group: 'Make something new', title: 'Motion graphics',
    blurb: 'A kinetic typography composition authored as HTML and rendered with HyperFrames.',
    runner: 'motion', needs: 'HyperFrames (Node + Chrome)', defaults: { size: '1280x720' },
    params: [{ name: 'duration', type: 'number', label: 'Seconds', default: 6, min: 3, max: 30 }],
    promptHint: 'TIME, TOLD IN SAND'
  },
  {
    ...base, id: 'documentary', group: 'Make something new', title: 'Documentary montage',
    blurb: 'Real footage pulled from Archive.org, NASA and Wikimedia (no keys) and cut together.',
    runner: 'documentary', needs: 'Internet + ffmpeg',
    params: [{ name: 'clips_per_query', type: 'number', label: 'Clips', default: 3, min: 1, max: 5 }],
    promptHint: 'city at dawn, rain on windows, empty streets, traffic lights'
  },
  {
    ...base, id: 'explainer', group: 'Make something new', title: 'Explainers from documents',
    blurb: 'A generated visual with narrated explanation (Piper), offline.',
    runner: 'narrated-visual', needs: 'ComfyUI + Piper', defaults: { size: '832x480' }, params: [voiceParam],
    promptHint: 'A clear explanation of how neural networks learn, friendly and simple.'
  },
  {
    ...base, id: 'course', group: 'Courses', title: 'Course video (PDF / bb_exam)',
    blurb: 'Build a narrated lesson video from a PDF or a published bb_exam course with the Course Video template.',
    runner: 'course', needs: 'Course Video template', promptRequired: false, template: 'course-video',
    promptHint: ''
  },
  {
    ...base, id: 'tighten', group: 'Edit and repurpose', title: 'Tighten your videos',
    blurb: 'Precision cut of an uploaded clip (trim in/out).',
    runner: 'trim', input: 'video', inputRequired: true, promptRequired: false, needs: 'ffmpeg',
    params: [
      { name: 'start_seconds', type: 'number', label: 'Start (s)', default: 0, min: 0 },
      { name: 'end_seconds', type: 'number', label: 'End (s, blank = end)', min: 0 }
    ],
    promptHint: 'Trim the uploaded clip.'
  },
  {
    ...base, id: 'vertical', group: 'Edit and repurpose', title: 'Turn wide video vertical',
    blurb: 'Reframe a landscape cut for Shorts / Reels / TikTok.',
    runner: 'reframe', input: 'video', inputRequired: true, promptRequired: false, needs: 'ffmpeg',
    params: [
      { name: 'target_aspect', type: 'select', label: 'Aspect', options: Object.keys(reframeAspects), default: 'portrait' },
      { name: 'focus_x', type: 'number', label: 'Focus (0 left - 1 right)', default: 0.5, min: 0, max: 1 }
    ],
    promptHint: 'Reframe the uploaded clip, keeping the speaker centred.'
  },
  {
    ...base, id: 'captions', group: 'Edit and repurpose', title: 'Styled captions',
    blurb: 'Transcribe an uploaded clip with Whisper, then burn word-timed captions.',
    runner: 'captions', input: 'video', inputRequired: true, promptRequired: false, needs: 'ffmpeg + faster-whisper',
    params: [{ name: 'model_size', type: 'select', label: 'Whisper model', options: ['tiny', 'base', 'small'], default: 'base' }],
    promptHint: ''
  },
  {
    ...base, id: 'grade', group: 'Change the look', title: 'Colour grade your footage',
    blurb: 'Preset grades applied with ffmpeg, with a blend amount.',
    runner: 'grade', input: 'video', inputRequired: true, promptRequired: false, needs: 'ffmpeg',
    params: [
      { name: 'profile', type: 'select', label: 'Look', options: Object.keys(gradeProfiles), default: 'cinematic_warm' },
      { name: 'intensity', type: 'number', label: 'Intensity (0-1)', default: 1, min: 0, max: 1 }
    ],
    promptHint: 'Grade the uploaded clip.'
  },
  {
    ...base, id: 'narrate', group: 'Sound and music', title: 'Narration (local TTS)',
    blurb: 'Type text, get a spoken WAV with Piper. Offline, no API keys.',
    runner: 'speech', output: 'audio', needs: 'Piper',
    params: [voiceParam],
    promptHint: "Welcome to today's lesson. In this module we will look at the two functions of behaviour."
  },
  {
    ...base, id: 'upscale', group: 'Fix what you shot', title: 'Upscale your videos',
    blurb: 'Upscale soft or compressed footage 2x or 4x with Lanczos resampling and light sharpening (ffmpeg).',
    runner: 'upscale', input: 'video', inputRequired: true, promptRequired: false, needs: 'ffmpeg',
    params: [{ name: 'scale', type: 'select', label: 'Scale', options: ['2', '4'], default: '2' }],
    promptHint: ''
  }
];

export function findCapability(id: string): CapabilityDefinition | undefined {
  return capabilityDefinitions.find(entry => entry.id === id);
}

export class StudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioValidationError';
  }
}

export type ResolvedParams = Record<string, string | number>;

/** Coerce user values to the declared parameter types; unknown names are dropped. */
export function resolveParams(
  definition: CapabilityDefinition,
  raw: Record<string, string | number> | undefined,
  voices: string[]
): ResolvedParams {
  const out: ResolvedParams = {};
  for (const param of definition.params) {
    const value = raw?.[param.name];
    const blank = value === undefined || value === null || value === '';
    if (param.type === 'select') {
      const options = param.name === 'voice' ? voices : param.options ?? [];
      const chosen = blank ? param.default : value;
      if (chosen === undefined) continue;
      if (options.length > 0 && !options.includes(String(chosen))) {
        throw new StudioValidationError(`${param.label} must be one of: ${options.join(', ')}`);
      }
      out[param.name] = String(chosen);
      continue;
    }
    if (blank) {
      if (param.default !== undefined) out[param.name] = Number(param.default);
      continue;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new StudioValidationError(`${param.label} must be a number`);
    if (param.min !== undefined && numeric < param.min) throw new StudioValidationError(`${param.label} must be at least ${param.min}`);
    if (param.max !== undefined && numeric > param.max) throw new StudioValidationError(`${param.label} must be at most ${param.max}`);
    out[param.name] = numeric;
  }
  return out;
}

/** The capability as sent to clients, with installed Piper voices filled in. */
export function publicParams(definition: CapabilityDefinition, voices: string[]): StudioParam[] {
  return definition.params.map(param =>
    param.name === 'voice' ? { ...param, options: voices } : param
  );
}
