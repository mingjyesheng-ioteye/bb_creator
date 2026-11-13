import type { CreatorLocalModelInfo } from '@opencreator/protocol';

/**
 * Model discovery for the **Unsloth Studio** local engine (OpenAI-compatible).
 *
 * Unsloth replaced LocModel on this host. Its `GET /v1/models` lists every model
 * the app knows about, each with `loaded`, `quant` and a public id; image and
 * video models are filtered out of the chat list here so the image/video
 * settings pages can offer them.
 */
export async function readLocalEngineModels(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<CreatorLocalModelInfo[]> {
  const base = normalizeBaseUrl(input.baseUrl);
  if (base.length === 0) return [];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.apiKey.trim().length > 0) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
  let payload: unknown;
  try {
    const response = await (input.fetchImpl ?? fetch)(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return [];
    payload = await response.json();
  } catch {
    return [];
  }
  const data = Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : [];
  const models: CreatorLocalModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (id.length === 0) continue;
    const kind = modelKind(id);
    if (kind === undefined) continue;
    models.push({
      id,
      name: typeof record.display_name === 'string' && record.display_name.trim()
        ? record.display_name.trim()
        : id.split('/').pop() ?? id,
      kind,
      // Unsloth is a remote app for this daemon; it does not expose local paths.
      path: id,
      sizeBytes: 0,
      ...(typeof record.quant === 'string' && record.quant.trim()
        ? { quantization: record.quant.trim() }
        : {})
    });
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

/** Ids that are usable as image or video models (LLM ids are ignored). */
function modelKind(id: string): CreatorLocalModelInfo['kind'] | undefined {
  const value = id.toLowerCase();
  if (/(?:minimax|video|wan|ti2v|i2v|t2v|ltx|hunyuan|cogvideo|mochi|svd)/.test(value)) return 'video';
  if (/(?:image|flux|z-image|qwen-image|sd3|sdxl|stable-diffusion|chroma|ideogram|kolors)/.test(value)) return 'image';
  return undefined;
}

/** Accept both `http://host:8888` and `http://host:8888/v1`. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
