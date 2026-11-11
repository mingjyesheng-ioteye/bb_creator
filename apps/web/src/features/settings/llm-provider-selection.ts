import {
  creatorProviderCatalogById,
  creatorProviderRequiresApiKey,
  isLoopbackBaseUrl,
  type CreatorProviderCatalogEntry
} from '@opencreator/protocol';

export const llmProviderOptions = Object.values(creatorProviderCatalogById.llm);

/**
 * The startup agent setup configures the local Codex runtime, which still
 * requires an authenticated provider. Keyless local OpenAI servers are only
 * offered from AI Services settings.
 */
export const codexLlmProviderOptions = llmProviderOptions.filter(
  provider => provider.protocol !== 'local'
);

export function inferLlmProviderId(baseUrl: string, model: string): string {
  const localProvider = localProviderForBaseUrl(baseUrl);
  if (localProvider !== undefined) return localProvider.id;
  const normalizedUrl = baseUrl.toLowerCase();
  const normalizedModel = model.toLowerCase();
  if (normalizedUrl.includes('deepseek') || normalizedModel.startsWith('deepseek-')) return 'deepseek';
  if (normalizedUrl.includes('minimax') || normalizedModel.startsWith('minimax-')) return 'minimax';
  if (normalizedUrl.includes('openai.com')) return 'openai';
  return 'custom';
}

export function isLocalLlmProvider(providerId: string): boolean {
  return creatorProviderCatalogById.llm[providerId]?.protocol === 'local';
}

export function llmProviderRequiresApiKey(providerId: string): boolean {
  return creatorProviderRequiresApiKey(creatorProviderCatalogById.llm[providerId]);
}

function localProviderForBaseUrl(
  baseUrl: string
): CreatorProviderCatalogEntry | undefined {
  if (!isLoopbackBaseUrl(baseUrl)) return undefined;
  const port = portOf(baseUrl);
  if (port === undefined) return undefined;
  return Object.values(creatorProviderCatalogById.llm).find(provider => (
    provider.protocol === 'local'
    && provider.defaultBaseUrl !== undefined
    && portOf(provider.defaultBaseUrl) === port
  ));
}

function portOf(value: string): string | undefined {
  try {
    return new URL(value.trim()).port;
  } catch {
    return undefined;
  }
}
