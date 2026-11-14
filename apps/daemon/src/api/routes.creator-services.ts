import type {
  CodexImageStatus,
  CodexProviderConfig,
  CreatorLocalEngineDetectionResponse,
  CreatorModelDiscoveryResponse,
  CreatorServicesCapabilitiesResponse,
  CreatorServicesConfig,
  CreatorTtsPreviewRequest,
  CreatorTtsProvider
} from '@opencreator/protocol';
import { creatorTextModelHeaders } from '@opencreator/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import {
  CreatorServicesConfigStoreError,
  parseCreatorServicesConfig,
  presentCreatorServicesConfig,
  retainCreatorServicesCredentials,
  type CreatorServicesConfigStore
} from '../creator-services/config-store.js';
import { createKrillinCreatorServicesCapabilities } from '../creator/krillin/capabilities.js';
import { normalizeBaseUrl, readLocalEngineModels } from '../creator-services/local-engine-catalog.js';
import {
  KrillinTtsServiceError,
  type KrillinTtsService
} from '../creator/krillin/tts-service.js';
import { apiError } from './errors.js';
import { gatewayCreatorBinding } from '../gateway/creator-service-source.js';

export async function registerCreatorServicesRoutes(
  server: FastifyInstance,
  store: CreatorServicesConfigStore,
  readCapabilities: () => CreatorServicesCapabilitiesResponse =
    createKrillinCreatorServicesCapabilities,
  ttsService?: Pick<KrillinTtsService, 'listVoices' | 'preview'>,
  onConfigurationChanged?: () => Promise<void> | void,
  readCodexImageStatus?: () => Promise<CodexImageStatus>,
  readCodexModelStatus?: () => Promise<CodexProviderConfig>,
  networkStore: CreatorServicesConfigStore = store
): Promise<void> {
  server.get('/creator-services/network', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { proxy: (await networkStore.read()).proxy }; }
    catch (error) { return sendStoreError(reply, error); }
  });
  server.patch<{ Body: unknown }>('/creator-services/network', async (request, reply) => {
    const body = request.body as { proxy?: unknown } | null;
    const proxy = typeof body?.proxy === 'string' ? body.proxy.trim() : undefined;
    let valid = proxy !== undefined && proxy.length <= 2048;
    if (proxy) {
      try {
        const url = new URL(proxy);
        valid = valid && ['http:', 'https:'].includes(url.protocol) && !!url.hostname
          && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
      } catch { valid = false; }
    }
    if (!valid || !body || Object.keys(body).some(key => key !== 'proxy')) {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'Enter a valid HTTP or HTTPS proxy URL'));
    }
    try {
      const current = await networkStore.read();
      const saved = await networkStore.write({ ...current, proxy: proxy! });
      return { proxy: saved.proxy };
    } catch (error) { return sendStoreError(reply, error); }
  });
  server.get('/creator-services/capabilities', async () => readCapabilities());
  server.get('/creator-services/model/codex/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await readCodexModelStatus?.() ?? {
        authentication: 'none', apiKeyConfigured: false, baseUrl: '', model: ''
      } satisfies CodexProviderConfig;
    } catch {
      return { authentication: 'none', apiKeyConfigured: false, baseUrl: '', model: '' } satisfies CodexProviderConfig;
    }
  });
  server.get('/creator-services/image/codex/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return readCodexImageStatus ? await readCodexImageStatus() : {
      authentication: 'none', ready: false, executionMode: null,
      message: 'Codex image capability checks are not configured. Update or check the Runtime.'
    } satisfies CodexImageStatus;
  });

  server.get('/creator-services/config', async (_request, reply) => {
    try {
      const config = await store.read();
      if (gatewayCreatorBinding(config)) {
        const result = presentCreatorServicesConfig(config);
        clearOfficialAddresses(result.config);
        result.configuredCredentials = [];
        return result;
      }
      return presentCreatorServicesConfig(config);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  server.patch<{ Body: unknown }>('/creator-services/config', async (request, reply) => {
    try {
      const config = parseCreatorServicesConfig(request.body);
      const unsupportedProvider = unsupportedTranscriptionProvider(
        config,
        readCapabilities()
      );
      if (unsupportedProvider !== undefined) {
        return reply.code(400).send(apiError(
          'unsupported_capability',
          `Transcription provider is unavailable on this Runtime: ${unsupportedProvider}`
        ));
      }
      const current = await store.read();
      if (networkStore !== store) config.proxy = (await networkStore.read()).proxy;
      const saved = await store.write(retainCreatorServicesCredentials(config, current));
      try {
        await onConfigurationChanged?.();
      } catch (error) {
        server.log.warn({ error }, 'Creator workflow configuration reconciliation failed');
      }
      return presentCreatorServicesConfig(saved);
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message
        }));
        const firstIssue = issues[0];
        return reply.code(400).send(apiError(
          'VALIDATION_FAILED',
          firstIssue === undefined
            ? 'Creator services configuration is invalid'
            : `Invalid field ${firstIssue.field || 'config'}: ${firstIssue.message}`,
          { fields: issues }
        ));
      }
      return sendStoreError(reply, error);
    }
  });

  server.post<{ Body: unknown }>('/creator-services/transcription/test', async (request, reply) => {
    try {
      const body = request.body as { baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number };
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.replace(/\/+$/, '') : '';
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!/^https?:\/\//i.test(baseUrl) || !model) return reply.code(400).send(apiError('VALIDATION_FAILED', 'FunASR Base URL and model are required'));
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(Math.max(body.timeoutMs ?? 10000, 1000), 60000));
      try {
        const saved = await store.read();
        const configured = saved.transcription.funasr;
        const apiKey = typeof body.apiKey === 'string' && body.apiKey
          ? body.apiKey
          : configured.baseUrl.replace(/\/+$/, '') === baseUrl ? configured.apiKey : '';
        const response = await fetch(`${baseUrl}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal });
        const payload = await response.json().catch(() => undefined) as { data?: Array<{ id?: string }> } | undefined;
        if (!response.ok) return reply.code(502).send(apiError('SMART_DUBBING_UPSTREAM_ERROR', `FunASR connection failed (HTTP ${response.status})`));
        const models = Array.isArray(payload?.data)
          ? payload.data.map(item => item.id).filter((id): id is string => typeof id === 'string')
          : [];
        if (!models.includes(model)) return reply.code(502).send(apiError('SMART_DUBBING_UPSTREAM_ERROR', `FunASR model ${model} is not available`));
        return { connected: true, model, models, capabilities: ['audio.transcriptions'] };
      } finally { clearTimeout(timer); }
    } catch (error) { return reply.code(502).send(apiError('SMART_DUBBING_UPSTREAM_ERROR', error instanceof Error && error.name === 'AbortError' ? 'FunASR connection timed out' : 'FunASR connection failed')); }
  });

  server.post<{ Body: unknown }>('/creator-services/model/discover', async (request, reply) => {
    const body = request.body as { baseUrl?: unknown; apiKey?: unknown } | null;
    const baseUrl = typeof body?.baseUrl === 'string'
      ? body.baseUrl.trim().replace(/\/+$/, '')
      : '';
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(baseUrl);
    } catch {
      endpoint = undefined;
    }
    if (
      endpoint === undefined
      || !['http:', 'https:'].includes(endpoint.protocol)
      || endpoint.username.length > 0
      || endpoint.password.length > 0
    ) {
      return reply.code(400).send(apiError(
        'VALIDATION_FAILED',
        'Base URL must be a valid HTTP or HTTPS URL'
      ));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const saved = await store.read();
      const apiKey = typeof body?.apiKey === 'string' && body.apiKey.length > 0
        ? body.apiKey
        : saved.llm.baseUrl.trim().replace(/\/+$/, '') === baseUrl
          ? saved.llm.apiKey
          : '';
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Accept: 'application/json', ...creatorTextModelHeaders(apiKey) },
        signal: controller.signal
      });
      if (!response.ok) {
        return reply.code(502).send(apiError(
          'creator_llm_discovery_failed',
          `Model service rejected the request (HTTP ${response.status})`
        ));
      }
      const payload = await response.json().catch(() => undefined) as {
        data?: Array<{ id?: unknown }>;
      } | undefined;
      const models = Array.isArray(payload?.data)
        ? [...new Set(payload.data
            .map(item => item?.id)
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
        : [];
      const result: CreatorModelDiscoveryResponse = {
        connected: true,
        baseUrl,
        models,
        latencyMs: Date.now() - startedAt
      };
      return result;
    } catch (error) {
      if (error instanceof CreatorServicesConfigStoreError) return sendStoreError(reply, error);
      return reply.code(502).send(apiError(
        'creator_llm_discovery_failed',
        error instanceof Error && error.name === 'AbortError'
          ? 'The model service did not respond in time'
          : 'Could not reach the model service'
      ));
    } finally {
      clearTimeout(timer);
    }
  });

  server.post<{ Body: unknown }>('/creator-services/local-engine/detect', async (request, reply) => {
    const body = request.body as { baseUrl?: unknown; apiKey?: unknown } | null;
    const rawBaseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : '';
    let baseUrl: string;
    try {
      baseUrl = new URL(rawBaseUrl).toString().replace(/\/+$/, '').replace(/\/v1$/i, '');
    } catch {
      return reply.code(400).send(apiError('VALIDATION_FAILED', 'Base URL must be a valid HTTP or HTTPS URL'));
    }
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const modelsBaseUrl = normalizeBaseUrl(baseUrl);
    // The settings form masks saved keys (it gets an empty apiKey back), so an
    // empty field must fall back to the stored credential instead of sending an
    // unauthenticated request (Unsloth then answers 401).
    const effectiveKey = apiKey.length > 0 ? apiKey : await storedApiKeyFor(store, modelsBaseUrl);
    try {
      const response = await fetch(`${modelsBaseUrl}/models`, {
        headers: { Accept: 'application/json', ...creatorTextModelHeaders(effectiveKey) },
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        const result: CreatorLocalEngineDetectionResponse = {
          connected: false,
          baseUrl: modelsBaseUrl,
          engine: 'unsloth',
          downloadedModels: [],
          error: `Unsloth returned HTTP ${response.status}`
        };
        return result;
      }
      const payload = await response.json().catch(() => undefined) as {
        data?: Array<{ id?: unknown; display_name?: unknown; loaded?: unknown; quant?: unknown }>;
      } | undefined;
      const entries = Array.isArray(payload?.data) ? payload.data : [];
      const loaded = entries.find(entry => entry?.loaded === true && typeof entry.id === 'string');
      const loadedModel = loaded === undefined
        ? undefined
        : {
            name: typeof loaded.display_name === 'string' && loaded.display_name.trim()
              ? loaded.display_name.trim()
              : String(loaded.id),
            ...(typeof loaded.id === 'string' ? { stem: loaded.id } : {})
          };
      const result: CreatorLocalEngineDetectionResponse = {
        connected: true,
        baseUrl: modelsBaseUrl,
        engine: 'unsloth',
        ...(loadedModel === undefined ? {} : { loadedModel }),
        downloadedModels: await readLocalEngineModels({ baseUrl: modelsBaseUrl, apiKey: effectiveKey })
      };
      return result;
    } catch (error) {
      const result: CreatorLocalEngineDetectionResponse = {
        connected: false,
        baseUrl: modelsBaseUrl,
        engine: 'unsloth',
        downloadedModels: [],
        error: error instanceof Error && error.name === 'TimeoutError'
          ? 'Unsloth did not respond in time'
          : 'Could not reach Unsloth Studio'
      };
      return result;
    }
  });

  server.delete('/creator-services/config', async (_request, reply) => {    try {
      const proxy = networkStore !== store ? (await networkStore.read()).proxy : undefined;
      const reset = await store.reset();
      return presentCreatorServicesConfig(proxy === undefined ? reset : await store.write({ ...reset, proxy }));
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  if (ttsService !== undefined) {
    server.get<{
      Querystring: { provider?: string; model?: string };
    }>('/creator-services/tts/voices', async (request, reply) => {
      const provider = parseTtsProvider(request.query.provider);
      if (provider === undefined) {
        return reply.code(400).send(apiError(
          'VALIDATION_FAILED',
          'A valid TTS provider is required'
        ));
      }
      try {
        return await ttsService.listVoices(provider, request.query.model);
      } catch (error) {
        return sendTtsError(reply, error);
      }
    });

    server.post<{ Body: CreatorTtsPreviewRequest }>(
      '/creator-services/tts/preview',
      async (request, reply) => {
        const provider = parseTtsProvider(request.body?.provider);
        if (
          provider === undefined
          || typeof request.body?.voiceId !== 'string'
          || request.body.voiceId.trim().length === 0
        ) {
          return reply.code(400).send(apiError(
            'VALIDATION_FAILED',
            'A valid TTS provider and voice are required'
          ));
        }
        try {
          const result = await ttsService.preview({
            provider,
            voiceId: request.body.voiceId,
            ...(typeof request.body.model === 'string' ? { model: request.body.model } : {}),
            ...(typeof request.body.text === 'string' ? { text: request.body.text } : {})
          });
          return reply
            .header('Content-Type', result.mime)
            .header('Content-Length', String(result.content.length))
            .header('Cache-Control', 'no-store')
            .header('X-Content-Type-Options', 'nosniff')
            .send(result.content);
        } catch (error) {
          return sendTtsError(reply, error);
        }
      }
    );
  }
}

function clearOfficialAddresses(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'baseUrl' || key === 'apiKey' || key === 'proxy') (value as Record<string, unknown>)[key] = '';
    else clearOfficialAddresses(child);
  }
}

/** Credential for a local engine, matched on its stored base URL. */
async function storedApiKeyFor(
  store: CreatorServicesConfigStore,
  modelsBaseUrl: string
): Promise<string> {
  try {
    const config = await store.read();
    const target = comparableUrl(modelsBaseUrl);
    const candidates = [config.llm, config.image.localSd, config.video.localSd];
    const match = candidates.find(candidate => comparableUrl(candidate.baseUrl) === target);
    return match?.apiKey?.trim() ?? '';
  } catch {
    return '';
  }
}

function comparableUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase();
}

function sendStoreError(reply: FastifyReply, error: unknown) {
  if (error instanceof CreatorServicesConfigStoreError) {
    return reply.code(503).send(apiError(error.code, 'Local configuration file is unavailable'));
  }
  throw error;
}

function sendTtsError(reply: FastifyReply, error: unknown) {
  if (error instanceof KrillinTtsServiceError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.message, undefined, undefined, error.publicFacts));
  }
  throw error;
}

function parseTtsProvider(value: unknown): CreatorTtsProvider | undefined {
  if (value === 'openai' || value === 'aliyun' || value === 'minimax' || value === 'edge-tts' || value === 'volcengine') {
    return value;
  }
  return undefined;
}

function unsupportedTranscriptionProvider(
  config: CreatorServicesConfig,
  capabilities: CreatorServicesCapabilitiesResponse
): CreatorServicesConfig['transcription']['provider'] | undefined {
  const selected = capabilities.transcription.providers.find(
    candidate => candidate.provider === config.transcription.provider
  );
  return selected?.available === true ? undefined : config.transcription.provider;
}
