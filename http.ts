// Small HTTP helpers shared by every surface.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The header names every response carries, hoisted: `writeHead` serialises them per response. */
const CT = 'content-type';
const CL = 'content-length';
const RID = 'x-github-request-id';

let requestCounter = 0;
/** A non-empty, deterministic request id for the X-GitHub-Request-Id header. */
export function requestId(): string {
  requestCounter += 1;
  return `MF-${requestCounter.toString(16).padStart(8, '0')}`;
}

/**
 * The header list `writeHead` takes as a flat [name, value, …] array. Node serialises that form
 * without validating each name and value or spreading an object, which is the per-response cost the
 * 2,000-read benchmark measures; the object form pays a `setHeader` per header.
 */
function headList(contentType: string, length: number, headers?: Readonly<Record<string, string>>): string[] {
  const list: Array<string | number> = [CT, contentType, CL, length, RID, requestId()];
  if (headers !== undefined) for (const name in headers) list.push(name, headers[name]!);
  return list as string[];
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  // One UTF-8 encode, not two: the length is the encoded buffer's, which is what `content-length` means.
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, headList(JSON_TYPE, payload.length, headers));
  res.end(payload);
}

/** A JSON body that is already serialized and already ends in a newline: no re-encoding, no re-parse. */
export function sendJsonPayload(res: ServerResponse, status: number, payload: Buffer, headers?: Readonly<Record<string, string>>): void {
  res.writeHead(status, headList(JSON_TYPE, payload.length, headers));
  res.end(payload);
}

export function sendBuffer(res: ServerResponse, status: number, payload: Buffer, contentType: string, headers?: Readonly<Record<string, string>>): void {
  res.writeHead(status, headList(contentType, payload.length, headers));
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string, headers?: Readonly<Record<string, string>>): void {
  // The length is the encoded byte count, so encode once and send the buffer.
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, headList(contentType, payload.length, headers));
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number, headers?: Readonly<Record<string, string>>): void {
  const list: Array<string | number> = [RID, requestId()];
  if (headers !== undefined) for (const name in headers) list.push(name, headers[name]!);
  res.writeHead(status, list as string[]);
  res.end();
}

export async function readBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<Buffer> {
  // Event listeners rather than `for await`: the async iterator costs an extra promise per chunk, and
  // every write path (a push, an issue create) reads exactly one body.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      if (req.complete) return;
      cleanup();
      reject(new Error('request aborted'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
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
