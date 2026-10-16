import { describe, expect, it } from 'vitest';
import { courseLessonSchemaVersion, type CourseLessonModule } from '@opencreator/protocol';
import {
  assertCourseLesson,
  buildCourseLessonTimeline,
  courseLessonAssessmentFrames,
  courseLessonSlidesFrames,
  courseLessonTotalFrames,
  type CourseLessonProps
} from './course-lesson.js';

function buildLesson(overrides: Partial<CourseLessonModule> = {}): CourseLessonModule {
  return {
    schemaVersion: courseLessonSchemaVersion,
    id: 'm01',
    brand: 'Arc Mercer',
    courseTitle: 'Understanding Behavior',
    moduleTitle: 'Functions and Causes of Behavior',
    level: 'Entry',
    moduleIndex: 1,
    moduleTotal: 1,
    presenter: {
      mode: 'placeholder',
      layout: 'pip-br',
      name: 'Instructor',
      role: 'Training Instructor',
      accentColor: '#FFD166'
    },
    slides: [
      { id: 'm01:title', kind: 'title', heading: 'Functions', bullets: [], narration: 'Intro', durationInFrames: 90 },
      { id: 'm01:summary', kind: 'summary', heading: 'Summary', bullets: [], narration: 'Done', durationInFrames: 60 }
    ],
    ...overrides
  };
}

function buildProps(lesson: CourseLessonModule): CourseLessonProps {
  return { ratio: '16:9', fps: 30, width: 1920, height: 1080, lesson };
}

describe('course lesson remotion helpers', () => {
  it('sums slide frames and places slides contiguously', () => {
    const lesson = buildLesson();
    expect(courseLessonSlidesFrames(lesson)).toBe(150);
    expect(buildCourseLessonTimeline(lesson)).toEqual([
      { slide: lesson.slides[0], from: 0, durationInFrames: 90 },
      { slide: lesson.slides[1], from: 90, durationInFrames: 60 }
    ]);
  });

  it('adds assessment frames after the slides', () => {
    const lesson = buildLesson({
      assessment: {
        passingPercent: 80,
        questions: [
          { id: 'q1', prompt: 'A', options: ['a', 'b'], answerIndex: 0 },
          { id: 'q2', prompt: 'B', options: ['a', 'b'], answerIndex: 1 }
        ]
      }
    });
    // lead 3s + 2 questions * 5s = 13s
    expect(courseLessonAssessmentFrames(lesson.assessment, 30)).toBe(390);
    expect(courseLessonTotalFrames(lesson, 30)).toBe(540);
  });

  it('omits assessment frames when there is no assessment', () => {
    expect(courseLessonAssessmentFrames(undefined, 30)).toBe(0);
    expect(courseLessonTotalFrames(buildLesson(), 30)).toBe(150);
  });

  it('accepts a valid lesson and rejects invalid canvas or missing durations', () => {
    const props = buildProps(buildLesson());
    expect(assertCourseLesson(props)).toBe(props);

    expect(() => assertCourseLesson({ ...props, width: 1280 })).toThrow(/canvas_invalid/);

    const noDuration = buildLesson({
      slides: [{ id: 'm01:title', kind: 'title', heading: 'H', bullets: [], narration: 'n' }]
    });
    expect(() => assertCourseLesson(buildProps(noDuration))).toThrow(/duration_missing/);
  });
});
