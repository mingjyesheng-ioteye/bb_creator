import type {
  CourseVideoCourseDetail,
  CourseVideoCourseListResponse,
  CourseVideoCourseSummary,
  CourseVideoModuleSummary
} from '@opencreator/protocol';
import { bbExamPublishedCourseSchema } from './bb-exam.js';

export type BbExamCourseCatalog = {
  listCourses(): Promise<CourseVideoCourseListResponse>;
  getCourse(slug: string): Promise<CourseVideoCourseDetail>;
};

export type CourseCatalogErrorCode =
  | 'course_source_unconfigured'
  | 'course_source_unreachable'
  | 'course_payload_invalid';

export class CourseCatalogError extends Error {
  constructor(
    readonly code: CourseCatalogErrorCode,
    message: string,
    readonly statusCode = 502
  ) {
    super(message);
    this.name = 'CourseCatalogError';
  }
}

/**
 * Read published courses from `bb_exam` for the Course Video course/module
 * pickers. The public course API is the same source used by the import stage.
 */
export function createBbExamCourseCatalog(input: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
} = {}): BbExamCourseCatalog {
  const baseUrl = (input.baseUrl ?? process.env.OPENCREATOR_BB_EXAM_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const token = (input.token ?? process.env.OPENCREATOR_BB_EXAM_TOKEN ?? '').trim();
  const fetchImpl = input.fetchImpl ?? fetch;

  async function getJson(path: string): Promise<unknown> {
    if (!baseUrl) {
      throw new CourseCatalogError(
        'course_source_unconfigured',
        'The bb_exam base URL is not configured',
        409
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
          accept: 'application/json',
          ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {})
        },
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new CourseCatalogError('course_source_unreachable', 'bb_exam could not be reached', 502);
    }
    if (!response.ok) {
      throw new CourseCatalogError(
        'course_source_unreachable',
        `bb_exam responded with HTTP ${response.status}`,
        502
      );
    }
    return response.json();
  }

  return {
    async listCourses() {
      const payload = await getJson('/api/courses/public') as { courses?: unknown };
      const values = Array.isArray(payload?.courses) ? payload.courses : [];
      const courses: CourseVideoCourseSummary[] = [];
      for (const value of values) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        const course = value as Record<string, unknown>;
        if (typeof course.slug !== 'string' || course.slug.trim().length === 0) continue;
        courses.push({
          id: typeof course.id === 'string' ? course.id : course.slug,
          slug: course.slug,
          title: typeof course.title === 'string' && course.title.trim().length > 0
            ? course.title
            : course.slug,
          ...(typeof course.moduleCount === 'number' ? { moduleCount: course.moduleCount } : {})
        });
      }
      return { courses };
    },

    async getCourse(slug) {
      const payload = await getJson(
        `/api/courses/public/${encodeURIComponent(slug)}`
      ) as { course?: unknown };
      const parsed = bbExamPublishedCourseSchema.safeParse(
        payload?.course ?? payload
      );
      if (!parsed.success) {
        throw new CourseCatalogError(
          'course_payload_invalid',
          'bb_exam returned an unexpected course payload',
          502
        );
      }
      const course = parsed.data;
      const modules: CourseVideoModuleSummary[] = [...course.modules]
        .sort((left, right) => left.order - right.order)
        .map(module => ({
          moduleKey: module.moduleKey,
          title: module.title,
          order: module.order
        }));
      return {
        courseId: course.id,
        versionId: course.versionId,
        slug: course.slug,
        title: course.title,
        modules
      };
    }
  };
}
