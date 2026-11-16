/**
 * Studio: native media capabilities (generation, edit, repurpose, sound).
 * The Runtime owns the catalog, the availability checks and the job queue;
 * clients only render what these types describe.
 */

export const studioRunnerIds = [
  'wan-text-to-video',
  'wan-image-to-video',
  'minimax-text-to-video',
  'minimax-image-to-video',
  'narrated-visual',
  'world',
  'motion',
  'documentary',
  'trim',
  'reframe',
  'grade',
  'captions',
  'speech',
  'upscale'
] as const;
export type StudioRunnerId = typeof studioRunnerIds[number];

export const studioCapabilityGroups = [
  'Make something new',
  'Edit and repurpose',
  'Change the look',
  'Sound and music',
  'Fix what you shot'
] as const;
export type StudioCapabilityGroup = typeof studioCapabilityGroups[number];

export type StudioParamType = 'number' | 'select';

export type StudioParam = {
  name: string;
  type: StudioParamType;
  label: string;
  options?: string[];
  default?: string | number;
  min?: number;
  max?: number;
};

export type StudioInputKind = 'none' | 'image' | 'video';
export type StudioMediaKind = 'video' | 'audio';

export type StudioCapability = {
  id: string;
  group: StudioCapabilityGroup;
  title: string;
  blurb: string;
  runner: StudioRunnerId;
  input: StudioInputKind;
  /** Whether the job fails without an uploaded input file. */
  inputRequired: boolean;
  /** Whether the prompt box is mandatory for this capability. */
  promptRequired: boolean;
  output: StudioMediaKind;
  params: StudioParam[];
  promptHint: string;
  /** Short label of what the capability needs to run (for display). */
  needs: string;
  runnable: boolean;
  /** Why the capability cannot run right now; empty when runnable. */
  reason: string;
};

export type StudioCapabilitiesResponse = {
  capabilities: StudioCapability[];
  /** Per-component availability (ffmpeg, piper, comfyui, ...). */
  components: StudioComponentStatus[];
  checkedAt: string;
};

export type StudioComponentStatus = {
  id: string;
  label: string;
  available: boolean;
  detail: string;
};

export type StudioJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export type StudioJob = {
  id: string;
  capability: string;
  title: string;
  status: StudioJobStatus;
  mediaKind: StudioMediaKind;
  prompt: string;
  percent?: number;
  message?: string;
  log: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Present once the output file exists. */
  media?: { fileName: string; mime: string; bytes: number };
};

export type CreateStudioJobRequest = {
  capability: string;
  prompt?: string;
  /** Id returned by the upload endpoint. */
  uploadId?: string;
  params?: Record<string, string | number>;
};

export type StudioUploadResponse = {
  id: string;
  fileName: string;
  bytes: number;
  kind: 'image' | 'video';
};

export type StudioWorkerStatus = {
  mode: 'mixed' | 'video' | 'llm' | 'idle';
  comfyui: { online: boolean; vramFreeGb?: number };
  avatar: { online: boolean; engine?: string };
  llm: { online: boolean };
  unslothVideo: { online: boolean; reason: string };
  /** True when this host can start and stop the GPU worker. */
  canControl: boolean;
  checkedAt: string;
};

export type StudioWorkerActionResponse = {
  ok: boolean;
  steps: Record<string, { ok: boolean; detail: string }>;
};

export const studioUploadContentType = 'application/vnd.opencreator.studio-upload';
