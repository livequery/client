import type { Document } from './document.type';

export type Filters = Record<string, unknown>;

export type Direction = 'next' | 'prev';

export interface QueryParams {
  ref: string;
  filters?: Filters;
  allowRemote?: boolean;
  subscriptionId: string;
  limit?: number;
  cursor?: string;
  direction?: Direction;
}

/**
 * Result returned by the query() method
 * @template T - The document data type
 */
export interface QueryResult<T extends Document = Document> {
  /** Array of documents matching the query */
  documents: T[];
  /** Total number of documents matching the filters */
  total: number;
  /** Whether there are more documents available after current page */
  hasNext: boolean;
  /** Whether there are documents available before current page */
  hasPrev: boolean;
}
