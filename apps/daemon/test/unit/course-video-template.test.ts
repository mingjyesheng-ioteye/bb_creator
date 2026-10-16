import { describe, expect, it } from 'vitest';
import {
  createCourseVideoTemplate,
  createDefaultCreatorTemplateRegistry
} from '../../src/creator/templates/registry.js';

describe('course video template', () => {
  it('declares the import → plan → narration → render stage graph', () => {
    const template = createCourseVideoTemplate();
    expect(template).toMatchObject({ id: 'course-video', version: 1, renderer: 'course-video' });
    expect(template.stages.map((stage) => stage.id)).toEqual(['import', 'plan', 'narration', 'render']);
    expect(template.stages.map((stage) => stage.executor)).toEqual([
      'course-import',
      'course-plan',
      'course-narration',
      'course-video-remotion'
    ]);
    const render = template.stages.find((stage) => stage.id === 'render')!;
    expect(render.jobCompletionPolicy).toBe('complete');
    expect(render.outputArtifacts).toEqual([{ kind: 'course-video', status: 'completed' }]);
    expect(template.outputs).toEqual([{ kind: 'course-video', required: true }]);
  });

  it('provides sensible input defaults', () => {
    const template = createCourseVideoTemplate();
    expect(template.inputSchema.parse({})).toMatchObject({
      courseSlug: '',
      moduleKey: '',
      ratio: '16:9',
      voice: 'en-US-AvaNeural'
    });
  });

  it('registers in the default registry with the shared actions', () => {
    const registry = createDefaultCreatorTemplateRegistry();
    const template = registry.get('course-video', 1);
    expect(template.id).toBe('course-video');
    expect(template.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(['update-settings', 'run-stage', 'retry-stage', 'undo-action', 'select-result-version'])
    );
  });
});
