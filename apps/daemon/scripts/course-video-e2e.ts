import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreatorArtifact, CreatorJob, CreatorStageRun } from '@opencreator/protocol';
import { createCourseImportExecutor } from '../src/creator/course-video/import-executor.js';
import { createCoursePlanExecutor } from '../src/creator/course-video/plan-executor.js';
import {
  createCourseNarrationExecutor,
  createEdgeTtsSlideSynthesizer
} from '../src/creator/course-video/narration-executor.js';
import { createCourseRenderExecutor } from '../src/creator/course-video/render-executor.js';
import { readStickmanRemotionRuntime } from '../src/creator/stickman/remotion-runtime.js';

const BASE = process.env.BB_EXAM_BASE_URL ?? 'http://127.0.0.1:3004';
const SLUG = process.env.BB_EXAM_SLUG ?? 'understanding-behavior';
const MODULE_KEY = process.env.MODULE_KEY ?? '';
const EDGE = process.env.EDGE_TTS_CMD ?? '/home/mingj/edge-tts-venv/bin/edge-tts';
const FFPROBE = process.env.FFPROBE ?? '/usr/bin/ffprobe';
const RUNTIME = process.env.REMOTION_RUNTIME ?? '/home/mingj/bb_creator/apps/desktop/.pack/stickman-runtime';
const signal = new AbortController().signal;
const log = (tag: string, value: unknown) => console.log(tag, typeof value === 'string' ? value : JSON.stringify(value));

function job(state: Record<string, unknown>): CreatorJob {
  const now = new Date().toISOString();
  return {
    id: 'e2e-job', projectId: 'e2e-project', templateId: 'course-video', templateVersion: 1,
    status: 'running', revision: 0, state: state as CreatorJob['state'], agentThreadId: null,
    stages: [], artifacts: [], providerRequests: [], activities: [], createdAt: now, updatedAt: now
  };
}
function stageRun(stageId: string, executor: string): CreatorStageRun {
  return {
    id: `${stageId}-run`, jobId: 'e2e-job', stageId, executor, status: 'running',
    dispatchStatus: 'claimed', claimOwner: 'e2e', claimExpiresAt: null, attempt: 1,
    idempotencyKey: null, scopeKey: null, inputFingerprint: null, progress: {}, errorCode: null,
    errorMessage: null, startedAt: new Date().toISOString(), finishedAt: null
  };
}
function artifact(kind: string, id: string, path: string): CreatorArtifact {
  return {
    id, jobId: 'e2e-job', kind, version: 1, status: 'completed', path, scopeKey: null,
    inputFingerprint: null, sha256: null, sourceArtifactIds: [], metadata: {}, createdAt: new Date().toISOString()
  };
}

const root = await mkdtemp(join(tmpdir(), 'course-e2e-'));
const dirs = {
  import: join(root, 'import'),
  plan: join(root, 'plan'),
  narration: join(root, 'narration'),
  render: join(root, 'render')
};
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
log('workdir', root);

// 1. import
const imp = await createCourseImportExecutor({
  resolveBaseUrl: async () => BASE,
  resolveToken: async () => ''
}).run({
  stageRun: stageRun('import', 'course-import'),
  job: job({ courseSlug: SLUG }),
  inputArtifacts: [], workdir: dirs.import, signal,
  reportProgress: p => log('[import]', p)
});
const spec = imp.outputs[0]!;
log('import ->', spec.path);

// 2. plan
const plan = await createCoursePlanExecutor().run({
  stageRun: stageRun('plan', 'course-plan'),
  job: job({ moduleKey: MODULE_KEY }),
  inputArtifacts: [artifact('course-spec', 'spec-1', spec.path!)],
  workdir: dirs.plan, signal,
  reportProgress: p => log('[plan]', p)
});
const lesson = plan.outputs[0]!;
log('plan ->', lesson.path);

// 3. narration
const narr = await createCourseNarrationExecutor({
  synthesizeSlide: createEdgeTtsSlideSynthesizer({ ffprobePath: FFPROBE, command: EDGE })
}).run({
  stageRun: stageRun('narration', 'course-narration'),
  job: job({ voice: 'en-US-AvaNeural', rate: '-4%' }),
  inputArtifacts: [artifact('course-lesson', 'lesson-1', lesson.path!)],
  workdir: dirs.narration, signal,
  reportProgress: p => log('[narration]', p)
});
const narrated = narr.outputs[0]!;
log('narration ->', narrated.path);

// 4. render
const runtime = readStickmanRemotionRuntime(RUNTIME);
const render = await createCourseRenderExecutor({
  ffprobePath: FFPROBE,
  runtimeRoot: RUNTIME,
  runtime
}).run({
  stageRun: stageRun('render', 'course-video-remotion'),
  job: job({ ratio: '16:9' }),
  inputArtifacts: [artifact('course-narrated-lesson', 'narrated-1', narrated.path!)],
  workdir: dirs.render, signal,
  reportProgress: p => log('[render]', p)
});
const video = render.outputs[0]!;
console.log('=== E2E RENDER OK ===');
log('video', video.path);
log('metadata', video.metadata);
