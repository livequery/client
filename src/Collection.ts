
import { Subject, Subscription, Observable } from 'rxjs'
import { ErrorInfo, QueryOption, QueryStream, Transporter, UpdatedData } from '@livequery/types'
import { get_sort_function } from './helpers/get_sort_function'
import { bufferTime, filter } from 'rxjs/operators'
import { v4 } from 'uuid'

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
  __trigger: (name: string, payload?: any) => any
}

export class CollectionObservable<T extends { id: string }> extends Observable<CollectionStream<T>>{

  #$state = new Subject<CollectionStream<T>>()
  #subscriptions = new Set<Subscription & { reload: Function }>()
  #state: CollectionStream<T>
  #next_cursor: string = null
  private is_collection_ref: boolean
  private collection_ref: string
  private document_id: string
  public readonly $changes = new Subject<UpdatedData<T>>()
  #IdMap = new Map<string, number>()

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
    if (ref.startsWith('/') || ref.endsWith('/')) throw 'INVAILD_REF_FORMAT'
    const refs = ref.split('/')
    this.is_collection_ref = refs.length % 2 == 1
    this.collection_ref = refs.slice(0, refs.length - (this.is_collection_ref ? 0 : 1)).join('/')
    this.document_id = this.is_collection_ref ? null : refs[refs.length - 1]
  }

  private push_item(data: Partial<T>) {
    const item = {
      ...data as T,
      __adding: false,
      __updating: false,
      __removing: false,
      __remove: () => this.remove(data?.id),
      __trigger: (name: string, payload?: any) => this.trigger(name, payload, data?.id),
      __update: (payload: Partial<T>) => this.update({ ...payload, id: data?.id })
    }
    this.#state.items.push(item)
    this.#IdMap.set(item.id, this.#state.items.length - 1)
  }

  private sync(stream: QueryStream<T>[]) {
    for (const { data, error } of stream) {

      // Error & paging
      error && (this.#state.error = error)
      if (data?.paging?.n == 0) {
        this.#state.has_more = data?.paging?.has_more
        this.#next_cursor = data?.paging?.next_cursor
        this.#state.loading = false
      }

      // Sync 
      for (const change of data?.changes || []) {
        const { data: payload, type } = change
        this.$changes.next(change)

        const index = this.#IdMap.get(payload.id) ?? -1
        if (index == -1 && type == 'added') {
          if (
            // Is first value from HTTP query
            data?.paging?.n == 0
            || (
              // Is realtime update that match filters
              Object
                .keys(this.#state.options || {})
                .filter(key => !key.includes('_'))
                .every(key => {
                  try {
                    const [field, expression] = key.split(':')
                    const a = payload[field]
                    const b = this.#state.options?.[field]
                    if (!expression) return a == b
                    if (expression == 'ne') return a != b
                    if (expression == 'lt') return a < b
                    if (expression == 'lte') return a <= b
                    if (expression == 'gt') return a > b
                    if (expression == 'gte') return a >= b
                    if (expression == 'in-array') return a?.includes(b)
                    if (expression == 'contains') return a?.some(e => b?.includes(e))
                    if (expression == 'not-contains') return a?.every(e => !b?.includes(e))
                    if (expression == 'between') return (
                      b[0] <= a && a <= b[1]
                    )
                    if (expression == 'like') return a.includes(b)
                  } catch (e) { }
                  return false
                })
            )
          ) {

            this.push_item(payload)
          }
        }

        if (index >= 0) {
          if (type == 'added' || type == 'modified') {
            this.#state.items[index] = {
              ...this.#state.items[index],
              ...payload,
              __adding: false,
              __updating: false,
              __removing: false
            }
          }
          if (type == 'removed') {
            this.#state.items.splice(index, 1)
            for (const [document_id, i] of this.#IdMap) {
              i == index && this.#IdMap.delete(document_id)
              i > index && this.#IdMap.set(document_id, i - 1)
            }
          }
        }
      }

    }
    this.#$state.next(this.#state)
  }

  private fetch_data(
    options: Partial<QueryOption<T>> = {},
    flush: boolean = false
  ) {

    if (!this.ref) return

    if (flush) {
      this.#subscriptions.forEach(s => s.unsubscribe())
      this.#subscriptions.clear()
    }

    flush && this.#IdMap.clear()

    this.#state = {
      ... this.#state,
      items: flush ? [] : this.#state.items,
      error: null,
      loading: true,
      options
    }

    this.#$state.next(this.#state)

    const query = this.collection_options.transporter.query(this.ref, options)
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
    const options = this.#state?.options
    this.#next_cursor && ((options._cursor as any) = this.#next_cursor)
    this.fetch_data(options)
  }

  public filter(filters: Partial<QueryOption<T>>) {
    this.fetch_data(filters, true)
  }

  public async add(payload: T) {
    return await this.collection_options.transporter.add(`${this.collection_ref}`, payload as any) as T
  }

  public async remove(remove_document_id?: string) {
    const id = remove_document_id || this.document_id
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
    const ref = `${this.collection_ref}${id ? `/${id}` : ''}`
    await this.collection_options.transporter.remove(ref)
  }

  public async update({ id: update_payload_id, ...payload }: Partial<T & { id: string }>) {
    const id = update_payload_id || this.document_id
    // Trigger local update
    this.sync([{
      data: {
        changes: [{
          data: { ...payload, id, __updating: true } as any,
          ref: this.ref,
          type: 'modified'
        }]
      }
    }])
    const ref = `${this.collection_ref}${id ? `/${id}` : ''}`
    return await this.collection_options.transporter.update(ref, payload as any) as T

  }

  public async trigger<T>(name: string, payload?: object, trigger_document_id?: string) {
    const id = trigger_document_id || this.document_id
    const ref = `${this.collection_ref}${id ? `/${id}` : ''}`
    return await this.collection_options.transporter.trigger(ref, name, {}, payload as any) as T
  }
}

