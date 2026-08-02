import { logger } from '../Utils/Logger';
import { TrawlError } from '../Utils/Errors';
import type { ScrapeClient, TrawlOptions } from '../types';

// Mirrors FlixPatrol.ts and FlareSolverrClient.ts: same retryable HTTP statuses,
// same attempt budget, same exponential backoff shape (1s, 2s, 4s).
const RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

/** Native /scrape success payload. Only the fields this client reads are modelled. */
interface TrawlScrapeResult {
  url: string;
  html: string;
  statusCode: number;
  tier: number;
  sessionCached: boolean;
  totalMs: number;
}

/** /health payload. `status` is "ok" once at least one browser is live, "starting" before. */
interface TrawlHealth {
  status: string;
  pool?: { live?: number };
}

interface HttpResult {
  httpStatus: number;
  body: unknown;
}

/**
 * TRAWL scraping backend (https://github.com/germondai/trawl).
 *
 * TRAWL also exposes a FlareSolverr-compatible /v1 endpoint, so the obvious move
 * is to point the existing FlareSolverr block at it. That does not work here: the
 * compatibility layer covers `request.get`/`request.post` only, and this project
 * deliberately drives an explicit session (see FlareSolverrClient's header comment).
 * A `sessions.create` is rejected twice over — TRAWL's /v1 validator requires a
 * non-empty `url`, which a session payload has none of, and its command switch
 * answers "Unknown cmd" for anything outside the two request verbs. The run would
 * die on the first call, before any list is processed.
 *
 * So this client targets the native /scrape endpoint instead, which is the better
 * target anyway: it returns the tier that served the request, whether the browser
 * session was reused, and per-tier timings — all logged at debug here.
 *
 * Sessions are not managed from the outside at all. TRAWL keeps its own warm
 * browser pool and caches solved sessions in Redis (`SESSION_TTL_SECONDS`), so the
 * cf_clearance reuse that FlareSolverr needs explicit session commands for happens
 * server-side. `createSession` therefore spends its fail-fast slot on a readiness
 * probe instead, and `destroySession` is a no-op.
 */
export class TrawlClient implements ScrapeClient {
  public readonly name = 'TRAWL';

  private readonly endpoint: string;

  private readonly healthEndpoint: string;

  private readonly maxTimeout: number;

  private readonly maxTier?: 1 | 2 | 3 | 4;

  private readonly skipHttp?: boolean;

  constructor(options: TrawlOptions) {
    if (!options.url) {
      throw new TrawlError('Trawl url must be set when Trawl is enabled');
    }
    this.endpoint = TrawlClient.normalizeEndpoint(options.url);
    this.healthEndpoint = TrawlClient.siblingPath(this.endpoint, 'health');
    this.maxTimeout = options.maxTimeout;
    this.maxTier = options.maxTier;
    this.skipHttp = options.skipHttp;
  }

