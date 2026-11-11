import { describe, expect, it, vi } from 'vitest';
import { CourseCatalogError, createBbExamCourseCatalog } from '../../src/creator/course-video/catalog.js';

describe('bb_exam course catalog', () => {
  it('lists published courses and maps module metadata', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/api/courses/public')) {
        return new Response(JSON.stringify({
          courses: [{
            id: 'course_1',
            slug: 'understanding-behavior',
            title: 'Understanding Behavior',
            moduleCount: 2
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (value.endsWith('/api/courses/public/understanding-behavior')) {
        return new Response(JSON.stringify({
          course: {
            id: 'course_1',
            slug: 'understanding-behavior',
            versionId: 'version_1',
            title: 'Understanding Behavior',
            modules: [
              { moduleKey: 'm02', order: 2, title: 'Reinforcement' },
              { moduleKey: 'm01', order: 1, title: 'Functions and Causes' }
            ]
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    const catalog = createBbExamCourseCatalog({
      baseUrl: 'https://exam.example.test',
      token: 'exam-token',
      fetchImpl: fetchImpl as typeof fetch
    });

    await expect(catalog.listCourses()).resolves.toEqual({
      courses: [{
        id: 'course_1',
        slug: 'understanding-behavior',
        title: 'Understanding Behavior',
        moduleCount: 2
      }]
    });
    await expect(catalog.getCourse('understanding-behavior')).resolves.toEqual({
      courseId: 'course_1',
      versionId: 'version_1',
      slug: 'understanding-behavior',
      title: 'Understanding Behavior',
      modules: [
        { moduleKey: 'm01', title: 'Functions and Causes', order: 1 },
        { moduleKey: 'm02', title: 'Reinforcement', order: 2 }
      ]
    });
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization)
      .toBe('Bearer exam-token');
  });

  it('reports an unconfigured bb_exam source', async () => {
    const catalog = createBbExamCourseCatalog({ baseUrl: '', token: '' });
    await expect(catalog.listCourses()).rejects.toMatchObject({
      code: 'course_source_unconfigured'
    } satisfies Partial<CourseCatalogError>);
  });
});
