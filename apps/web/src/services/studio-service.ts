import {
  studioUploadContentType,
  type CreateStudioJobRequest,
  type StudioCapabilitiesResponse,
  type StudioJob,
  type StudioUploadResponse,
  type StudioWorkerActionResponse,
  type StudioWorkerStatus
} from '@opencreator/protocol';
import type { RuntimeClient } from '../runtime/client.js';

type StudioClient = Pick<RuntimeClient, 'get' | 'post' | 'delete' | 'postBinary' | 'rawGet'>;

export type StudioService = ReturnType<typeof createStudioService>;

export function createStudioService(client: StudioClient) {
  return {
    capabilities(refresh = false): Promise<StudioCapabilitiesResponse> {
      return client.get(`/studio/capabilities${refresh ? '?refresh=1' : ''}`);
    },
    worker(refresh = false): Promise<StudioWorkerStatus> {
      return client.get(`/studio/worker${refresh ? '?refresh=1' : ''}`);
    },
    startWorker(): Promise<StudioWorkerActionResponse> {
      return client.post('/studio/worker/start');
    },
    stopWorker(): Promise<StudioWorkerActionResponse> {
      return client.post('/studio/worker/stop');
    },
    upload(file: File): Promise<StudioUploadResponse> {
      return client.postBinary(
        `/studio/uploads?fileName=${encodeURIComponent(file.name)}`,
        file,
        studioUploadContentType
      );
    },
    async listJobs(): Promise<StudioJob[]> {
      return (await client.get<{ jobs: StudioJob[] }>('/studio/jobs')).jobs;
    },
    async createJob(request: CreateStudioJobRequest): Promise<StudioJob> {
      return (await client.post<{ job: StudioJob }>('/studio/jobs', request)).job;
    },
    async getJob(id: string): Promise<StudioJob> {
      return (await client.get<{ job: StudioJob }>(`/studio/jobs/${encodeURIComponent(id)}`)).job;
    },
    async cancelJob(id: string): Promise<StudioJob> {
      return (await client.post<{ job: StudioJob }>(`/studio/jobs/${encodeURIComponent(id)}/cancel`)).job;
    },
    async deleteJob(id: string): Promise<void> {
      await client.delete(`/studio/jobs/${encodeURIComponent(id)}`);
    },
    /** The media endpoint needs the runtime token, so playback goes through a blob. */
    async mediaBlob(id: string): Promise<Blob> {
      const response = await client.rawGet(`/studio/jobs/${encodeURIComponent(id)}/media`);
      return await response.blob();
    }
  };
}
