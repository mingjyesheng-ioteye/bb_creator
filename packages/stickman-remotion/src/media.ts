export function fileUrl(path: string): string {
  if (/^(?:https?:|data:|blob:)/i.test(path)) return path;
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}
