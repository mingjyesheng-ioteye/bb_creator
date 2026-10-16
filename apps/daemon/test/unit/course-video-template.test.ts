import { describe, expect, it } from 'vitest';
import {
  createCourseVideoTemplate,
  createDefaultCreatorTemplateRegistry
} from '../../src/creator/templates/registry.js';

describe('course video template', () => {
  it('declares the import → plan → narration → render → deliver stage graph', () => {
    const template = createCourseVideoTemplate();
    expect(template).toMatchObject({ id: 'course-video', version: 1, renderer: 'course-video' });
    expect(template.stages.map((stage) => stage.id)).toEqual(['import', 'plan', 'narration', 'presenter', 'render', 'deliver']);
    expect(template.stages.map((stage) => stage.executor)).toEqual([
      'course-import',
      'course-plan',
      'course-narration',
      'course-presenter',
      'course-video-remotion',
      'course-delivery'
    ]);
    const render = template.stages.find((stage) => stage.id === 'render')!;
    expect(render.jobCompletionPolicy).toBe('continue');
    expect(render.outputArtifacts).toEqual([{ kind: 'course-video', status: 'completed' }]);
    const deliver = template.stages.find((stage) => stage.id === 'deliver')!;
    expect(deliver.jobCompletionPolicy).toBe('complete');
    expect(deliver.outputArtifacts).toEqual([{ kind: 'course-delivery', status: 'completed' }]);
    expect(template.outputs).toEqual([
      { kind: 'course-video', required: true },
      { kind: 'course-delivery', required: true }
    ]);
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
