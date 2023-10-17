
import { Subject, Subscription, Observable, merge, ReplaySubject } from 'rxjs'
import { ErrorInfo, LivequeryBaseEntity, QueryOption, QueryStream, Transporter, UpdatedData } from '@livequery/types'
import { bufferTime, filter, map } from 'rxjs/operators'

export type CollectionOption<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
  transporter: Transporter,
  sync_delay?: number
  filters?: Partial<QueryOption<T>>
  reload_interval?: number
  realtime?: boolean
}

export type SmartQueryItem<T> = T & {
  __removing: boolean
  __updating: boolean
  __adding: boolean
  __remove: Function
  __update: (data: Partial<T>) => any
  __trigger: (name: string, payload?: any) => any
  __ref: string
}

type CollectionStream<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
  items: SmartQueryItem<T>[],
  error?: ErrorInfo,
  has_more: boolean
  loading?: boolean,
  options: Partial<QueryOption<T>>
}


export class CollectionObservable<T extends LivequeryBaseEntity = LivequeryBaseEntity> extends Observable<CollectionStream<T>>{


  public readonly $changes = new Subject<UpdatedData<T>>()


  #queries = new Set<Subscription & { reload: Function }>()
  #next_cursor: { [ref: string]: string } = {}
  #IdMap = new Map<string, number>()
  #refs: string[] = []


  value: CollectionStream<T> = {
    has_more: false,
    items: [] as SmartQueryItem<T>[],
    options: {},
    loading: false
  }
  $ = new ReplaySubject<CollectionStream<T>>(1)

  constructor(private ref: string | false | null | '' | undefined, private collection_options: CollectionOption<T>) {
    super(o => {
      const subscription = this.$.subscribe(o)
      const auto_reload_interval = collection_options.reload_interval && setInterval(
        () => this.reload(),
        collection_options.reload_interval
      )
      return () => {
        subscription.unsubscribe()
        this.#queries.forEach(s => s.unsubscribe())
        clearInterval(auto_reload_interval)
      }
    })
    this.collection_options.filters = this.collection_options.filters || {} 
    if (collection_options.filters) this.value.options = collection_options.filters
    if (ref && (ref.startsWith('/') || ref.endsWith('/'))) throw 'INVAILD_REF_FORMAT'
    this.#refs = this.#ref_parser(ref)
  }

