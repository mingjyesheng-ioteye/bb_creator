import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreatorExecutor } from '../executor.js';
import { CreatorExecutorError } from '../executor.js';
import { bbExamPublishedCourseSchema } from './bb-exam.js';
import { normalizeBbExamModule } from './normalize.js';

/**
 * Turns the imported `course-spec` into a renderable `course-lesson`. The job
 * state's `moduleKey` selects a module; blank selects the first module in
 * course order.
 */
export function createCoursePlanExecutor(): CreatorExecutor {
  return {
    id: 'course-plan',
    async run(stage) {
      const spec = stage.inputArtifacts.find((artifact) => artifact.kind === 'course-spec');
      if (!spec?.path) {
        throw new CreatorExecutorError('course_spec_missing', 'The imported course spec is required');
      }

      const course = bbExamPublishedCourseSchema.parse(JSON.parse(await readFile(spec.path, 'utf8')));
      const moduleKey = readString(stage.job.state.moduleKey);
      const ordered = [...course.modules].sort((left, right) => left.order - right.order);
      const module = moduleKey
        ? ordered.find((candidate) => candidate.moduleKey === moduleKey)
        : ordered[0];
      if (module === undefined) {
        throw new CreatorExecutorError(
          'course_module_missing',
          `The course has no module ${moduleKey || '(first)'}`
        );
      }

      stage.reportProgress({ phase: 'planning_lesson', percent: 30 });
      const lesson = normalizeBbExamModule({
        course,
        module,
        moduleTotal: ordered.length,
        sourceHash: spec.sha256 ?? ''
      });

      const path = join(stage.workdir, 'course-lesson.json');
      await writeFile(path, `${JSON.stringify(lesson, null, 2)}\n`);
      stage.reportProgress({ phase: 'completed', percent: 100 });
      return {
        outputs: [{
          kind: 'course-lesson',
          status: 'completed',
          path,
          sourceArtifactIds: [spec.id],
          metadata: {
            moduleKey: module.moduleKey,
            moduleTitle: module.title,
            slideCount: lesson.slides.length,
            fileName: 'course-lesson.json',
            mimeType: 'application/json'
          }
        }]
      };
    }
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