  /**
   * Resolves the configured URL to the native scrape endpoint.
   *
   * A bare origin is the documented way to configure TRAWL everywhere else (the
   * *arr stack takes `http://trawl:8191`), and `/v1` is what a user coming from the
   * FlareSolverr block will paste out of habit. Both are accepted and pointed at
   * /scrape; any other path is left alone, so a reverse proxy mounted on a prefix
   * still works.
   */
  private static normalizeEndpoint(rawUrl: string): string {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/v1') {
      if (path === '/v1') {
        logger.warn('Trawl.url points at the FlareSolverr-compatible /v1 endpoint, which has no session support; using the native /scrape endpoint instead');
      }
      url.pathname = '/scrape';
    }
    return url.toString();
  }

  /**
   * Swaps the last path segment of the scrape endpoint for a sibling one.
   *
   * `new URL('/health', endpoint)` would be shorter but resolves against the origin,
   * so a TRAWL mounted behind a reverse proxy on /trawl/scrape would be probed at
   * /health — off the prefix, and answered by whatever else lives there.
   */
  private static siblingPath(endpoint: string, segment: string): string {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/[^/]*$/, `/${segment}`);
    return url.toString();
  }

  /**
   * Formats a caught error, appending the underlying `cause` when present. Node's
   * fetch collapses every transport failure — dead container, wrong port, DNS
   * failure, missing `http://` scheme — into a generic `TypeError: fetch failed`;
   * the actionable detail lives in `err.cause`, which is otherwise silently dropped.
   */
  private static formatError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    // `Error.cause` (ES2022) isn't in this project's configured TS lib, so it is
    // read through an explicit shape rather than widening the whole tsconfig target.
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    if (cause === undefined) {
      return message;
    }
    const causeText = cause instanceof Error ? cause.message : String(cause);
    return `${message} (${causeText})`;
  }

  /**
   * Pulls the human-readable reason out of an error body. TRAWL answers with its
   * native `{ error }` shape on validation and scrape failures, but reuses the
   * FlareSolverr `{ status, message }` envelope for pool exhaustion (429), so both
   * have to be read.
   */
  private static errorMessage(body: unknown, httpStatus: number): string {
    if (typeof body === 'object' && body !== null) {
      const record = body as { error?: unknown; message?: unknown };
      if (typeof record.error === 'string' && record.error.length > 0) {
        return record.error;
      }
      if (typeof record.message === 'string' && record.message.length > 0) {
        return record.message;
      }
    }
    return `HTTP ${httpStatus}`;
  }

  private static isScrapeResult(body: unknown): body is TrawlScrapeResult {
    if (typeof body !== 'object' || body === null) {
      return false;
    }
    const record = body as Partial<TrawlScrapeResult>;
    return typeof record.html === 'string' && typeof record.statusCode === 'number';
  }

  /** POSTs a JSON payload and returns the HTTP status alongside the parsed body. */
  private async post(url: string, payload: Record<string, unknown>): Promise<HttpResult> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { httpStatus: res.status, body: await TrawlClient.parseBody(res) };
  }

  /**
   * Reads a JSON body without letting a non-JSON one throw. An error status can be
   * produced by something in front of TRAWL — a reverse proxy 502, an HTML error
   * page — and losing the status code to a JSON parse error would turn a readable
   * "HTTP 502" into an unrelated SyntaxError.
   */
  private static async parseBody(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Waits for the browser pool to be usable, and throws when it is not.
   *
   * TRAWL answers /health with 503 and `status: "starting"` until at least one
   * browser is warm, which takes a few seconds after boot — routine when this app
   * and TRAWL start together under the same compose file. That is retried on the
   * standard backoff rather than failing the run; only a still-cold or unreachable
   * instance after the full budget is fatal.
   */
  public async createSession(): Promise<void> {
    logger.debug(`Checking TRAWL readiness at ${this.healthEndpoint}`);
    let lastReason = 'unknown error';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const res = await fetch(this.healthEndpoint);
        const body = await TrawlClient.parseBody(res) as TrawlHealth | null;
        if (res.status === 200 && body?.status === 'ok') {
          logger.info(`TRAWL ready at ${this.endpoint} (${body.pool?.live ?? 0} browser(s) live)`);
          return;
        }
        lastReason = body?.status === 'starting'
          ? 'browser pool still initializing'
          : TrawlClient.errorMessage(body, res.status);
      } catch (err) {
        lastReason = TrawlClient.formatError(err);
      }

      if (attempt === MAX_RETRIES) {
        break;
      }
      logger.warn(`TRAWL not ready (attempt ${attempt}): ${lastReason}`);
      // Exponential backoff: 1s, 2s
      await new Promise((resolve) => { setTimeout(resolve, 2 ** (attempt - 1) * 1000); });
    }

    throw new TrawlError(`TRAWL is not ready at ${this.healthEndpoint}: ${lastReason}`);
  }

  /**
   * Fetches a URL through TRAWL. Returns null on any failure, matching the contract
   * of FlixPatrol.getFlixPatrolHTMLPage so callers gain no new case.
   *
   * Retries up to MAX_RETRIES times on the same 1s/2s/4s backoff as the other two
   * fetch paths, and is selective in the same way:
   *  - a thrown/transport error is retried;
   *  - a retryable HTTP status from TRAWL itself is retried — this covers 429 (pool
   *    saturated), 503 (pool restarting) and 500 (a tier chain that ended in an
   *    exception), all of which are transient;
   *  - a retryable upstream `statusCode` (what FlixPatrol answered) is retried;
   *  - anything else definitive — 400 from TRAWL's validator, 404/403 from
   *    FlixPatrol — returns null immediately, because retrying would only spend two
   *    more challenge solves on a page that will never work.
   */
  public async get(url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const { httpStatus, body } = await this.post(this.endpoint, {
          url,
          maxTimeout: this.maxTimeout,
          ...(this.maxTier !== undefined ? { maxTier: this.maxTier } : {}),
          ...(this.skipHttp !== undefined ? { skipHttp: this.skipHttp } : {}),
        });

        if (httpStatus !== 200) {
          const reason = TrawlClient.errorMessage(body, httpStatus);
          if (!RETRY_STATUS_CODES.has(httpStatus) || attempt === MAX_RETRIES) {
            logger.error(`TRAWL failed for ${url}: HTTP ${httpStatus} — ${reason}`);
            return null;
          }
          logger.warn(`Retry attempt ${attempt} for ${url}: HTTP ${httpStatus} — ${reason}`);
        } else if (!TrawlClient.isScrapeResult(body)) {
          // A 200 with no usable body: treat as a definitive failure rather than
          // silently returning undefined, which callers can't distinguish from a real
          // empty page and which would flow into JSDOM/downstream parsing.
          logger.error(`TRAWL returned no usable response body for ${url}`);
          return null;
        } else if (body.statusCode !== 200) {
          const retryable = RETRY_STATUS_CODES.has(body.statusCode);
          if (!retryable || attempt === MAX_RETRIES) {
            logger.error(`TRAWL returned HTTP ${body.statusCode} for ${url} (tier ${body.tier})`);
            return null;
          }
          logger.warn(`Retry attempt ${attempt} for ${url}: HTTP ${body.statusCode}`);
        } else {
          logger.debug(`TRAWL fetched ${url} (HTTP ${body.statusCode}, tier ${body.tier}, session ${body.sessionCached ? 'cached' : 'fresh'}, ${body.totalMs}ms)`);
          return body.html;
        }
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          logger.error(`TRAWL request failed for ${url}: ${TrawlClient.formatError(err)}`);
          return null;
        }
        logger.warn(`Retry attempt ${attempt} for ${url}: ${TrawlClient.formatError(err)}`);
      }
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((resolve) => { setTimeout(resolve, 2 ** (attempt - 1) * 1000); });
    }
    return null;
  }

  /**
   * Nothing to release. TRAWL owns its browser pool and expires cached sessions on
   * its own TTL, so there is no per-client resource to hand back — unlike
   * FlareSolverr, where a leaked session keeps a browser resident between runs.
   */
  public async destroySession(): Promise<void> {
    logger.debug('TRAWL manages its own sessions; nothing to destroy');
  }
}
