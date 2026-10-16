import { describe, expect, it } from 'vitest';
import {
  courseLessonCanvasForRatio,
  courseLessonOptionsPerQuestion,
  courseLessonQuestionsPerModule,
  courseLessonSchemaVersion,
  readCourseLessonRatio
} from './course-video.js';

describe('course lesson protocol', () => {
  it('exposes the current schema version and quiz shape', () => {
    expect(courseLessonSchemaVersion).toBe('1');
    expect(courseLessonQuestionsPerModule).toBe(5);
    expect(courseLessonOptionsPerQuestion).toBe(4);
  });

  it('maps ratios to landscape and portrait canvases', () => {
    expect(courseLessonCanvasForRatio('16:9')).toEqual({ ratio: '16:9', width: 1920, height: 1080 });
    expect(courseLessonCanvasForRatio('9:16')).toEqual({ ratio: '9:16', width: 1080, height: 1920 });
  });

  it('returns a fresh canvas object so callers cannot mutate the table', () => {
    const canvas = courseLessonCanvasForRatio('16:9');
    canvas.width = 1080;
    expect(courseLessonCanvasForRatio('16:9').width).toBe(1920);
  });

  it('defaults unknown ratio values to landscape', () => {
    expect(readCourseLessonRatio('9:16')).toBe('9:16');
    expect(readCourseLessonRatio('16:9')).toBe('16:9');
    expect(readCourseLessonRatio(undefined)).toBe('16:9');
    expect(readCourseLessonRatio('4:3')).toBe('16:9');
  });
});
