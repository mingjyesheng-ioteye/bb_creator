export const courseLessonSchemaVersion = '1' as const;

export const courseLessonQuestionsPerModule = 5;
export const courseLessonOptionsPerQuestion = 4;

export const courseLessonRatios = ['16:9', '9:16'] as const;
export type CourseLessonRatio = typeof courseLessonRatios[number];

export type CourseLessonCanvas = {
  ratio: CourseLessonRatio;
  width: 1920 | 1080;
  height: 1080 | 1920;
};

const courseLessonCanvases: Record<CourseLessonRatio, CourseLessonCanvas> = {
  '16:9': { ratio: '16:9', width: 1920, height: 1080 },
  '9:16': { ratio: '9:16', width: 1080, height: 1920 }
};

export function courseLessonCanvasForRatio(ratio: CourseLessonRatio): CourseLessonCanvas {
  return { ...courseLessonCanvases[ratio] };
}

export function readCourseLessonRatio(value: unknown): CourseLessonRatio {
  return value === '9:16' ? '9:16' : '16:9';
}

export const courseLessonSlideKinds = [
  'title',
  'objectives',
  'content',
  'dialogue',
  'summary'
] as const;
export type CourseLessonSlideKind = typeof courseLessonSlideKinds[number];

/** Word-level caption timing produced by the narration stage. */
export type CourseLessonCaptionWord = {
  word: string;
  start: number;
  end: number;
};

export type CourseLessonSlide = {
  id: string;
  kind: CourseLessonSlideKind;
  heading: string;
  sub?: string;
  bullets: string[];
  narration: string;
  graphic?: string;
  /** Set by the narration stage: relative artifact path or served URL. */
  audioSrc?: string;
  /** Set by the narration stage: word-level captions for the slide. */
  captions?: CourseLessonCaptionWord[];
  /** Set by the presenter stage: talking-head clip for the slide. */
  avatarSrc?: string;
  /** Set by the b-roll stage: background clip for the slide. */
  brollSrc?: string;
  /** Set by the narration stage from the synthesized audio duration. */
  durationInFrames?: number;
};

export type CourseLessonQuizQuestion = {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
};

export type CourseLessonAssessment = {
  passingPercent: number;
  questions: CourseLessonQuizQuestion[];
};

export type CourseLessonPresenterMode = 'video' | 'placeholder' | 'none';

export type CourseLessonPresenter = {
  mode: CourseLessonPresenterMode;
  layout: string;
  name: string;
  role: string;
  accentColor: string;
};

/** Provenance linking a lesson back to its `bb_exam` course version. */
export type CourseLessonSource = {
  courseId: string;
  versionId: string;
  slug: string;
  moduleKey: string;
  sourceHash: string;
};

/**
 * A renderable course lesson. This is OpenCreator's own model (it is not the
 * `bb_exam` course schema and not the retired `bb_video` module JSON).
 */
export type CourseLessonModule = {
  schemaVersion: typeof courseLessonSchemaVersion;
  id: string;
  brand: string;
  courseTitle: string;
  moduleTitle: string;
  level?: string;
  moduleIndex: number;
  moduleTotal: number;
  presenter: CourseLessonPresenter;
  slides: CourseLessonSlide[];
  assessment?: CourseLessonAssessment;
  source?: CourseLessonSource;
};
