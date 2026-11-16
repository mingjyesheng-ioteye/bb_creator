import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import { GpuWorkerBar } from './GpuWorkerBar.js';

function workerService() {
  return {
    worker: vi.fn(async () => ({
      mode: 'idle' as const, comfyui: { online: false }, avatar: { online: true },
      llm: { online: false }, unslothVideo: { online: false, reason: '' },
      canControl: true, checkedAt: ''
    })),
    startWorker: vi.fn(async () => ({ ok: false, steps: { comfy: { ok: false, detail: 'Start failed' } } })),
    stopWorker: vi.fn(async () => ({ ok: true, steps: {} }))
  };
}

describe('GpuWorkerBar', () => {
  it('shows status, permits a recheck, and preserves action failures', async () => {
    const service = workerService();
    render(<LanguageProvider initialPreference="en-US"><GpuWorkerBar service={service} /></LanguageProvider>);
    const start = await screen.findByRole('button', { name: 'Start' });
    expect(start).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    fireEvent.click(start);
    expect(await screen.findByRole('alert')).toHaveTextContent('Start failed');
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(service.worker).toHaveBeenCalledWith(true));
    expect(screen.getByRole('alert')).toHaveTextContent('Start failed');
  });

  it('reports status request failures and allows retrying', async () => {
    const service = workerService();
    service.worker.mockRejectedValueOnce(new Error('Connection lost'));
    render(<LanguageProvider initialPreference="en-US"><GpuWorkerBar service={service} /></LanguageProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await screen.findByRole('button', { name: 'Start' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('notifies Studio when worker availability changes', async () => {
    const service = workerService();
    const onWorkerChange = vi.fn();
    render(<LanguageProvider initialPreference="en-US"><GpuWorkerBar service={service} onWorkerChange={onWorkerChange} /></LanguageProvider>);
    await screen.findByRole('button', { name: 'Start' });
    service.worker.mockResolvedValueOnce({
      mode: 'idle', comfyui: { online: true }, avatar: { online: true },
      llm: { online: false }, unslothVideo: { online: false, reason: '' },
      canControl: true, checkedAt: ''
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }));
    await waitFor(() => expect(onWorkerChange).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
});
