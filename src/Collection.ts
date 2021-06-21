
import { Subject, Subscription, Observable, interval, from } from 'rxjs'
import { ErrorInfo, QueryOption, QueryStream, Transporter, UpdatedData } from '@livequery/types'
import { get_sort_function } from './helpers/get_sort_function'
import { bufferTime, tap, filter } from 'rxjs/operators'


export type CollectionOption<T = any> = {
  transporter: Transporter,
  sync_delay?: number
  filters?: Partial<QueryOption<T>>
  reload_interval?: number
}


type CollectionStream<T> = {
  items: SmartQueryItem<T>[],
  error?: ErrorInfo,
  has_more: boolean
  loading?: boolean,
  options: Partial<QueryOption<T>>
}

export type SmartQueryItem<T> = T & {
  __removing: boolean
  __updating: boolean
  __adding: boolean
  __remove: Function
  __update: (data: Partial<T>) => any
  __trigger: (name: string, payload: any) => any
}

export class CollectionObservable<T extends { id: string }> extends Observable<CollectionStream<T>>{

  #$state = new Subject<CollectionStream<T>>()
  #subscriptions = new Set<Subscription & { reload: Function }>()
  #state: CollectionStream<T>
  #next_cursor: string = null
  private static last_query_id = 0

  constructor(private ref: string, private collection_options: CollectionOption<T>) {
    super(o => {

      this.#state = { items: [], options: collection_options.filters, has_more: false }
      const subscription = this.#$state.subscribe(o)

      const auto_reload_interval = collection_options.reload_interval && setInterval(
        () => this.reload(),
        collection_options.reload_interval
      )

      return () => {
        this.#subscriptions.forEach(s => s.unsubscribe())
        subscription.unsubscribe()
        clearInterval(auto_reload_interval)
      }
    })


  }

  private push_item(data: Partial<T>) {
    const { id } = data
    const item = {
      ...data as T,
      __adding: false,
      __updating: true,
      __removing: false,
      __remove: () => this.remove(id),
      __trigger: (name: string, payload?: any) => this.trigger(name, id, payload),
      __update: (payload: Partial<T>) => this.update({ id, ...payload })
    }
    this.#state.items.push(item)
  }

  private sync(stream: QueryStream<T>[]) {

    const changes = stream.map(s => s.data.changes).flat()

    for (const { data: payload, type } of changes) {

      const index = this.#state.items.findIndex(item => item.id == payload.id)

      if (index == -1 && type == 'added' && Object.keys(this.#state.options?.filters || {}).length == 0) {
        this.push_item(payload)
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
    flush && this.#subscriptions.forEach(s => s.unsubscribe())

    this.#state = {
      ... this.#state,
      items: flush ? [] : this.#state.items,
      error: null,
      loading: true,
      options
    }

    this.#$state.next(this.#state)

    const query = this.collection_options.transporter.query(CollectionObservable.last_query_id++, this.ref, options)
    const sub = Object.assign(
      query
        .pipe(
          bufferTime(this.collection_options.sync_delay || 500),
          filter(stream => stream.length > 0)
        )
        .subscribe(data => this.sync(data)),
      { reload: query.reload }
    )

    this.#subscriptions.add(sub)
  }

  public reload() {
    this.#subscriptions.forEach(s => s.reload())
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


  public async add(payload: T) {
    await this.collection_options.transporter.update(`${this.ref}`, payload as any)
  }

  public async remove(id: string) {

    this.sync([{
      data: {
        changes: [{
          data: { id, __removing: true } as any,
          ref: this.ref,
          type: 'modified'
        }]
      }
    }])

    // Trigger  
    await this.collection_options.transporter.remove(`${this.ref}/${id}`)
  }

  public async update({ id, ...payload }: { id: string } & Partial<T>) {

    // Trigger local update
    this.sync([{
      data: {
        changes: [{
          data: { id, __updating: true, ...payload } as any,
          ref: this.ref,
          type: 'modified'
        }]
      }
    }])

    // Trigger remote 
    await this.collection_options.transporter.update(`${this.ref}/${id}`, payload as any)

    this.sync([{
      data: {
        changes: [{
          data: { id, __updating: false } as any,
          ref: this.ref,
          type: 'modified'
        }]
      }
    }])

  }

  public async trigger(name: string, document_id: string | null, payload?: object) {
    // Trigger remote
    await this.collection_options.transporter.trigger(document_id ? `${this.ref}/${document_id}` : this.ref, name, {}, payload as any)
  }
}

