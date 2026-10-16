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
};
