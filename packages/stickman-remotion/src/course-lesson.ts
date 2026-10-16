import {
  courseLessonCanvasForRatio,
  type CourseLessonAssessment,
  type CourseLessonModule,
  type CourseLessonRatio,
  type CourseLessonSlide
} from '@opencreator/protocol';

export const COURSE_LESSON_ASSESSMENT_LEAD_SECONDS = 3;
export const COURSE_LESSON_ASSESSMENT_SECONDS_PER_QUESTION = 5;

/** Input props for the `CourseLesson` Remotion composition. */
export type CourseLessonProps = {
  ratio: CourseLessonRatio;
  fps: number;
  width: number;
  height: number;
  lesson: CourseLessonModule;
};

export type CourseLessonTimelineEntry = {
  slide: CourseLessonSlide;
  from: number;
  durationInFrames: number;
};

export function courseLessonSlideFrames(slide: CourseLessonSlide): number {
  return slide.durationInFrames ?? 0;
}

export function courseLessonSlidesFrames(lesson: CourseLessonModule): number {
  return lesson.slides.reduce((total, slide) => total + courseLessonSlideFrames(slide), 0);
}

export function courseLessonAssessmentFrames(
  assessment: CourseLessonAssessment | undefined,
  fps: number
): number {
  if (!assessment || assessment.questions.length === 0) return 0;
  const seconds =
    COURSE_LESSON_ASSESSMENT_LEAD_SECONDS +
    assessment.questions.length * COURSE_LESSON_ASSESSMENT_SECONDS_PER_QUESTION;
  return Math.round(seconds * fps);
}

export function courseLessonTotalFrames(lesson: CourseLessonModule, fps: number): number {
  return courseLessonSlidesFrames(lesson) + courseLessonAssessmentFrames(lesson.assessment, fps);
}

/** Contiguous per-slide placement starting at frame 0. */
export function buildCourseLessonTimeline(lesson: CourseLessonModule): CourseLessonTimelineEntry[] {
  let cursor = 0;
  return lesson.slides.map((slide) => {
    const durationInFrames = courseLessonSlideFrames(slide);
    const entry: CourseLessonTimelineEntry = { slide, from: cursor, durationInFrames };
    cursor += durationInFrames;
    return entry;
  });
}

export function assertCourseLesson(props: CourseLessonProps): CourseLessonProps {
  const canvas = courseLessonCanvasForRatio(props.ratio);
  if (props.width !== canvas.width || props.height !== canvas.height || props.fps <= 0) {
    throw new Error('course_lesson_canvas_invalid');
  }
  if (props.lesson.slides.length === 0) throw new Error('course_lesson_slides_empty');
  for (const slide of props.lesson.slides) {
    if (!slide.id) throw new Error('course_lesson_slide_id_missing');
    if (!slide.narration.trim()) throw new Error(`course_lesson_slide_narration_missing:${slide.id}`);
    if (courseLessonSlideFrames(slide) <= 0) {
      throw new Error(`course_lesson_slide_duration_missing:${slide.id}`);
    }
  }
  if (courseLessonTotalFrames(props.lesson, props.fps) <= 0) {
    throw new Error('course_lesson_total_invalid');
  }
  return props;
}
