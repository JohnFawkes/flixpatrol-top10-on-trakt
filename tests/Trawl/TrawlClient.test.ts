import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { TrawlClient } from '../../src/Trawl/TrawlClient';
import { TrawlError } from '../../src/Utils/Errors';
import { logger } from '../../src/Utils/Logger';

const BASE_URL = 'http://localhost:8191';
const SCRAPE_ENDPOINT = 'http://localhost:8191/scrape';
const HEALTH_ENDPOINT = 'http://localhost:8191/health';

// TRAWL replies are plain HTTP responses, not envelopes: the status code carries
// as much meaning as the body, so the mock has to model both.
const response = (status: number, body: unknown) => ({ status, json: async () => body });

const healthy = { status: 'ok', uptime: 12, pool: { live: 3 } };
const starting = { status: 'starting', uptime: 1, pool: { live: 0 } };

const scrapeResult = (html: string, overrides: Record<string, unknown> = {}) => ({
  url: 'https://flixpatrol.com/x',
  html,
  cookies: [],
  userAgent: 'Mozilla/5.0',
  statusCode: 200,
  tier: 2,
  sessionCached: true,
  timings: [],
  totalMs: 1340,
  ...overrides,
});

// Read the JSON payload the client POSTed on a given call index.
const payloadOf = (fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> =>
  JSON.parse(fetchMock.mock.calls[call][1].body as string);

// Drives a call that is expected to hit the retry backoff at least once. Fake timers
// keep the 1s/2s/4s sleeps out of the test run; advancing by a generous window
// flushes any pending retries regardless of how many attempts the scenario needs.
const runWithBackoff = async <T>(promise: Promise<T>): Promise<T> => {
  await vi.advanceTimersByTimeAsync(10000);
  return promise;
};

// Same, for a call that is expected to reject. The assertion is attached before the
// timers advance: awaiting the advance first would leave the pending rejection
// momentarily unhandled, which vitest reports as an unhandled error.
const expectRejection = async (promise: Promise<unknown>, matcher: RegExp | (new (...args: never[]) => Error)) => {
  const assertion = expect(promise).rejects.toThrow(matcher as RegExp);
  await vi.advanceTimersByTimeAsync(10000);
  await assertion;
};

describe('TrawlClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TrawlClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new TrawlClient({ enabled: true, url: BASE_URL, maxTimeout: 60000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('endpoint resolution', () => {
    it('appends /scrape to a bare origin', async () => {
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));

      await client.get('https://flixpatrol.com/a');

      expect(fetchMock.mock.calls[0][0]).toBe(SCRAPE_ENDPOINT);
    });

    it('tolerates a trailing slash', async () => {
      const withSlash = new TrawlClient({ enabled: true, url: `${BASE_URL}/`, maxTimeout: 60000 });
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));

      await withSlash.get('https://flixpatrol.com/a');

      expect(fetchMock.mock.calls[0][0]).toBe(SCRAPE_ENDPOINT);
    });

    it('rewrites the FlareSolverr-compatible /v1 path to the native /scrape endpoint', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

      const viaV1 = new TrawlClient({ enabled: true, url: `${BASE_URL}/v1`, maxTimeout: 60000 });
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));
      await viaV1.get('https://flixpatrol.com/a');

      expect(fetchMock.mock.calls[0][0]).toBe(SCRAPE_ENDPOINT);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('/scrape');
    });

    it('leaves a reverse-proxy path prefix untouched', async () => {
      const prefixed = new TrawlClient({
        enabled: true, url: 'https://example.com/trawl/scrape', maxTimeout: 60000,
      });
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));

      await prefixed.get('https://flixpatrol.com/a');

      expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/trawl/scrape');
    });

    it('keeps the health probe on the same path prefix as the scrape endpoint', async () => {
      // Resolving /health against the origin would probe off the prefix entirely,
      // and be answered by whatever else is mounted at the root of that host.
      const prefixed = new TrawlClient({
        enabled: true, url: 'https://example.com/trawl/scrape', maxTimeout: 60000,
      });
      fetchMock.mockResolvedValue(response(200, healthy));

      await prefixed.createSession();

      expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/trawl/health');
    });

    it('throws TrawlError when constructed without a url', () => {
      expect(() => new TrawlClient({ enabled: true, maxTimeout: 60000 })).toThrow(TrawlError);
    });
  });

  describe('createSession', () => {
    it('probes /health and resolves once the pool is live', async () => {
      fetchMock.mockResolvedValue(response(200, healthy));

      await client.createSession();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(HEALTH_ENDPOINT);
    });

    it('does not issue any session command — TRAWL has none', async () => {
      fetchMock.mockResolvedValue(response(200, healthy));

      await client.createSession();

      // A bare GET: no POST body, so nothing resembling sessions.create went out.
      expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    });

    it('waits out a pool that is still warming up', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(response(503, starting));
      fetchMock.mockResolvedValueOnce(response(200, healthy));

      await runWithBackoff(client.createSession());

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws TrawlError when the pool never becomes ready', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(response(503, starting));

      await expectRejection(client.createSession(), /browser pool still initializing/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws TrawlError when the service is unreachable', async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expectRejection(client.createSession(), TrawlError);
    });

    it('includes the underlying fetch failure cause in the thrown message', async () => {
      // Node's fetch collapses every transport failure into "TypeError: fetch failed"
      // and puts the actionable reason in .cause. Without surfacing it, a dead
      // container, a wrong port, and a DNS failure would all look identical.
      vi.useFakeTimers();
      const transportError = new TypeError('fetch failed');
      (transportError as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 127.0.0.1:8191');
      fetchMock.mockRejectedValue(transportError);

      await expectRejection(client.createSession(), /connect ECONNREFUSED 127\.0\.0\.1:8191/);
    });
  });

  describe('get', () => {
    it('posts the url and maxTimeout, and returns the html', async () => {
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html>hi</html>')));

      const html = await client.get('https://flixpatrol.com/top10/netflix/france');

      expect(html).toBe('<html>hi</html>');
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      expect(payloadOf(fetchMock, 0)).toEqual({
        url: 'https://flixpatrol.com/top10/netflix/france',
        maxTimeout: 60000,
      });
    });

    it('forwards a custom maxTimeout from config', async () => {
      const custom = new TrawlClient({ enabled: true, url: BASE_URL, maxTimeout: 90000 });
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));

      await custom.get('https://flixpatrol.com/a');

      expect(payloadOf(fetchMock, 0).maxTimeout).toBe(90000);
    });

    it('forwards maxTier and skipHttp only when configured', async () => {
      const tuned = new TrawlClient({
        enabled: true, url: BASE_URL, maxTimeout: 60000, maxTier: 3, skipHttp: true,
      });
      fetchMock.mockResolvedValue(response(200, scrapeResult('<html></html>')));

      await tuned.get('https://flixpatrol.com/a');

      expect(payloadOf(fetchMock, 0)).toEqual({
        url: 'https://flixpatrol.com/a',
        maxTimeout: 60000,
        maxTier: 3,
        skipHttp: true,
      });
    });

    it('returns null immediately on a non-retryable upstream status, without a second attempt', async () => {
      fetchMock.mockResolvedValue(response(200, scrapeResult('', { statusCode: 404 })));

      const html = await client.get('https://flixpatrol.com/a');

      expect(html).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries a retryable upstream status and succeeds on a later attempt', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValueOnce(response(200, scrapeResult('', { statusCode: 503 })));
      fetchMock.mockResolvedValueOnce(response(200, scrapeResult('<html>recovered</html>')));

      const html = await runWithBackoff(client.get('https://flixpatrol.com/a'));

      expect(html).toBe('<html>recovered</html>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a saturated browser pool (429) and returns null after exhausting attempts', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      // Pool exhaustion is the one path where TRAWL answers with a FlareSolverr-shaped
      // envelope rather than its native { error } body.
      fetchMock.mockResolvedValue(response(429, {
        status: 'error', message: 'Browser pool saturated, retry shortly', solution: {},
      }));

      const html = await runWithBackoff(client.get('https://flixpatrol.com/a'));

      expect(html).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Browser pool saturated');
    });

    it('returns null immediately on a validation error, without a second attempt', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      fetchMock.mockResolvedValue(response(400, { error: 'url must be a non-empty string' }));

      const html = await client.get('https://flixpatrol.com/a');

      expect(html).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('url must be a non-empty string');
    });

    it('returns null when a 200 carries no usable body', async () => {
      // An ok/200 with no html: a definitive failure rather than a silent undefined,
      // which callers could not tell apart from a real empty page.
      fetchMock.mockResolvedValue(response(200, { tier: 1 }));

      await expect(client.get('https://flixpatrol.com/a')).resolves.toBeNull();
    });

    it('survives a non-JSON error body and still reports the status', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      fetchMock.mockResolvedValue({
        status: 502,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      });

      const html = await runWithBackoff(client.get('https://flixpatrol.com/a'));

      expect(html).toBeNull();
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('HTTP 502');
    });

    it('retries after a transport failure and succeeds on the second attempt', async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      fetchMock.mockResolvedValueOnce(response(200, scrapeResult('<html>recovered</html>')));

      const html = await runWithBackoff(client.get('https://flixpatrol.com/a'));

      expect(html).toBe('<html>recovered</html>');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns null after exhausting all retries on repeated network errors', async () => {
      vi.useFakeTimers();
      fetchMock.mockRejectedValue(new Error('socket hang up'));

      const html = await runWithBackoff(client.get('https://flixpatrol.com/a'));

      expect(html).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('destroySession', () => {
    it('is a no-op: TRAWL owns its own session lifetime', async () => {
      fetchMock.mockResolvedValue(response(200, healthy));
      await client.createSession();
      fetchMock.mockClear();

      await expect(client.destroySession()).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
