import type { BehaviorSubject } from 'rxjs';
import type { Filters, QueryParams, QueryResult } from './query.type';
import type { Document } from './document.type';

export interface WatchParams {
  ref: string;
  limit?: number;
  cursor?: string;
  filters?: Filters;
  allowRemote?: boolean;
  subscriptionId: string;
  direction?: 'next' | 'prev';
}

export interface LiveEvent {
  type: 'add' | 'update' | 'remove';
  doc: Document;
}

export interface Mutation {
  type: 'add' | 'update' | 'remove';
  ref: string;
  document: Document;
}

export interface LivequeryCore {
  watch(params: WatchParams): Promise<BehaviorSubject<LiveEvent>>;

  query<T extends Document = Document>(
    params: QueryParams
  ): Promise<QueryResult<T>>;

  mutate(mutations: Mutation[]): Promise<void>;
}
