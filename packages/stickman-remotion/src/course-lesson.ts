import {
  courseLessonAssessmentFrames,
  courseLessonCanvasForRatio,
  courseLessonSlidesFrames,
  courseLessonTotalFrames,
  type CourseLessonModule,
  type CourseLessonRatio,
  type CourseLessonSlide
} from '@opencreator/protocol';

export {
  courseLessonAssessmentFrames,
  courseLessonSlidesFrames,
  courseLessonTotalFrames
} from '@opencreator/protocol';

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
