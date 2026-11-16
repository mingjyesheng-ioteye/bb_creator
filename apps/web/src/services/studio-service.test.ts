import { describe, expect, it, vi } from 'vitest';
import { studioUploadContentType } from '@opencreator/protocol';
import type { RuntimeClient } from '../runtime/client.js';
import { createStudioService } from './studio-service.js';

describe('studio service', () => {
  it('uses the Runtime studio endpoints', async () => {
    const get = vi.fn(async () => ({ jobs: [{ id: 'a' }], job: { id: 'a' } }));
    const post = vi.fn(async () => ({ job: { id: 'a' } }));
    const del = vi.fn(async () => ({}));
    const postBinary = vi.fn(async () => ({ id: 'u' }));
    const rawGet = vi.fn(async () => new Response('media'));
    const service = createStudioService({ get, post, delete: del, postBinary, rawGet } as unknown as RuntimeClient);

    await service.capabilities(true);
    await service.worker();
    expect(await service.listJobs()).toEqual([{ id: 'a' }]);
    await service.createJob({ capability: 'grade', uploadId: 'u' });
    await service.cancelJob('a');
    await service.deleteJob('a');
    await service.upload(new File(['x'], 'my clip.mp4'));
    expect(await (await service.mediaBlob('a')).text()).toBe('media');

    expect(get).toHaveBeenCalledWith('/studio/capabilities?refresh=1');
    expect(get).toHaveBeenCalledWith('/studio/worker');
    expect(post).toHaveBeenCalledWith('/studio/jobs', { capability: 'grade', uploadId: 'u' });
    expect(post).toHaveBeenCalledWith('/studio/jobs/a/cancel');
    expect(del).toHaveBeenCalledWith('/studio/jobs/a');
    expect(postBinary).toHaveBeenCalledWith('/studio/uploads?fileName=my%20clip.mp4', expect.any(File), studioUploadContentType);
    expect(rawGet).toHaveBeenCalledWith('/studio/jobs/a/media');
  });
});
