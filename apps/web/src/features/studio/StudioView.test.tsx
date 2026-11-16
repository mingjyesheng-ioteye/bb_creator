import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StudioCapability, StudioCapabilitiesResponse, StudioJob } from '@opencreator/protocol';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import type { StudioService } from '../../services/studio-service.js';
import { StudioView } from './StudioView.js';

function capability(patch: Partial<StudioCapability>): StudioCapability {
  return {
    id: 'cinematic', group: 'Make something new', title: 'Cinematic shots', blurb: 'blurb', runner: 'wan-text-to-video',
    input: 'none', inputRequired: false, promptRequired: true, output: 'video', params: [], promptHint: 'hint',
    needs: 'ComfyUI', runnable: true, reason: '', ...patch
  };
}

function fakeService(capabilities: StudioCapability[], jobs: StudioJob[] = []) {
  const catalog: StudioCapabilitiesResponse = { capabilities, components: [], checkedAt: '2026-01-01T00:00:00Z' };
  const createJob = vi.fn(async (): Promise<StudioJob> => ({
    id: 'aaaaaaaaaaaa', capability: 'cinematic', title: 'Cinematic shots', status: 'queued', mediaKind: 'video',
    prompt: 'a fox', log: [], createdAt: '2026-01-01T00:00:00Z'
  }));
  const service = {
    capabilities: vi.fn(async () => catalog),
    worker: vi.fn(async () => ({
      mode: 'idle' as const, comfyui: { online: false }, avatar: { online: false }, llm: { online: false },
      unslothVideo: { online: false, reason: '' }, canControl: false, checkedAt: ''
    })),
    listJobs: vi.fn(async () => jobs),
    createJob,
    upload: vi.fn(),
    mediaBlob: vi.fn(),
    cancelJob: vi.fn(),
    deleteJob: vi.fn(),
    startWorker: vi.fn(),
    stopWorker: vi.fn()
  };
  return { service: service as unknown as StudioService, createJob };
}

function renderView(service: StudioService | null, onOpenTemplate = vi.fn()) {
  return render(<LanguageProvider><StudioView service={service} onOpenTemplate={onOpenTemplate} /></LanguageProvider>);
}

describe('StudioView', () => {
  it('runs the selected capability with the typed prompt', async () => {
    const { service, createJob } = fakeService([capability({})]);
    renderView(service);
    const prompt = await screen.findByPlaceholderText('hint');
    const run = screen.getByRole('button', { name: /开始生成|Run/ });
    expect(run).toBeDisabled();
    fireEvent.change(prompt, { target: { value: 'a fox' } });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    await waitFor(() => expect(createJob).toHaveBeenCalledWith({ capability: 'cinematic', prompt: 'a fox', params: {} }));
  });

  it('shows why a capability cannot run and blocks submission', async () => {
    const { service } = fakeService([capability({ runnable: false, reason: 'GPU worker offline' })]);
    renderView(service);
    expect(await screen.findByText('GPU worker offline')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('hint'), { target: { value: 'a fox' } });
    expect(screen.getByRole('button', { name: /开始生成|Run/ })).toBeDisabled();
  });

  it('hands template-owned capabilities to the template workspace', async () => {
    const onOpenTemplate = vi.fn();
    const { service } = fakeService([capability({ id: 'course', title: 'Course video', template: 'course-video', promptRequired: false, promptHint: '' })]);
    renderView(service, onOpenTemplate);
    fireEvent.click((await screen.findAllByRole('button', { name: /Course video/ }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: /Course Video template|课程视频模板/ }));
    expect(onOpenTemplate).toHaveBeenCalledWith('course-video');
  });

  it('asks for a Runtime connection when there is no service', () => {
    renderView(null);
    expect(screen.getByText(/Connect the local Runtime|本机 Runtime/)).toBeInTheDocument();
  });
});
