import { describe, expect, it } from 'vitest';
import {
  bbExamPublishedCourseSchema,
  type BbExamPublishedCourse
} from '../../src/creator/course-video/bb-exam.js';
import {
  COURSE_VIDEO_DEFAULT_PRESENTER,
  normalizeBbExamCourse,
  normalizeBbExamModule
} from '../../src/creator/course-video/normalize.js';

function buildCourse(): BbExamPublishedCourse {
  return bbExamPublishedCourseSchema.parse({
    id: 'course-1',
    slug: 'understanding-behavior',
    versionId: 'version-3',
    title: 'Understanding Behavior',
    description: 'Positive behavior supports',
    passingThreshold: 0.8,
    branding: { organization: 'Arc Mercer — Center of Excellence' },
    modules: [
      {
        moduleKey: 'm01',
        order: 1,
        title: 'Functions and Causes of Behavior',
        level: 'Entry',
        summary: 'Most behavior has a purpose.',
        objectives: ['Identify the function of behavior', 'Describe setting events'],
        blocks: [
          { id: 'b1', title: 'Why behavior happens', body: 'Behavior is communication.', kind: 'teaching' },
          { id: 'b2', title: 'On shift', body: 'Notice what happens right before.', kind: 'on_shift' }
        ],
        conversation: [
          { id: 't1', role: 'instructor', text: 'What comes before the behavior?' },
          { id: 't2', role: 'learner', text: 'The antecedent.' }
        ],
        quiz: [
          {
            questionId: 'q1',
            order: 1,
            prompt: 'The two basic functions of behavior are…',
            options: [
              { id: 'a', text: 'Obtain and escape/avoid' },
              { id: 'b', text: 'Happy and sad' },
              { id: 'c', text: 'Morning and night' },
              { id: 'd', text: 'Loud and quiet' }
            ],
            correctOptionId: 'a'
          },
          {
            questionId: 'q2',
            order: 2,
            prompt: 'What happens right before the behavior is called the…',
            options: [
              { id: 'a', text: 'Consequence' },
              { id: 'b', text: 'Antecedent' },
              { id: 'c', text: 'Setting event' },
              { id: 'd', text: 'Function' }
            ],
            correctOptionId: 'b'
          },
          {
            questionId: 'q3',
            order: 3,
            prompt: 'Broken question (no matching correct option)',
            options: [
              { id: 'a', text: 'One' },
              { id: 'b', text: 'Two' }
            ],
            correctOptionId: 'missing'
          }
        ]
      },
      {
        moduleKey: 'm02',
        order: 2,
        title: 'Understanding Behavior',
        level: 'Entry',
        summary: '',
        objectives: [],
        blocks: [],
        conversation: [],
        quiz: []
      }
    ]
  });
}

describe('course video normalization', () => {
  it('maps a course into one lesson per module in module order', () => {
    const course = buildCourse();
    const lessons = normalizeBbExamCourse({ course, sourceHash: 'sha256-abc' });
    expect(lessons.map((lesson) => lesson.id)).toEqual(['m01', 'm02']);
    expect(lessons.map((lesson) => lesson.moduleIndex)).toEqual([1, 2]);
    expect(lessons.every((lesson) => lesson.moduleTotal === 2)).toBe(true);
    expect(lessons.every((lesson) => lesson.schemaVersion === '1')).toBe(true);
  });

  it('uses branding, module metadata, and the default presenter', () => {
    const lesson = normalizeBbExamCourse({ course: buildCourse(), sourceHash: 'sha256-abc' })[0]!;
    expect(lesson.brand).toBe('Arc Mercer — Center of Excellence');
    expect(lesson.courseTitle).toBe('Understanding Behavior');
    expect(lesson.moduleTitle).toBe('Functions and Causes of Behavior');
    expect(lesson.level).toBe('Entry');
    expect(lesson.presenter).toEqual(COURSE_VIDEO_DEFAULT_PRESENTER);
    expect(lesson.presenter.mode).toBe('video');
  });

  it('builds slides in a deterministic order with dialogue and on-shift markers', () => {
    const lesson = normalizeBbExamCourse({ course: buildCourse(), sourceHash: 'sha256-abc' })[0]!;
    expect(lesson.slides.map((slide) => slide.kind)).toEqual([
      'title',
      'objectives',
      'content',
      'content',
      'dialogue',
      'summary'
    ]);
    expect(lesson.slides[1]!.bullets).toEqual([
      'Identify the function of behavior',
      'Describe setting events'
    ]);
    const onShift = lesson.slides.find((slide) => slide.id === 'm01:block:b2')!;
    expect(onShift.sub).toBe('On shift');
    const dialogue = lesson.slides.find((slide) => slide.kind === 'dialogue')!;
    expect(dialogue.bullets).toEqual([
      'Instructor: What comes before the behavior?',
      'Learner: The antecedent.'
    ]);
    expect(dialogue.narration).toBe('What comes before the behavior? The antecedent.');
  });

  it('maps quiz questions, drops invalid ones, and derives the passing percent', () => {
    const lesson = normalizeBbExamCourse({ course: buildCourse(), sourceHash: 'sha256-abc' })[0]!;
    expect(lesson.assessment?.passingPercent).toBe(80);
    expect(lesson.assessment?.questions.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(lesson.assessment?.questions[0]).toEqual({
      id: 'q1',
      prompt: 'The two basic functions of behavior are…',
      options: ['Obtain and escape/avoid', 'Happy and sad', 'Morning and night', 'Loud and quiet'],
      answerIndex: 0
    });
    expect(lesson.assessment?.questions[1]!.answerIndex).toBe(1);
  });

  it('records provenance back to the bb_exam course version', () => {
    const lesson = normalizeBbExamCourse({ course: buildCourse(), sourceHash: 'sha256-abc' })[0]!;
    expect(lesson.source).toEqual({
      courseId: 'course-1',
      versionId: 'version-3',
      slug: 'understanding-behavior',
      moduleKey: 'm01',
      sourceHash: 'sha256-abc'
    });
  });

  it('omits objectives/dialogue/assessment when the module has none', () => {
    const lesson = normalizeBbExamCourse({ course: buildCourse(), sourceHash: 'sha256-abc' })[1]!;
    expect(lesson.slides.map((slide) => slide.kind)).toEqual(['title', 'summary']);
    expect(lesson.assessment).toBeUndefined();
    expect(lesson.slides[0]!.narration).toBe('Understanding Behavior');
    expect(lesson.slides[1]!.narration).toBe('This concludes Understanding Behavior.');
  });

  it('is deterministic for the same input', () => {
    const course = buildCourse();
    const first = normalizeBbExamCourse({ course, sourceHash: 'h' });
    const second = normalizeBbExamCourse({ course, sourceHash: 'h' });
    expect(first).toEqual(second);
  });

  it('supports normalizing a single module with an explicit total', () => {
    const course = buildCourse();
    const lesson = normalizeBbExamModule({
      course,
      module: course.modules[1]!,
      moduleTotal: 5,
      sourceHash: 'h'
    });
    expect(lesson.moduleIndex).toBe(2);
    expect(lesson.moduleTotal).toBe(5);
  });
});
