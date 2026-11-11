import { describe, expect, it } from 'vitest';
import {
  creatorTextModelConfigured,
  creatorTextModelHeaders,
  isLoopbackBaseUrl
} from './creator-services.js';

describe('local text model support', () => {
  it('recognizes loopback endpoints as local', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:8686/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.5.0.1:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackBaseUrl('http://192.168.1.20:11434/v1')).toBe(false);
    expect(isLoopbackBaseUrl('')).toBe(false);
    expect(isLoopbackBaseUrl('not-a-url')).toBe(false);
  });

  it('accepts a configured local model without an API key', () => {
    expect(creatorTextModelConfigured({
      baseUrl: 'http://127.0.0.1:8686/v1',
      apiKey: '',
      model: 'qwen3:8b'
    })).toBe(true);
    expect(creatorTextModelConfigured({
      baseUrl: 'http://127.0.0.1:8686/v1',
      apiKey: '',
      model: ''
    })).toBe(false);
  });

  it('still requires a key for remote providers', () => {
    expect(creatorTextModelConfigured({
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-v4-pro'
    })).toBe(false);
    expect(creatorTextModelConfigured({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-v4-pro'
    })).toBe(true);
  });

  it('omits Authorization for local endpoints without a key', () => {
    expect(creatorTextModelHeaders('')).toEqual({});
    expect(creatorTextModelHeaders('   ')).toEqual({});
    expect(creatorTextModelHeaders('local-key')).toEqual({
      Authorization: 'Bearer local-key'
    });
  });
});
