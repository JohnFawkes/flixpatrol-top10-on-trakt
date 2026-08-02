/**
 * Common contract for the optional anti-bot scraping backends (FlareSolverr, TRAWL).
 *
 * `FlixPatrol` and the pipeline only ever see this interface, so a third backend
 * costs one new class and no changes to either.
 *
 * The session pair is part of the contract even though not every backend needs it.
 * FlareSolverr requires an explicit `sessions.create`/`sessions.destroy` to keep a
 * warm cf_clearance cookie between requests; TRAWL caches sessions internally
 * (Redis, `SESSION_TTL_SECONDS`) and has no session commands at all, so it spends
 * the create hook on a readiness probe and the destroy hook on nothing.
 */
export interface ScrapeClient {
  /** Backend name, used in log lines so a run says which one served it. */
  readonly name: string;

  /**
   * Prepares the backend for a run. Throws when the backend is unusable: this runs
   * before any list is processed, so an unreachable container fails the run
   * immediately rather than midway through.
   */
  createSession(): Promise<void>;

  /** Fetches a URL. Returns null on any failure — never throws. */
  get(url: string): Promise<string | null>;

  /** Releases whatever `createSession` acquired. Never throws. */
  destroySession(): Promise<void>;
}
