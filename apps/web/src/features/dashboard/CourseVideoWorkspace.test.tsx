import type { CreatorActionRequest, CreatorJob } from '@opencreator/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import CourseVideoWorkspace from './CourseVideoWorkspace.js';
import { CreatorSessionProvider } from './creator-session-store.js';

describe('CourseVideoWorkspace', () => {
  it('requires a course slug before starting the pipeline', () => {
    const applyAction = vi.fn();
    render(
      <LanguageProvider initialPreference="zh-CN">
        <CreatorSessionProvider
          initialJob={initialJob()}
          service={{ applyAction, runAgentTurn: vi.fn() }}
        >
          <CourseVideoWorkspace onBack={vi.fn()} />
        </CreatorSessionProvider>
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '生成课程视频' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请先填写 bb_exam 课程标识（slug）');
    expect(applyAction).not.toHaveBeenCalled();
  });

  it('saves settings and starts the import stage', async () => {
    let current = initialJob();
    const applyAction = vi.fn(async (_jobId: string, request: CreatorActionRequest) => {
      if (request.action === 'update-settings') {
        current = {
          ...current,
          revision: current.revision + 1,
          state: { ...current.state, ...(request.input.patch as CreatorJob['state']) }
        };
      }
      return {
        job: current,
        receipt: {
          actor: request.actor ?? 'user' as const,
          action: request.action,
          summary: request.action,
          affectedArtifacts: [],
          newRevision: current.revision,
          createdAt: current.updatedAt
        }
      };
    });

    render(
      <LanguageProvider initialPreference="zh-CN">
        <CreatorSessionProvider
          initialJob={current}
          service={{ applyAction, runAgentTurn: vi.fn() }}
        >
          <CourseVideoWorkspace onBack={vi.fn()} />
        </CreatorSessionProvider>
      </LanguageProvider>
    );

    fireEvent.change(screen.getByPlaceholderText('understanding-behavior'), {
      target: { value: 'understanding-behavior' }
    });
    fireEvent.click(screen.getByRole('button', { name: '生成课程视频' }));

    await waitFor(() => {
      expect(applyAction).toHaveBeenCalledWith(
        'course_video_job',
        expect.objectContaining({ action: 'run-stage', input: { stageId: 'import' } })
      );
    });
    expect(current.state).toMatchObject({ courseSlug: 'understanding-behavior', ratio: '16:9' });
  });
});

function initialJob(): CreatorJob {
  return {
    id: 'course_video_job',
    projectId: 'project_1',
    templateId: 'course-video',
    templateVersion: 1,
    status: 'draft',
    revision: 0,
    state: {
      courseSlug: '',
      moduleKey: '',
      bbExamBaseUrl: '',
      ratio: '16:9',
      voice: 'en-US-AvaNeural',
      rate: '-4%',
      currentStage: null
    },
    agentThreadId: null,
    stages: [],
    artifacts: [],
    providerRequests: [],
    activities: [],
    createdAt: '2026-10-15T09:00:00.000Z',
    updatedAt: '2026-10-15T09:00:00.000Z'
  };
}
