
import { Subject, Subscription, Observable } from 'rxjs'
import { ErrorInfo, QueryOption, QueryStream, Transporter } from '@livequery/types'
import { get_sort_function } from './helpers/get_sort_function'
import { bufferTime, tap, filter } from 'rxjs/operators'


export type CollectionOption<T = any> = {
  transporter: Transporter,
  sync_delay?: number
  filters?: Partial<QueryOption<T>>
}




type CollectionStream<T> = {
  items: T[],
  error?: ErrorInfo,
  has_more: boolean
  loading?: boolean,
  options: Partial<QueryOption<T>>
}

export class CollectionObservable<T extends { id: string }> extends Observable<CollectionStream<T>>{

  #$state = new Subject<CollectionStream<T>>()
  #subscriptions = new Set<Subscription>()
  #state: CollectionStream<T>
  #next_cursor: string = null
  private static last_query_id = 0

  constructor(private ref: string, private collection_options: CollectionOption<T>) {
    super(o => {
      this.#state = { items: [], options: collection_options.filters, has_more: false }
      const subscription = this.#$state.subscribe(o)
      return () => {
        this.#subscriptions.forEach(s => s.unsubscribe())
        subscription.unsubscribe()
      }
    }) 
  }

  private sync(stream: QueryStream<T>[]) {

    const changes = stream.map(s => s.data.changes).flat()

    for (const { data: payload, type } of changes) {

      const index = this.#state.items.findIndex(item => item.id == payload.id) 

      if (index == -1 && type == 'added' && Object.keys(this.#state.options?.filters || {}).length == 0) {
        this.#state.items.push(payload as T)
      }

      if (index >= 0) {
        if (type == 'added' || type == 'modified') {
          this.#state.items[index] = { ...this.#state.items[index], ...payload }
        }
        if (type == 'removed') {
          this.#state.items.splice(index, 1)
        }
      }
    }

    // Process paging & error 
    const { error, data: { paging } } = stream[0]
    error && (this.#state.error = error)
    if (paging?.n == 0) {
      this.#state.has_more = paging.has_more
      this.#next_cursor = paging.next_cursor
      this.#state.loading = false
    }
    const sort_function = get_sort_function(this.#state.items[0], this.#state.options._order_by as string || 'created_at', this.#state.options._sort || 'desc')
    this.#state.items = this.#state.items.sort(sort_function)
    this.#$state.next(this.#state)
  }

  private fetch_data(
    options: Partial<QueryOption<T>> = {},
    flush: boolean = false
  ) {

    if (!this.ref || this.#state.loading) return

    this.#state = {
      ... this.#state,
      items: flush ? [] : this.#state.items,
      error: null,
      loading: true,
      options
    }

    this.#$state.next(this.#state)

    this.#subscriptions.add(
      this.collection_options.transporter
        .query(CollectionObservable.last_query_id++, this.ref, options)
        .pipe(
          bufferTime(this.collection_options.sync_delay || 500),
          filter(stream => stream.length > 0) 
        )
        .subscribe(data => this.sync(data))
    )
  }

  public reload() {
    this.fetch_data(this.#state.options, true)
  }

  public reset() {
    this.fetch_data({}, true)
  }

  public fetch_more() {
    this.fetch_data({ ...this.#state?.options, _cursor: this.#next_cursor })
  }

  public filter(filters: Partial<QueryOption<T>>) {
    this.fetch_data(filters, true)
  }

}

