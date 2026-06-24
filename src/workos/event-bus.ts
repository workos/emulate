import type { Store } from '../core/index.js';
import { getWorkOSStore } from './store.js';
import type { WorkOSWebhookEndpoint, WorkOSEvent } from './entities.js';
import { signWebhookPayload } from './webhook-signer.js';
import type { WorkOSEventName } from './constants.js';

export interface EventPayload {
  event: WorkOSEventName | string;
  data: Record<string, unknown>;
  environment_id?: string;
}

export interface WebhookRetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface EventBusOptions {
  retryConfig?: WebhookRetryConfig;
  debugMode?: boolean;
}

const DEFAULT_RETRY_CONFIG: WebhookRetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

export class EventBus {
  private endpointsByEvent = new Map<string, Set<string>>();
  private catchAllEndpoints = new Set<string>();
  private deadLetterQueue: Array<{ endpoint: WorkOSWebhookEndpoint; event: WorkOSEvent; error: Error }> = [];
  private retryConfig: WebhookRetryConfig;
  private debugMode: boolean;

  constructor(
    private store: Store,
    options: EventBusOptions = {},
  ) {
    this.retryConfig = options.retryConfig ?? DEFAULT_RETRY_CONFIG;
    this.debugMode = options.debugMode ?? false;
  }

  /** Rebuild the event-type index.  Auto-called via collection hooks; call manually only in tests. */
  rebuildIndex(): void {
    this.endpointsByEvent.clear();
    this.catchAllEndpoints.clear();
    const ws = getWorkOSStore(this.store);
    for (const ep of ws.webhookEndpoints.all()) {
      if (!ep.enabled) continue;
      if (ep.events.length === 0) {
        this.catchAllEndpoints.add(ep.id);
      } else {
        for (const evt of ep.events) {
          const set = this.endpointsByEvent.get(evt) ?? new Set();
          set.add(ep.id);
          this.endpointsByEvent.set(evt, set);
        }
      }
    }
  }

  emit(payload: EventPayload): void {
    const ws = getWorkOSStore(this.store);

    const event = ws.events.insert({
      object: 'event',
      event: payload.event,
      data: payload.data,
      environment_id: payload.environment_id ?? null,
    });

    // Pre-filtered: only endpoints that care about this event
    const targetIds = new Set(this.catchAllEndpoints);
    const eventSpecific = this.endpointsByEvent.get(payload.event);
    if (eventSpecific) {
      for (const id of eventSpecific) targetIds.add(id);
    }

    for (const id of targetIds) {
      const endpoint = ws.webhookEndpoints.get(id);
      if (endpoint) this.deliver(endpoint, event).catch(() => {});
    }
  }

  private async deliver(endpoint: WorkOSWebhookEndpoint, event: WorkOSEvent): Promise<void> {
    const body = JSON.stringify({
      id: event.id,
      event: event.event,
      data: event.data,
      created_at: event.created_at,
    });

    const signature = signWebhookPayload(body, endpoint.secret);

    let lastError: Error | null = null;
    let delay = this.retryConfig.initialDelayMs;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        if (this.debugMode) {
          console.log(
            `[EventBus] Delivering webhook attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1} to ${endpoint.endpoint_url}`,
          );
        }

        const response = await fetch(endpoint.endpoint_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'WorkOS-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (this.debugMode) {
          console.log(`[EventBus] Webhook delivered successfully to ${endpoint.endpoint_url}`);
        }

        return; // Success
      } catch (error) {
        lastError = error as Error;

        if (this.debugMode) {
          console.log(`[EventBus] Webhook delivery failed (attempt ${attempt + 1}):`, error);
        }

        // Don't retry on the last attempt
        if (attempt < this.retryConfig.maxRetries) {
          await this.sleep(delay);
          delay = Math.min(delay * this.retryConfig.backoffMultiplier, this.retryConfig.maxDelayMs);
        }
      }
    }

    // All retries exhausted, add to dead letter queue
    if (this.debugMode) {
      console.log(`[EventBus] Adding webhook to dead letter queue: ${endpoint.endpoint_url}`);
    }

    this.deadLetterQueue.push({
      endpoint,
      event,
      error: lastError || new Error('Unknown error'),
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Get the dead letter queue for inspection/testing */
  getDeadLetterQueue(): Array<{ endpoint: WorkOSWebhookEndpoint; event: WorkOSEvent; error: Error }> {
    return [...this.deadLetterQueue];
  }

  /** Clear the dead letter queue */
  clearDeadLetterQueue(): void {
    this.deadLetterQueue = [];
  }

  /** Retry all webhooks in the dead letter queue */
  async retryDeadLetterQueue(): Promise<{ success: number; failed: number }> {
    const queue = [...this.deadLetterQueue];
    this.deadLetterQueue = [];

    let success = 0;
    let failed = 0;

    for (const item of queue) {
      try {
        await this.deliver(item.endpoint, item.event);
        success++;
      } catch {
        failed++;
        this.deadLetterQueue.push(item); // Put it back if it still fails
      }
    }

    return { success, failed };
  }
}