  #ref_parser(path: string | false | null | '' | undefined) {
    if (!path) return []
    const refs_builder = (paths: string[][]): string[][] => {
      const [a, b, ...c] = paths
      if (!b) return paths
      const r = a.map(aa => b.map(bb => `${aa}/${bb}`)).flat(2)
      const d = [r, ...c]
      return refs_builder(d)
    }
    return path.split(',').map(f => refs_builder(f.trim().split('/').map(l => l.split('|')))).flat(2)
  }

  set_realtime(realtime: boolean) {
    this.collection_options.realtime = realtime
  }

  #sync(stream: Array<QueryStream<T> & { ref: string }>, from_local: boolean = false) {
    const realtime = this.collection_options.realtime ?? true
    const actions = { update: false, reindex: false }
    for (const { data, error, ref } of stream) {

      // Error & paging
      if (error) {
        this.value.error = error
        actions.update = true
      }


      if (data?.paging?.n == 0) {
        this.#next_cursor[ref] = data?.paging?.next_cursor
        this.value.has_more = Object.values(this.#next_cursor).some(v => v && v != '#')
        this.value.loading = false
        actions.update = true
      }

      // Sync 
      for (const change of data?.changes || []) {

        if (!change?.data?.id) continue
        const { data: payload, type } = change
        this.$changes.next(change)
        const index = this.#IdMap.get(payload.id) ?? -1

        if (index == -1 && type == 'added') {
          if (
            // Is first value from HTTP query
            data?.paging?.n == 0
            || (
              // Is realtime update that match filters
              (realtime || from_local) && Object
                .keys(this.value.options || {})
                .filter(key => !key.includes('_'))
                .every(key => {
                  try {
                    const [field, expression] = key.split(':')
                    const a = payload[field as keyof typeof payload]
                    const b = this.value.options?.[field as keyof QueryOption<T>]
                    if (!expression) return a == b
                    if (expression == 'ne') return a != b
                    if (expression == 'lt') return typeof a == 'number' && typeof b == 'number' && a < b
                    if (expression == 'lte') return typeof a == 'number' && typeof b == 'number' && a <= b
                    if (expression == 'gt') return typeof a == 'number' && typeof b == 'number' && a > b
                    if (expression == 'gte') return typeof a == 'number' && typeof b == 'number' && a >= b
                    if (expression == 'in' || expression == 'like') return Array.isArray(a) && a?.includes(b)
                    if (expression == 'between') return (
                      b[0] <= a && a <= b[1]
                    )
                  } catch (e) { }
                  return false
                })
            )
          ) {

            this.value.items.push({
              ...payload as T,
              __adding: false,
              __updating: false,
              __removing: false,
              __remove: () => this.remove(payload?.id),
              __trigger: (name: string, input?: any) => this.trigger(name, input, payload?.id),
              __update: (input: Partial<T>) => this.update({ ...input, id: payload?.id }),
              __ref: change.ref
            })

            actions.reindex = true
            actions.update = true
          }
        }

        if (index >= 0 && (realtime || from_local)) {

          if (type == 'added' || type == 'modified') {
            actions.update = true
            if (Object.keys(payload).some(key => ['created_at', this.collection_options?.filters?._order_by].includes(key))) {
              actions.reindex = true
            }
            this.value.items[index] = {
              ...this.value.items[index],
              __adding: false,
              __updating: false,
              __removing: false,
              ...payload
            }
          }


          if (type == 'removed') {
            actions.reindex = true
            actions.update = true
            this.value.items.splice(index, 1)
            for (const [document_id, i] of this.#IdMap) {
              i == index && this.#IdMap.delete(document_id)
              i > index && this.#IdMap.set(document_id, i - 1)
            }
          }
        }
      }

    }
    if (actions.reindex) {
      const _sort = this.collection_options?.filters?._sort || 'desc'
      const _order_by = this.collection_options?.filters?._order_by as string || 'created_at'
      this.value.items = this.value.items.sort(
        (a: LivequeryBaseEntity, b: LivequeryBaseEntity) => {
          const ka = a[_order_by as keyof LivequeryBaseEntity]
          const kb = b[_order_by as keyof LivequeryBaseEntity]
          if (typeof ka == 'string' && typeof kb == 'string') return ka.localeCompare(ka) * (_sort == 'desc' ? -1 : 1)
          if (
            (typeof ka == 'number' || typeof ka == 'number')
            && (typeof kb == 'number' || typeof kb == 'number')
          ) return (ka - kb) * (_sort == 'desc' ? -1 : 1)
          return 1
        })
      this.#IdMap.clear()
      this.value.items.map((item, index) => this.#IdMap.set(item.id, index))
    }
    actions.update && this.$.next(this.value)
  }

  private fetch_data(
    options: Partial<QueryOption<T>> = {},
    flush: boolean = false
  ) {
    if (!this.ref) return
    if (this.#refs.length == 0) return

    if (flush) {
      this.#next_cursor = {}
      this.#queries.forEach(s => s.unsubscribe())
      this.#queries.clear()
      this.#IdMap.clear()
    }

    const has_more_data_refs = this.#refs.filter(ref => this.#next_cursor[ref] === undefined || (this.#next_cursor[ref] && this.#next_cursor[ref] != '#'))
    if (!flush && (has_more_data_refs.length == 0 || this.value.loading)) return

    this.value = {
      ... this.value,
      items: flush ? [] : this.value.items,
      error: undefined,
      loading: true,
      options
    }

    this.$.next(this.value)

    const queries = has_more_data_refs.map(ref => (
      this
        .collection_options
        .transporter
        .query<T>(ref, { ...options, _cursor: this.#next_cursor[ref] })
    ))

    const reload = () => queries.map(q => q.reload())

    const $ = merge(...queries.map((q, index) => q.pipe(map(data => ({ ...data, ref: has_more_data_refs[index] }))))).pipe(
      bufferTime(500),
      filter(list => list.length > 0),
      map(data => this.#sync(data))
    )
    const subscription = Object.assign($.subscribe(), { reload })
    this.#queries.add(subscription)
  }

  public reload() {
    this.#queries.forEach(s => s.reload())
  }

  public reset() {
    this.fetch_data({}, true)
  }

  public fetch_more() {
    this.fetch_data(this.value?.options)
  }

  public filter(filters: Partial<QueryOption<T>>) {
    this.fetch_data(filters, true)
  }



  #find_ref_by_id(id: string | undefined | '' | false) {
    if (!id || !this.ref) return { ref: this.ref, collection_ref: this.ref }
    const index = this.#IdMap.get(id)
    if (index == undefined) return {}
    const origin_ref = this.value.items[index].__ref
    if (!origin_ref) throw 'COLLECTION_REF_NOT_FOUND'
    const refs = origin_ref.split('/')
    const collection_ref = refs.slice(0, refs.length - (refs.length % 2 == 1 ? 0 : 1)).join('/')
    const ref = `${collection_ref}/${id}`
    return { ref, id, collection_ref, index }
  }

  public async add<R = { data: { item: T } }>(payload: Partial<T>) {
    return await this.collection_options.transporter.add<T, R>(`${this.ref}`, payload)
  }

  public async update<R = { data: { item: T } }>({ id: update_payload_id, ...payload }: Partial<T>) {
    const { id, ref } = this.#find_ref_by_id(update_payload_id as string)
    if (!ref) return
    // Trigger local update
    this.#sync([{
      ref,
      data: {
        changes: [{
          data: { ...payload, id, __updating: true } as any,
          ref,
          type: 'modified'
        }]
      }
    }], true)



    try {
      return await this.collection_options.transporter.update<T, R>(ref, payload as any)
    } catch (e) {
      this.#sync([{
        ref,
        data: {
          changes: [{
            data: { id, __updating: false } as any,
            ref,
            type: 'modified'
          }]
        }
      }], true)
      throw e
    }
  }

  public async remove<R = { data: { item: T } }>(remove_document_id?: string) {
    const { id, ref } = this.#find_ref_by_id(remove_document_id)
    if (!ref) return

    this.#sync([{
      ref,
      data: {
        changes: [{
          data: { id, __removing: true } as any,
          ref,
          type: 'modified'
        }]
      }
    }], true)

    // Trigger  
    try {
      return await this.collection_options.transporter.remove(ref)
    } catch (e) {
      this.#sync([{
        ref,
        data: {
          changes: [{
            data: { id, __removing: false } as any,
            ref,
            type: 'modified'
          }]
        }
      }], true)
      throw e
    }
  }

  public async trigger<R>(name: string, payload?: object, trigger_document_id?: string, query: { [key: string]: string | number | boolean } = {}) {
    const { ref } = this.#find_ref_by_id(trigger_document_id)
    if (!ref) return
    return await this.collection_options.transporter.trigger<any, any, R>(ref, name, query, payload)
  }
}

