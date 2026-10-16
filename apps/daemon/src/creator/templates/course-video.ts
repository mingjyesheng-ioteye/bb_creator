import { courseLessonRatios } from '@opencreator/protocol';
import { z } from 'zod';
import type { CreatorTemplateAction, CreatorTemplateDefinition, CreatorTemplateStage } from './types.js';

const jsonRecord = z.record(z.string(), z.unknown());

const courseVideoInputSchema = z.object({
  /** `bb_exam` published course slug to import. */
  courseSlug: z.string().trim().default(''),
  /** Optional module key; blank imports the first module of the course. */
  moduleKey: z.string().trim().default(''),
  /** Optional `bb_exam` base URL override; otherwise resolved from settings. */
  bbExamBaseUrl: z.string().trim().default(''),
  ratio: z.enum(courseLessonRatios).default('16:9'),
  voice: z.string().trim().default('en-US-AvaNeural'),
  rate: z.string().trim().default('-4%'),
  currentStage: z.string().nullable().default(null)
}).passthrough();

const stage = (
  definition: Omit<CreatorTemplateStage, 'allowedJobStatuses' | 'jobCompletionPolicy'> & { final?: boolean }
): CreatorTemplateStage => {
  const { final = false, ...value } = definition;
  return {
    ...value,
    allowedJobStatuses: ['draft', 'running', 'failed', 'needs_input', 'completed'],
    jobCompletionPolicy: final ? 'complete' : 'continue',
    resultVersionPolicy: final ? 'snapshot' : 'none'
  };
};

const action = (
  id: string,
  schema: z.ZodTypeAny,
  allowedStages: string[]
): CreatorTemplateAction => ({ id, inputSchema: schema as never, allowedStages });

export const courseVideoStageIds = ['import', 'plan', 'narration', 'presenter', 'render', 'deliver'] as const;

export function createCourseVideoTemplate(): CreatorTemplateDefinition {
  const allStages = [...courseVideoStageIds];
  return {
    id: 'course-video',
    version: 1,
    renderer: 'course-video',
    inputSchema: courseVideoInputSchema as never,
    stages: [
      stage({
        id: 'import',
        executor: 'course-import',
        inputArtifacts: [],
        outputArtifacts: [{ kind: 'course-spec', status: 'completed' }]
      }),
      stage({
        id: 'plan',
        executor: 'course-plan',
        dependsOn: ['import'],
        inputArtifacts: [{ kind: 'course-spec', selector: 'latest-completed' }],
        outputArtifacts: [{ kind: 'course-lesson', status: 'completed' }]
      }),
      stage({
        id: 'narration',
        executor: 'course-narration',
        dependsOn: ['plan'],
        inputArtifacts: [{ kind: 'course-lesson', selector: 'latest-completed' }],
        outputArtifacts: [{ kind: 'course-narrated-lesson', status: 'completed' }]
      }),
      stage({
        id: 'presenter',
        executor: 'course-presenter',
        dependsOn: ['narration'],
        inputArtifacts: [{ kind: 'course-narrated-lesson', selector: 'latest-completed' }],
        outputArtifacts: [{ kind: 'course-avatar', status: 'completed' }]
      }),
      stage({
        id: 'render',
        executor: 'course-video-remotion',
        dependsOn: ['presenter'],
        inputArtifacts: [
          { kind: 'course-narrated-lesson', selector: 'latest-completed' },
          { kind: 'course-avatar', selector: 'latest-completed', optional: true }
        ],
        outputArtifacts: [{ kind: 'course-video', status: 'completed' }]
      }),
      stage({
        id: 'deliver',
        executor: 'course-delivery',
        dependsOn: ['render'],
        final: true,
        inputArtifacts: [
          { kind: 'course-video', selector: 'latest-completed' },
          { kind: 'course-narrated-lesson', selector: 'latest-completed' }
        ],
        outputArtifacts: [{ kind: 'course-delivery', status: 'completed' }]
      })
    ],
    actions: [
      action('update-settings', z.object({ patch: jsonRecord, activityMode: z.enum(['draft', 'semantic']).optional(), objectId: z.string().optional() }).strict(), allStages),
      action('run-stage', z.object({ stageId: z.string().min(1) }).strict(), allStages),
      action('retry-stage', z.object({ stageId: z.string().min(1), scopeKey: z.string().min(1).optional() }).strict(), allStages),
      action('undo-action', z.object({ patch: jsonRecord }).strict(), allStages)
    ],
    outputs: [
      { kind: 'course-video', required: true },
      { kind: 'course-delivery', required: true }
    ],
    agentGuidance: [
      '先确定要导入的 bb_exam 已发布课程（courseSlug）与目标模块（moduleKey）。',
      '按 import、plan、narration、render 的阶段边界推进：导入课程内容、生成课程课件、合成旁白、渲染成片。',
      '重新渲染会创建新的结果版本并保留历史视频。'
    ].join('')
  };
}
