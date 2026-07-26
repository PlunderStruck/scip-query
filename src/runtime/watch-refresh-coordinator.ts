import type { WatcherStatus } from '../domain/types.js';
import {
  claimWatchRefreshRequests,
  completeWatchRefreshClaim,
  enqueueWatchRefreshRequest,
  inspectWatchRefreshRequests,
  pruneWatchRefreshHistory,
  recoverWatchRefreshClaims,
  releaseWatchRefreshClaim,
  type WatchRefreshClaimBatch,
  type WatchRefreshRequestStatus,
} from '../storage/watch-refresh-requests.js';

export interface WatchRefreshCoordinatorOptions {
  now?: () => number;
  randomId?: () => string;
  retryDelayMs?: number;
}

/**
 * Couples durable request claims to the one reindex attempt that consumes
 * them. It owns no timer: the watch loop calls poll, completion, and failure at
 * the corresponding state-machine moments.
 */
export class WatchRefreshCoordinator {
  private readonly root: string;
  private readonly now: () => number;
  private readonly randomId?: () => string;
  private readonly retryDelayMs: number;
  private active: WatchRefreshClaimBatch | undefined;
  private retryNotBeforeMs = 0;
  private currentStatus: WatchRefreshRequestStatus;

  constructor(root: string, options: WatchRefreshCoordinatorOptions = {}) {
    this.root = root;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId;
    this.retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 1_000));
    this.currentStatus = inspectWatchRefreshRequests(root);
  }

  initializeAfterOwnershipAcquired(): { recoveredClaims: number; prunedHistory: number } {
    const recoveredClaims = recoverWatchRefreshClaims(this.root);
    const prunedHistory = pruneWatchRefreshHistory(this.root, { now: () => new Date(this.now()) });
    this.refreshStatus();
    return { recoveredClaims, prunedHistory };
  }

  observeLegacyRequest(requestedAtMs: number, detail?: string): void {
    enqueueWatchRefreshRequest(this.root, detail ?? 'stale index observed by a legacy command', {
      idempotencyKey: `legacy-activity:${requestedAtMs}`,
      now: () => new Date(requestedAtMs),
    });
    this.refreshStatus();
  }

  poll(watcher: WatcherStatus, requestRefresh: (detail: string) => void): boolean {
    if (this.active || watcher.state !== 'idle' || this.now() < this.retryNotBeforeMs) return false;
    const claimed = claimWatchRefreshRequests(this.root, {
      now: () => new Date(this.now()),
      ...(this.randomId ? { randomId: this.randomId } : {}),
    });
    this.refreshStatus();
    if (claimed.requests.length === 0) return false;
    this.active = claimed;
    try {
      requestRefresh(refreshClaimDetail(claimed));
      return true;
    } catch (error) {
      releaseWatchRefreshClaim(this.root, claimed);
      this.active = undefined;
      this.retryNotBeforeMs = this.now() + this.retryDelayMs;
      this.refreshStatus();
      throw error;
    }
  }

  completeActive(): boolean {
    if (!this.active) return false;
    completeWatchRefreshClaim(this.root, this.active, () => new Date(this.now()));
    this.active = undefined;
    this.retryNotBeforeMs = 0;
    this.refreshStatus();
    return true;
  }

  failActive(): boolean {
    if (!this.active) return false;
    releaseWatchRefreshClaim(this.root, this.active);
    this.active = undefined;
    this.retryNotBeforeMs = this.now() + this.retryDelayMs;
    this.refreshStatus();
    return true;
  }

  status(): WatchRefreshRequestStatus {
    return { ...this.currentStatus };
  }

  private refreshStatus(): void {
    this.currentStatus = inspectWatchRefreshRequests(this.root);
  }
}

function refreshClaimDetail(claim: WatchRefreshClaimBatch): string {
  if (claim.requests.length === 1) return claim.requests[0]!.detail;
  const details = [...new Set(claim.requests.map((request) => request.detail))];
  const summary = details.slice(0, 3).join('; ');
  return `${claim.requests.length} coalesced refresh requests${summary ? `: ${summary}` : ''}`.slice(0, 2_048);
}
