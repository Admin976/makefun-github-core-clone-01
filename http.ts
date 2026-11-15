// Small HTTP helpers shared by every surface.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
/** A non-empty, deterministic request id for the X-GitHub-Request-Id header. */
export function requestId(): string {
  requestCounter += 1;
  return `MF-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, payload: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': payload.length, 'x-github-request-id': requestId(), ...headers });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), ...headers });
  res.end();
}

export async function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** A parsed JSON body, or undefined when the bytes are not JSON. */
export function parseJsonBody(bytes: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (bytes.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
