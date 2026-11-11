import { describe, expect, it } from 'vitest';
import {
  codexLlmProviderOptions,
  inferLlmProviderId,
  isLocalLlmProvider,
  llmProviderOptions,
  llmProviderRequiresApiKey
} from './llm-provider-selection.js';

describe('llm provider selection', () => {
  it('recognizes local providers by their default port', () => {
    expect(inferLlmProviderId('http://127.0.0.1:8686/v1', 'qwen3:8b')).toBe('locmodel');
    expect(inferLlmProviderId('http://localhost:11434/v1', 'llama3')).toBe('ollama');
    expect(inferLlmProviderId('http://127.0.0.1:1234/v1', 'local-model')).toBe('lm-studio');
    expect(inferLlmProviderId('http://127.0.0.1:8080/v1', 'local-model')).toBe('llama-cpp');
  });

  it('keeps inferring remote providers from their Base URL or model', () => {
    expect(inferLlmProviderId('https://api.deepseek.com', 'deepseek-v4-pro')).toBe('deepseek');
    expect(inferLlmProviderId('https://api.minimax.io', 'MiniMax-M2.7')).toBe('minimax');
    expect(inferLlmProviderId('https://api.openai.com/v1', 'gpt-5.6-sol')).toBe('openai');
    expect(inferLlmProviderId('https://gateway.example.test/v1', 'custom-model')).toBe('custom');
  });

  it('does not treat a LAN address as a keyless local provider', () => {
    expect(inferLlmProviderId('http://192.168.1.20:11434/v1', 'llama3')).toBe('custom');
  });

  it('reports which providers require an API key', () => {
    expect(isLocalLlmProvider('locmodel')).toBe(true);
    expect(isLocalLlmProvider('openai')).toBe(false);
    expect(llmProviderRequiresApiKey('locmodel')).toBe(false);
    expect(llmProviderRequiresApiKey('ollama')).toBe(false);
    expect(llmProviderRequiresApiKey('openai')).toBe(true);
    expect(llmProviderRequiresApiKey('custom')).toBe(true);
  });

  it('keeps keyless local providers out of the Codex agent setup list', () => {
    expect(llmProviderOptions.map(provider => provider.id)).toEqual(
      expect.arrayContaining(['locmodel', 'ollama', 'lm-studio', 'llama-cpp'])
    );
    expect(codexLlmProviderOptions.map(provider => provider.id)).not.toEqual(
      expect.arrayContaining(['locmodel', 'ollama', 'lm-studio', 'llama-cpp'])
    );
  });
});
