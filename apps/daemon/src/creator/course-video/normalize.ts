import {
  courseLessonSchemaVersion,
  type CourseLessonAssessment,
  type CourseLessonModule,
  type CourseLessonPresenter,
  type CourseLessonQuizQuestion,
  type CourseLessonSlide
} from '@opencreator/protocol';
import type { BbExamModule, BbExamPublishedCourse } from './bb-exam.js';

/**
 * Default presenter for a normalized course lesson: a local GPU talking-head
 * model run directly. The workspace or agent can override it per job.
 */
export const COURSE_VIDEO_DEFAULT_PRESENTER: CourseLessonPresenter = {
  mode: 'video',
  layout: 'pip-br',
  name: 'Instructor',
  role: 'Training Instructor',
  accentColor: '#FFD166'
};

const ROLE_LABELS: Record<'instructor' | 'learner', string> = {
  instructor: 'Instructor',
  learner: 'Learner'
};

/**
 * Deterministically map a published `bb_exam` course into renderable course
 * lessons — one lesson per module, in module order. Pure and side-effect free:
 * the same input always produces the same lesson, so it is safe to snapshot.
 */
export function normalizeBbExamCourse(input: {
  course: BbExamPublishedCourse;
  sourceHash: string;
}): CourseLessonModule[] {
  const modules = [...input.course.modules].sort((a, b) => a.order - b.order);
  return modules.map((module) =>
    normalizeBbExamModule({
      course: input.course,
      module,
      moduleTotal: modules.length,
      sourceHash: input.sourceHash
    })
  );
}

export function normalizeBbExamModule(input: {
  course: BbExamPublishedCourse;
  module: BbExamModule;
  moduleTotal: number;
  sourceHash: string;
}): CourseLessonModule {
  const { course, module, moduleTotal, sourceHash } = input;
  const assessment = buildAssessment(module, course.passingThreshold);
  return {
    schemaVersion: courseLessonSchemaVersion,
    id: module.moduleKey,
    brand: course.branding?.organization?.trim() || course.title,
    courseTitle: course.title,
    moduleTitle: module.title,
    level: module.level,
    moduleIndex: module.order,
    moduleTotal,
    presenter: { ...COURSE_VIDEO_DEFAULT_PRESENTER },
    slides: buildSlides(module),
    ...(assessment ? { assessment } : {}),
    source: {
      courseId: course.id,
      versionId: course.versionId,
      slug: course.slug,
      moduleKey: module.moduleKey,
      sourceHash
    }
  };
}

function buildSlides(module: BbExamModule): CourseLessonSlide[] {
  const key = module.moduleKey;
  const summary = module.summary.trim();
  const slides: CourseLessonSlide[] = [
    {
      id: `${key}:title`,
      kind: 'title',
      heading: module.title,
      sub: module.level,
      bullets: [],
      narration: summary || module.title
    }
  ];

  if (module.objectives.length > 0) {
    slides.push({
      id: `${key}:objectives`,
      kind: 'objectives',
      heading: 'Objectives',
      bullets: module.objectives,
      narration: `By the end of this module, you will be able to: ${module.objectives.join('; ')}.`
    });
  }

  module.blocks.forEach((block, index) => {
    slides.push({
      id: `${key}:block:${block.id || index}`,
      kind: 'content',
      heading: block.title,
      ...(block.kind === 'on_shift' ? { sub: 'On shift' } : {}),
      bullets: [],
      narration: block.body
    });
  });

  if (module.conversation.length > 0) {
    slides.push({
      id: `${key}:dialogue`,
      kind: 'dialogue',
      heading: 'Discussion',
      bullets: module.conversation.map((turn) => `${ROLE_LABELS[turn.role]}: ${turn.text}`),
      narration: module.conversation.map((turn) => turn.text).join(' ')
    });
  }

  slides.push({
    id: `${key}:summary`,
    kind: 'summary',
    heading: 'Summary',
    bullets: [],
    narration: summary || `This concludes ${module.title}.`
  });

  return slides;
}

function buildAssessment(
  module: BbExamModule,
  passingThreshold: number
): CourseLessonAssessment | undefined {
  const questions: CourseLessonQuizQuestion[] = [];
  for (const question of [...module.quiz].sort((a, b) => a.order - b.order)) {
    const answerIndex = question.options.findIndex((option) => option.id === question.correctOptionId);
    questions.push({
      id: question.questionId,
      prompt: question.prompt,
      options: question.options.map((option) => option.text),
      ...(answerIndex >= 0 ? { answerIndex } : {})
    });
  }
  if (questions.length === 0) return undefined;
  return {
    passingPercent: Math.round(clampFraction(passingThreshold) * 100),
    questions
  };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}
