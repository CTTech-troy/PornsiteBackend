/** Empty base → relative `/api/...` URLs → Vite dev proxy → backend (see admin/vite.config.ts). */
const DEFAULT_API_BASE = '';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function trimTrailingSlash(value: string) {
  return String(value || '').replace(/\/$/, '');
}

function isLocalHost(hostname: string) {
  return LOCAL_HOSTS.has(String(hostname || '').replace(/^\[|\]$/g, ''));
}

function resolveApiBase() {
  const configured = trimTrailingSlash(import.meta.env.VITE_API_URL ?? DEFAULT_API_BASE);
  if (typeof window === 'undefined') return configured;
  if (!isLocalHost(window.location.hostname)) return configured;
  if (!configured) return '';

  try {
    const url = new URL(configured, window.location.origin);
    return isLocalHost(url.hostname) ? configured : '';
  } catch {
    return configured.startsWith('/') ? configured : '';
  }
}

export const API_BASE = resolveApiBase();

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function readApiResponse<T = Record<string, unknown>>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!text) return {} as T;

  const looksJson = contentType.includes('application/json') || /^[\[{]/.test(text.trim());
  if (looksJson) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('The API returned malformed JSON.');
    }
  }

  const details = stripHtml(text).slice(0, 180);
  const routeHint = res.url ? ` ${res.url}` : '';
  throw new Error(
    `Expected JSON from the API but received ${contentType || 'a non-JSON response'} (${res.status}).${routeHint}${details ? ` ${details}` : ''}`,
  );
}

export function apiMessage(data: unknown, fallback = 'Request failed') {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
  }
  return fallback;
}

export function getAdminToken() {
  return localStorage.getItem('admin_token') || '';
}

export function clearAdminSession() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
}

export function isAdminSessionFailure(status: number) {
  return status === 401 || status === 403;
}

export function subscribeAdminEventStream(
  path: string,
  listeners: Record<string, (payload: unknown) => void>,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  let active = true;

  const readStream = async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` },
        signal: controller.signal,
      });

      if (isAdminSessionFailure(res.status)) {
        clearAdminSession();
        window.location.href = '/login';
        return;
      }

      if (!res.ok || !res.body) throw new Error('Live update stream unavailable');
      onConnectionChange?.(true);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleChunk = (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          let eventName = 'message';
          let eventData = '';
          for (const line of rawEvent.split(/\r?\n/)) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) eventData += line.slice(5).trim();
          }

          const listener = listeners[eventName];
          if (listener && eventData) {
            try {
              listener(JSON.parse(eventData));
            } catch {
              listener(eventData);
            }
          }

          boundary = buffer.indexOf('\n\n');
        }
      };

      while (active) {
        const { done, value } = await reader.read();
        if (done) break;
        handleChunk(decoder.decode(value, { stream: true }));
      }
    } catch {
      if (!controller.signal.aborted) onConnectionChange?.(false);
    } finally {
      if (active) onConnectionChange?.(false);
    }
  };

  void readStream();

  return () => {
    active = false;
    onConnectionChange?.(false);
    controller.abort();
  };
}
