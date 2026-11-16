import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const stockSources = ['archive_org', 'nasa', 'wikimedia'] as const;
export type StockSource = typeof stockSources[number];

export type StockCandidate = {
  source: StockSource;
  title: string;
  url: string;
  bytes?: number;
  license: string;
};

export type StockClip = StockCandidate & { path: string };

const USER_AGENT = 'OpenCreator-Studio/1.0 (local media tool; contact: local-user)';
const MIN_BYTES = 200 * 1024;
const MAX_BYTES = 80 * 1024 * 1024;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|ogv|m4v)$/i;

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return await response.json();
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function searchArchiveOrg(fetchImpl: Fetch, query: string, limit: number, signal: AbortSignal): Promise<StockCandidate[]> {
  const q = `(${query}) AND mediatype:movies AND licenseurl:*`;
  const search = new URL('https://archive.org/advancedsearch.php');
  search.searchParams.set('q', q);
  search.searchParams.append('fl[]', 'identifier');
  search.searchParams.append('fl[]', 'title');
  search.searchParams.append('fl[]', 'licenseurl');
  search.searchParams.set('rows', String(limit * 3));
  search.searchParams.set('output', 'json');
  const found = await getJson(fetchImpl, search.toString(), signal) as { response?: { docs?: unknown } };
  const candidates: StockCandidate[] = [];
  for (const doc of records(found.response?.docs)) {
    if (candidates.length >= limit) break;
    const identifier = text(doc.identifier);
    if (identifier.length === 0) continue;
    let meta: { files?: unknown };
    try {
      meta = await getJson(fetchImpl, `https://archive.org/metadata/${encodeURIComponent(identifier)}`, signal) as { files?: unknown };
    } catch {
      continue;
    }
    const files = records(meta.files)
      .map(file => ({ name: text(file.name), bytes: Number(file.size) }))
      .filter(file => /\.mp4$/i.test(file.name) && file.bytes >= MIN_BYTES && file.bytes <= MAX_BYTES)
      .sort((left, right) => left.bytes - right.bytes);
    const file = files[0];
    if (file === undefined) continue;
    candidates.push({
      source: 'archive_org',
      title: text(doc.title) || identifier,
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      bytes: file.bytes,
      license: text(doc.licenseurl) || 'see archive.org item'
    });
  }
  return candidates;
}

export async function searchNasa(fetchImpl: Fetch, query: string, limit: number, signal: AbortSignal): Promise<StockCandidate[]> {
  const search = new URL('https://images-api.nasa.gov/search');
  search.searchParams.set('q', query);
  search.searchParams.set('media_type', 'video');
  search.searchParams.set('page_size', String(limit * 2));
  const found = await getJson(fetchImpl, search.toString(), signal) as { collection?: { items?: unknown } };
  const candidates: StockCandidate[] = [];
  for (const item of records(found.collection?.items)) {
    if (candidates.length >= limit) break;
    const href = text(item.href);
    if (!href.startsWith('https://')) continue;
    let assets: unknown;
    try {
      assets = await getJson(fetchImpl, href, signal);
    } catch {
      continue;
    }
    const urls = (Array.isArray(assets) ? assets : []).filter((entry): entry is string => typeof entry === 'string' && /\.mp4$/i.test(entry));
    const pick = urls.find(url => /~medium\.mp4$/i.test(url)) ?? urls.find(url => /~small\.mp4$/i.test(url)) ?? urls.find(url => !/~orig/i.test(url));
    if (pick === undefined) continue;
    const data = records(item.data)[0];
    candidates.push({
      source: 'nasa',
      title: text(data?.title) || 'NASA video',
      url: pick.replace(/^http:/, 'https:'),
      license: 'NASA media (generally public domain)'
    });
  }
  return candidates;
}

export async function searchWikimedia(fetchImpl: Fetch, query: string, limit: number, signal: AbortSignal): Promise<StockCandidate[]> {
  const search = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [key, value] of Object.entries({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `filetype:video ${query}`,
    gsrnamespace: '6', gsrlimit: String(limit * 3), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata'
  })) search.searchParams.set(key, value);
  const found = await getJson(fetchImpl, search.toString(), signal) as { query?: { pages?: Record<string, unknown> } };
  const candidates: StockCandidate[] = [];
  for (const page of Object.values(found.query?.pages ?? {})) {
    if (candidates.length >= limit) break;
    const entry = page as { title?: unknown; imageinfo?: unknown };
    const info = records(entry.imageinfo)[0];
    const bytes = Number(info?.size);
    const url = text(info?.url);
    if (url.length === 0 || !(bytes >= MIN_BYTES && bytes <= MAX_BYTES)) continue;
    if (!VIDEO_EXTENSION.test(new URL(url).pathname)) continue;
    const meta = (info?.extmetadata ?? {}) as Record<string, { value?: unknown }>;
    candidates.push({
      source: 'wikimedia',
      title: text(entry.title).replace(/^File:/, ''),
      url,
      bytes,
      license: text(meta.LicenseShortName?.value) || 'see Wikimedia Commons'
    });
  }
  return candidates;
}

const searchers: Record<StockSource, typeof searchArchiveOrg> = {
  archive_org: searchArchiveOrg,
  nasa: searchNasa,
  wikimedia: searchWikimedia
};

export async function downloadStockClip(
  fetchImpl: Fetch,
  candidate: StockCandidate,
  destinationBase: string,
  signal: AbortSignal
): Promise<StockClip | undefined> {
  const response = await fetchImpl(candidate.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
  });
  const length = Number(response.headers.get('content-length') ?? candidate.bytes ?? 0);
  if (!response.ok || response.body === null || length > MAX_BYTES) return undefined;
  const extension = /\.(mp4|webm|mov|ogv|m4v)$/i.exec(new URL(candidate.url).pathname)?.[0].toLowerCase() ?? '.mp4';
  const path = `${destinationBase}${extension}`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));
  return { ...candidate, path };
}

/** Find and download keyless stock footage for every phrase; failures of one source never stop the others. */
export async function fetchStockClips(input: {
  queries: string[];
  perQuery: number;
  sources?: readonly StockSource[];
  directory: string;
  maxClips?: number;
  signal: AbortSignal;
  log?: (message: string) => void;
  fetchImpl?: Fetch;
}): Promise<StockClip[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sources = input.sources ?? stockSources;
  const maxClips = input.maxClips ?? 8;
  await mkdir(input.directory, { recursive: true });
  const clips: StockClip[] = [];
  for (const [queryIndex, query] of input.queries.entries()) {
    let found = 0;
    for (const source of sources) {
      if (found >= input.perQuery || clips.length >= maxClips) break;
      let candidates: StockCandidate[];
      try {
        candidates = await searchers[source](fetchImpl, query, input.perQuery - found, input.signal);
      } catch (error) {
        if (input.signal.aborted) throw error;
        input.log?.(`${source} search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const candidate of candidates) {
        if (found >= input.perQuery || clips.length >= maxClips) break;
        try {
          const clip = await downloadStockClip(fetchImpl, candidate, join(input.directory, `q${queryIndex}-${clips.length}`), input.signal);
          if (clip === undefined) continue;
          clips.push(clip);
          found += 1;
          input.log?.(`${source}: ${candidate.title} (${candidate.license})`);
        } catch (error) {
          if (input.signal.aborted) throw error;
          input.log?.(`${source} download failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return clips;
}
