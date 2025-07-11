import { BehaviorSubject, Subscription } from 'rxjs';
import type { Document } from './types/document.type';
import { generateSubscriptionId } from './utils';
import type {
  LivequeryClientOptions,
  LivequerySnapshot,
} from './types/client.type';
import type { LiveEvent, LivequeryCore, Mutation } from './types/core.type';
import type { Direction, Filters } from './types/query.type';
import { LivequeryError, QueryError, WatchError } from './errors';
import { MutateError } from './errors';

export class LivequeryClient<T extends Document = Document>
  extends BehaviorSubject<LivequerySnapshot<T>>
  implements Disposable
{
  #isDisposed = false;
  #subscription: Subscription | null = null;

  readonly #subscriptionId: string;
  readonly #options: LivequeryClientOptions;

  get subscriptionId(): string {
    return this.#subscriptionId;
  }

  get allowRemote(): boolean {
    return this.#options.allowRemote ?? true;
  }

  get core(): LivequeryCore {
    return this.#options.core;
  }

  get ref(): string {
    return this.#options.ref;
  }

  get filters(): Filters | undefined {
    return this.#options.filters;
  }

  get limit(): number {
    return this.#options.limit ?? 10;
  }

  get cursor(): string | undefined {
    return this.#options.cursor;
  }

  get direction(): Direction {
    return this.#options.direction ?? 'next';
  }

  constructor(options: LivequeryClientOptions) {
    const initialSnapshot: LivequerySnapshot<T> = {
      items: [],
      count: { total: 0, next: 0, prev: 0 },
      has: { next: false, prev: false },
    };

    super(initialSnapshot);

    this.#options = options;
    this.#subscriptionId = generateSubscriptionId();

    this.#setupWatch().catch((error: unknown) => {
      throw new WatchError(
        error instanceof Error ? error.message : 'Failed to setup watch'
      );
    });
  }

  async #setupWatch(): Promise<void> {
    try {
      const watchStream = await this.core.watch({
        ref: this.ref,
        filters: this.filters,
        allowRemote: this.allowRemote,
        subscriptionId: this.subscriptionId,
      });

      this.#subscription = watchStream.subscribe({
        next: event => {
          void this.#handleLiveEvent(event);
        },
        error: (error: unknown) => {
          throw new WatchError(
            error instanceof Error ? error.message : 'Failed to watch'
          );
        },
      });
    } catch (error) {
      throw new WatchError(
        error instanceof Error ? error.message : 'Failed to watch'
      );
    }
  }

  async #handleLiveEvent(_event: LiveEvent): Promise<void> {
    await this.#performQuery().catch((error: unknown) => {
      throw new QueryError(
        error instanceof Error ? error.message : 'Failed to perform query'
      );
    });
  }

  async #performQuery(): Promise<void> {
    try {
      const result = await this.core.query<T>({
        ref: this.ref,
        filters: this.filters,
        allowRemote: this.allowRemote,
        subscriptionId: this.subscriptionId,
        limit: this.limit,
        cursor: this.cursor,
        direction: this.direction,
      });

      const items = result.documents.map(doc => new BehaviorSubject<T>(doc));

      const snapshot: LivequerySnapshot<T> = {
        items,
        count: {
          total: result.total,
          next: result.hasNext ? 1 : 0,
          prev: result.hasPrev ? 1 : 0,
        },
        has: {
          next: result.hasNext,
          prev: result.hasPrev,
        },
      };

      this.next(snapshot);
    } catch (error) {
      throw new QueryError(
        error instanceof Error ? error.message : 'Failed to load next'
      );
    }
  }

  async loadNext(): Promise<void> {
    try {
      this.#ensureNotDisposed();

      const currentSnapshot = this.value;
      if (!currentSnapshot.has.next) {
        return;
      }

      const lastItem = currentSnapshot.items[currentSnapshot.items.length - 1];
      if (!lastItem) {
        return;
      }

      this.#options.cursor = lastItem.value._id;
      this.#options.direction = 'next';
      await this.#performQuery();
    } catch (error) {
      throw new QueryError(
        error instanceof Error ? error.message : 'Failed to load prev'
      );
    }
  }

  async loadPrev(): Promise<void> {
    try {
      this.#ensureNotDisposed();

      const currentSnapshot = this.value;
      if (!currentSnapshot.has.prev) {
        return;
      }

      const firstItem = currentSnapshot.items[0];
      if (!firstItem) {
        return;
      }

      this.#options.cursor = firstItem.value._id;
      this.#options.direction = 'prev';
      await this.#performQuery();
    } catch (error) {
      throw new QueryError(
        error instanceof Error ? error.message : 'Failed to load prev'
      );
    }
  }

  async requery(): Promise<void> {
    try {
      this.#options.cursor = undefined;
      this.#options.direction = 'next';
      await this.#performQuery();
    } catch (error) {
      throw new MutateError(
        error instanceof Error ? error.message : 'Failed to requery'
      );
    }
  }

  async add(...docs: T[]): Promise<void> {
    try {
      this.#ensureNotDisposed();

      const mutations: Mutation[] = docs.map(doc => ({
        type: 'add',
        ref: this.ref,
        document: doc,
      }));

      await this.core.mutate(mutations);
    } catch (error) {
      throw new MutateError(
        error instanceof Error ? error.message : 'Failed to add'
      );
    }
  }

  async update(...docs: (Partial<T> & Pick<T, '_id'>)[]): Promise<void> {
    try {
      this.#ensureNotDisposed();

      const mutations: Mutation[] = docs.map(doc => ({
        type: 'update',
        ref: this.ref,
        document: doc,
      }));

      await this.core.mutate(mutations);
    } catch (error) {
      throw new MutateError(
        error instanceof Error ? error.message : 'Failed to update'
      );
    }
  }

  async remove(...docs: Pick<T, '_id'>[]): Promise<void> {
    try {
      this.#ensureNotDisposed();

      const mutations: Mutation[] = docs.map(doc => ({
        type: 'remove',
        ref: this.ref,
        document: doc,
      }));

      await this.core.mutate(mutations);
    } catch (error) {
      throw new MutateError(
        error instanceof Error ? error.message : 'Failed to remove'
      );
    }
  }

  [Symbol.dispose](): void {
    if (this.#isDisposed) {
      return;
    }

    if (this.#subscription) {
      this.#subscription.unsubscribe();
    }

    this.#isDisposed = true;

    this.complete();
  }

  #ensureNotDisposed(): void {
    if (this.#isDisposed) {
      throw new LivequeryError('LivequeryClient has been disposed');
    }
  }
}
