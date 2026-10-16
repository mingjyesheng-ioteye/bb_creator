import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { bbExamPublishedCourseSchema } from './bb-exam.js';

export type CourseImportRequest = {
  baseUrl: string;
  token: string;
  slug: string;
  signal: AbortSignal;
};

/**
 * Imports a published `bb_exam` course through its public API and stores the
 * raw payload as the `course-spec` artifact. The base URL and bearer token are
 * resolved from runtime configuration; a per-job `bbExamBaseUrl` overrides the
 * configured base URL.
 */
export function createCourseImportExecutor(input: {
  resolveBaseUrl(stateBaseUrl: string): Promise<string>;
  resolveToken(): Promise<string>;
  fetchCourse?(request: CourseImportRequest): Promise<unknown>;
}): CreatorExecutor {
  return {
    id: 'course-import',
    async run(stage) {
      const slug = readString(stage.job.state.courseSlug);
      if (!slug) {
        throw new CreatorExecutorError('course_slug_missing', 'A bb_exam course slug is required');
      }
      const baseUrl = readString(stage.job.state.bbExamBaseUrl) || await input.resolveBaseUrl(readString(stage.job.state.bbExamBaseUrl));
      if (!baseUrl) {
        throw new CreatorExecutorError(
          'course_source_unconfigured',
          'The bb_exam base URL is not configured'
        );
      }

      stage.reportProgress({ phase: 'importing_course', percent: 10 });
      const token = await input.resolveToken();
      const raw = await (input.fetchCourse ?? defaultFetchCourse)({
        baseUrl,
        token,
        slug,
        signal: stage.signal
      });

      const parsed = bbExamPublishedCourseSchema.safeParse(normalizePayload(raw));
      if (!parsed.success) {
        throw new CreatorExecutorError(
          'course_payload_invalid',
          'bb_exam returned an unexpected course payload',
          { issueCount: parsed.error.issues.length }
        );
      }

      const path = join(stage.workdir, 'course-spec.json');
      await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
      stage.reportProgress({ phase: 'completed', percent: 100 });
      return {
        outputs: [{
          kind: 'course-spec',
          status: 'completed',
          path,
          metadata: {
            slug,
            courseId: parsed.data.id,
            versionId: parsed.data.versionId,
            moduleCount: parsed.data.modules.length,
            fileName: 'course-spec.json',
            mimeType: 'application/json'
          }
        }]
      };
    }
  };
}

async function defaultFetchCourse(request: CourseImportRequest): Promise<unknown> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/api/courses/public/${encodeURIComponent(request.slug)}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token) headers.authorization = `Bearer ${request.token}`;
  const response = await fetch(url, { headers, signal: request.signal });
  if (!response.ok) {
    throw new CreatorExecutorError(
      'course_source_unreachable',
      `bb_exam responded with HTTP ${response.status}`
    );
  }
  return response.json();
}

/** The public route wraps the course in `{ success, course }`; accept either shape. */
function normalizePayload(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'course' in raw) {
    return (raw as { course: unknown }).course;
  }
  return raw;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
