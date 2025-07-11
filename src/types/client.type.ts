import type { BehaviorSubject } from 'rxjs';
import type { Document } from './document.type';
import type { LivequeryCore } from './core.type';
import type { Direction, Filters } from './query.type';

/**
 * LiveQuery snapshot structure returned by client
 */
export interface LivequerySnapshot<T extends Document = Document> {
  /**
   * Array of reactive document subjects
   */
  items: BehaviorSubject<T>[];

  /**
   * Count information
   */
  count: {
    total: number;
    next: number;
    prev: number;
  };

  /**
   * Pagination state
   */
  has: {
    next: boolean;
    prev: boolean;
  };
}

export interface LivequeryClientOptions {
  ref: string;
  filters?: Filters;
  core: LivequeryCore;
  allowRemote?: boolean;
  limit?: number;
  cursor?: string;
  direction?: Direction;
}
