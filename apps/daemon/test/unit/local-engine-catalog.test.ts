import { describe, expect, it, vi } from 'vitest';
import {
  normalizeBaseUrl,
  readLocalEngineModels
} from '../../src/creator-services/local-engine-catalog.js';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Unsloth local engine catalog', () => {
  it('lists image and video models and ignores chat models', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      object: 'list',
      data: [
        { id: 'unsloth/Qwen3.8-27B-GGUF', display_name: 'Qwen3.8 27B', loaded: true },
        { id: 'unsloth/Qwen-Image-2.1-Turbo-GGUF', display_name: 'Qwen-Image 2.1 Turbo', quant: 'Q8_0' },
        { id: 'unsloth/MiniMax-H3-GGUF', display_name: 'MiniMax H3' }
      ]
    }));

    const models = await readLocalEngineModels({
      baseUrl: 'http://127.0.0.1:8888',
      apiKey: 'sk-test',
      fetchImpl: fetchMock as never
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8888/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) })
    );
    expect(models).toEqual([
      expect.objectContaining({ id: 'unsloth/MiniMax-H3-GGUF', kind: 'video' }),
      expect.objectContaining({ id: 'unsloth/Qwen-Image-2.1-Turbo-GGUF', kind: 'image', quantization: 'Q8_0' })
    ]);
  });

  it('returns an empty list when Unsloth is unreachable', async () => {
    const models = await readLocalEngineModels({
      baseUrl: 'http://127.0.0.1:8888/v1',
      apiKey: '',
      fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never
    });
    expect(models).toEqual([]);
  });

  it('accepts base URLs with or without /v1', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:8888/v1/')).toBe('http://127.0.0.1:8888/v1');
    expect(normalizeBaseUrl('  ')).toBe('');
  });
});
