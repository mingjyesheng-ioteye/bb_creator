import { z } from 'zod';

/**
 * Zod schemas for the `bb_exam` published course payload consumed by the
 * course-video import stage. This mirrors the subset of `bb_exam/schema/course.ts`
 * that the lesson normalizer needs; it is intentionally permissive about extra
 * fields so `bb_exam` can evolve without breaking import.
 */

export const bbExamSourceRefSchema = z.object({
  sourceId: z.string(),
  pageNumber: z.number().int().positive(),
  excerpt: z.string(),
  provenanceType: z.string()
});

export const bbExamConversationTurnSchema = z.object({
  id: z.string(),
  role: z.enum(['instructor', 'learner']),
  text: z.string(),
  audioAssetUrl: z.string().optional()
});

export const bbExamLessonBlockSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  kind: z.enum(['teaching', 'on_shift']).default('teaching'),
  sourceRefs: z.array(bbExamSourceRefSchema).default([])
});

export const bbExamQuizOptionSchema = z.object({
  id: z.string(),
  text: z.string()
});

export const bbExamQuizQuestionSchema = z.object({
  questionId: z.string(),
  order: z.number().int().positive(),
  prompt: z.string(),
  options: z.array(bbExamQuizOptionSchema).min(1),
  correctOptionId: z.string().optional(),
  explanation: z.string().default(''),
  objectiveIds: z.array(z.string()).default([]),
  sourceRefs: z.array(bbExamSourceRefSchema).default([])
});

export const bbExamModuleSchema = z.object({
  moduleKey: z.string(),
  order: z.number().int().positive(),
  title: z.string(),
  level: z.string().default('Entry'),
  durationMinutes: z.number().int().positive().default(10),
  summary: z.string().default(''),
  objectives: z.array(z.string()).default([]),
  blocks: z.array(bbExamLessonBlockSchema).default([]),
  conversation: z.array(bbExamConversationTurnSchema).default([]),
  sourceRefs: z.array(bbExamSourceRefSchema).default([]),
  quiz: z.array(bbExamQuizQuestionSchema).default([])
});

export const bbExamBrandingSchema = z.object({
  organization: z.string().optional(),
  logoUrl: z.string().optional(),
  heroUrl: z.string().optional(),
  presenterUrl: z.string().optional(),
  instructorAvatarUrl: z.string().optional(),
  learnerAvatarUrl: z.string().optional()
});

export const bbExamPublishedCourseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  versionId: z.string(),
  title: z.string(),
  description: z.string().default(''),
  /** Fractional pass threshold as stored by `bb_exam` (0.8 = 80%). */
  passingThreshold: z.number().default(0.8),
  branding: bbExamBrandingSchema.nullish(),
  modules: z.array(bbExamModuleSchema).min(1)
});

export type BbExamSourceRef = z.infer<typeof bbExamSourceRefSchema>;
export type BbExamConversationTurn = z.infer<typeof bbExamConversationTurnSchema>;
export type BbExamLessonBlock = z.infer<typeof bbExamLessonBlockSchema>;
export type BbExamQuizQuestion = z.infer<typeof bbExamQuizQuestionSchema>;
export type BbExamModule = z.infer<typeof bbExamModuleSchema>;
export type BbExamBranding = z.infer<typeof bbExamBrandingSchema>;
export type BbExamPublishedCourse = z.infer<typeof bbExamPublishedCourseSchema>;
