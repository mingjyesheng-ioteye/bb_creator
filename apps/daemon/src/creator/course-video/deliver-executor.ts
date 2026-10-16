import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CourseLessonModule } from '@opencreator/protocol';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';

export type CourseMediaUploadRequest = {
  baseUrl: string;
  token: string;
  courseId: string;
  versionId: string;
  moduleKey: string;
  kind: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
};

export type CourseMediaUploadResult = { url: string | null };

/**
 * Writes the rendered course video back into `bb_exam` as a version media
 * artifact (Appendix A). If the bb_exam base URL or token is not configured the
 * stage degrades to a manifest with `uploaded: false` instead of failing, so
 * rendering still completes without write-back.
 */
export function createCourseDeliveryExecutor(input: {
  resolveBaseUrl(stateBaseUrl: string): Promise<string>;
  resolveToken(): Promise<string>;
  uploadMedia?(request: CourseMediaUploadRequest): Promise<CourseMediaUploadResult>;
}): CreatorExecutor {
  return {
    id: 'course-delivery',
    async run(stage) {
      const video = stage.inputArtifacts.find((artifact) => (
        artifact.kind === 'course-video' && artifact.status === 'completed'
      ));
      const lessonArtifact = stage.inputArtifacts.find((artifact) => (
        artifact.kind === 'course-narrated-lesson' && artifact.status === 'completed'
      ));
      if (video?.path === null || video?.path === undefined) {
        throw new CreatorExecutorError('creator_stage_input_missing', 'The rendered course video is required');
      }
      if (lessonArtifact?.path === null || lessonArtifact?.path === undefined) {
        throw new CreatorExecutorError('creator_stage_input_missing', 'The narrated course lesson is required');
      }

      const lesson = JSON.parse(await readFile(lessonArtifact.path, 'utf8')) as CourseLessonModule;
      const source = lesson.source;
      if (!source?.courseId || !source.versionId || !source.moduleKey) {
        throw new CreatorExecutorError(
          'course_lesson_source_missing',
          'The lesson is missing bb_exam provenance for write-back'
        );
      }

      const uploadPath = join(stage.workdir, 'course-delivery.json');
      const baseUrl = readString(stage.job.state.bbExamBaseUrl) || await input.resolveBaseUrl(readString(stage.job.state.bbExamBaseUrl));
      const token = await input.resolveToken();

      if (!baseUrl || !token) {
        stage.reportProgress({ phase: 'delivering', percent: 50 });
        const manifest = {
          uploaded: false,
          reason: 'unconfigured',
          courseId: source.courseId,
          versionId: source.versionId,
          moduleKey: source.moduleKey
        };
        await writeFile(uploadPath, `${JSON.stringify(manifest, null, 2)}\n`);
        stage.reportProgress({ phase: 'completed', percent: 100 });
        return {
          outputs: [{
            kind: 'course-delivery',
            status: 'completed',
            path: uploadPath,
            sourceArtifactIds: [video.id],
            metadata: { ...manifest, fileName: 'course-delivery.json', mimeType: 'application/json' }
          }]
        };
      }

      stage.reportProgress({ phase: 'delivering', percent: 20 });
      const data = new Uint8Array(await readFile(video.path));
      const result = await (input.uploadMedia ?? defaultUploadMedia)({
        baseUrl,
        token,
        courseId: source.courseId,
        versionId: source.versionId,
        moduleKey: source.moduleKey,
        kind: 'lesson_video',
        fileName: readString(video.metadata.fileName) || basename(video.path),
        mimeType: 'video/mp4',
        data
      });

      const manifest = {
        uploaded: true,
        courseId: source.courseId,
        versionId: source.versionId,
        moduleKey: source.moduleKey,
        url: result.url
      };
      await writeFile(uploadPath, `${JSON.stringify(manifest, null, 2)}\n`);
      stage.reportProgress({ phase: 'completed', percent: 100 });
      return {
        outputs: [{
          kind: 'course-delivery',
          status: 'completed',
          path: uploadPath,
          sourceArtifactIds: [video.id, lessonArtifact.id],
          metadata: {
            uploaded: true,
            courseId: source.courseId,
            versionId: source.versionId,
            moduleKey: source.moduleKey,
            url: result.url ?? '',
            fileName: 'course-delivery.json',
            mimeType: 'application/json'
          }
        }]
      };
    }
  };
}

async function defaultUploadMedia(request: CourseMediaUploadRequest): Promise<CourseMediaUploadResult> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/api/courses/${encodeURIComponent(request.courseId)}/versions/${encodeURIComponent(request.versionId)}/media`;
  const form = new FormData();
  form.set('moduleKey', request.moduleKey);
  form.set('kind', request.kind);
  form.set('file', new Blob([request.data as unknown as BlobPart], { type: request.mimeType }), request.fileName);
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${request.token}` },
    body: form
  });
  if (!response.ok) {
    throw new CreatorExecutorError('course_delivery_failed', `bb_exam responded with HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => null) as { media?: { url?: string } } | null;
  return { url: payload?.media?.url ?? null };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
