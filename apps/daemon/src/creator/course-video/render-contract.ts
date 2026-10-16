export type CourseRenderRequest = {
  lessonPath: string;
  outputPath: string;
  bundlePath: string;
  browserExecutable: string;
  rendererEntry?: string;
  workdir: string;
  jobRoot: string;
  runtimeRoot: string;
  ratio: '16:9' | '9:16';
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  /**
   * Remotion concurrency (number of parallel browser tabs rendering frames).
   * Omitted -> OPENCREATOR_COURSE_RENDER_CONCURRENCY -> CPU-based default.
   */
  concurrency?: number;
};
