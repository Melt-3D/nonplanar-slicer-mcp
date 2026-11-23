// The Melt3D Slicer API, as far as this server calls it: POST /v1/slices
// (crates/meltslicer-server/API.md and openapi.yaml in this repository).

import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

/** The print settings /v1/slices takes as query parameters. */
export interface SliceSettings {
    engine?: 'prusaslicer' | 'curaengine' | 'orcaslicer';
    layer_height?: number;
    first_layer_height?: number;
    perimeters?: number;
    infill_density?: number;
    infill_pattern?: 'grid' | 'gyroid' | 'honeycomb';
    nozzle_temp?: number;
    bed_temp?: number;
    brim_width?: number;
    supports?: 'none' | 'bed';
}

export interface SliceRequest {
    apiUrl: string;
    apiKey: string;
    stl: Uint8Array;
    filename: string;
    settings: SliceSettings;
}

export interface Sliced {
    gcode: string;
    /** `full`: printable (live keys). `preview`: the toolpath only (test keys). */
    kind: string;
    /** Requests the key may still make this minute, if the server said. */
    rateLimitRemaining?: number;
    /** How many times the request was sent. */
    attempts: number;
}

/** An error answer: RFC 9457 problem details, or what came instead. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | undefined,
        readonly detail: string,
        readonly retryAfterSecs: number | undefined,
    ) {
        super(`${status}${code ? ` ${code}` : ''}: ${detail}`);
    }

    /** Whether the same request may succeed if sent again later. */
    get retryable(): boolean {
        return this.status === 429 || this.status === 503;
    }
}

/** How many times a request is sent before giving up on 429, 503 or a network error. */
const ATTEMPTS = 3;
/** The longest wait between attempts, whatever Retry-After says. */
const MAX_WAIT_SECS = 30;

/**
 * Slices `request.stl`. Retries what the server says may succeed later, with
 * one Idempotency-Key for every attempt, so a retry is never billed twice.
 */
export async function slice(request: SliceRequest, wait = sleep): Promise<Sliced> {
    const url = new URL('/v1/slices', request.apiUrl);
    url.searchParams.set('filename', request.filename);
    for (const [name, value] of Object.entries(request.settings)) {
        if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const body = await gzipAsync(request.stl);
    const idempotencyKey = randomUUID();
    let last: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            return { ...(await send(url, request.apiKey, body, idempotencyKey)), attempts: attempt };
        } catch (e) {
            last = e;
            const network = !(e instanceof ApiError);
            if (attempt === ATTEMPTS || !(network || e.retryable)) break;
            const after = e instanceof ApiError ? e.retryAfterSecs : undefined;
            await wait(Math.min(after ?? 2 ** attempt, MAX_WAIT_SECS) * 1000);
        }
    }
    throw last;
}

async function send(
    url: URL,
    apiKey: string,
    body: Buffer,
    idempotencyKey: string,
): Promise<Omit<Sliced, 'attempts'>> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'model/stl',
            'Content-Encoding': 'gzip',
            'Idempotency-Key': idempotencyKey,
            'User-Agent': 'melt3d-slicer-mcp',
        },
        // A view fetch's types take: Node's Buffer may sit on a shared buffer.
        body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
    });
    if (!response.ok) throw await apiError(response);
    const remaining = Number(response.headers.get('ratelimit-remaining'));
    return {
        gcode: await response.text(),
        kind: response.headers.get('x-melt-gcode') ?? 'full',
        rateLimitRemaining: Number.isFinite(remaining) && response.headers.has('ratelimit-remaining') ? remaining : undefined,
    };
}

async function apiError(response: Response): Promise<ApiError> {
    const text = await response.text();
    let code = response.headers.get('x-melt-error') ?? undefined;
    let detail = text.trim();
    try {
        const problem = JSON.parse(text) as { code?: string; detail?: string; title?: string };
        code = problem.code ?? code;
        detail = problem.detail || problem.title || detail;
    } catch {
        // Not problem details: a proxy's page, such as Cloudflare's 524.
        if (response.status === 524) detail = 'The slice took longer than the 100 seconds the API waits for an answer.';
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    return new ApiError(
        response.status,
        code,
        detail || response.statusText,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
