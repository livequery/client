
import { Subject, Subscription, Observable, from, merge } from 'rxjs'
import { ErrorInfo, QueryOption, QueryStream, Transporter, UpdatedData } from '@livequery/types'
import { get_sort_function } from './helpers/get_sort_function'
import { bufferCount, bufferTime, filter, map, mergeAll, toArray } from 'rxjs/operators'
import { v4 } from 'uuid'

export type CollectionOption<T = any> = {
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
  __collection_ref: string
}

type CollectionStream<T> = {
  items: SmartQueryItem<T>[],
  error?: ErrorInfo,
  has_more: boolean
  loading?: boolean,
  options: Partial<QueryOption<T>>
}


export class CollectionObservable<T extends { id: string }> extends Observable<CollectionStream<T>>{


  public readonly $changes = new Subject<UpdatedData<T>>()


  #$state = new Subject<CollectionStream<T>>()
  #subscriptions = new Set<Subscription & { reload: Function }>()
  #state: CollectionStream<T>
  #next_cursor: { [ref: string]: string } = {}
  #IdMap = new Map<string, number>()
  #refs: string[] = []




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
    this.#refs = this.#ref_parser(ref)
  }

  #ref_parser(path: string) {
    const refs_builder = (paths: string[][]) => {
      const [a, b, ...c] = paths
      if (!b) return paths
      const r = a.map(aa => b.map(bb => `${aa}/${bb}`)).flat(2)
      const d = [r, ...c]
      return refs_builder(d)
    }
    return path.split(',').map(f => refs_builder(f.trim().split('/').map(l => l.split('.')))).flat(2)
  }

  set_realtime(realtime: boolean) {
    this.collection_options.realtime = realtime
  }

  private sync(stream: Array<QueryStream<T> & { ref: string }>, from_local: boolean = false) {
    const realtime = this.collection_options.realtime ?? true
    const actions = { update: false, reindex: false }
    for (const { data, error, ref } of stream) {

      // Error & paging
      if (error) {
        this.#state.error = error
        actions.update = true
      }


      if (data?.paging?.n == 0) {
        this.#next_cursor[ref] = data?.paging?.next_cursor
        this.#state.has_more = Object.values(this.#next_cursor).some(v => v && v != '#')
        this.#state.loading = false
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

            this.#state.items.push({
              ...payload as T,
              __adding: false,
              __updating: false,
              __removing: false,
              __remove: () => this.remove(payload?.id),
              __trigger: (name: string, input?: any) => this.trigger(name, input, payload?.id),
              __update: (input: Partial<T>) => this.update({ ...input, id: payload?.id }),
              __collection_ref: change.ref
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
            this.#state.items[index] = {
              ...this.#state.items[index],
              __adding: false,
              __updating: false,
              __removing: false,
              ...payload
            }
          }


          if (type == 'removed') {
            actions.reindex = true
            actions.update = true
            this.#state.items.splice(index, 1)
            for (const [document_id, i] of this.#IdMap) {
              i == index && this.#IdMap.delete(document_id)
              i > index && this.#IdMap.set(document_id, i - 1)
            }
          }
        }
      }

    }
    if (actions.reindex) {
      this.#state.items = this.#state.items.sort(get_sort_function(
        this.#state.items[0],
        this.collection_options?.filters?._order_by as string || 'created_at',
        this.collection_options?.filters?._sort
      ))
      this.#IdMap.clear()
      this.#state.items.map((item, index) => this.#IdMap.set(item.id, index))
    }
    actions.update && this.#$state.next(this.#state)
  }

  private fetch_data(
    options: Partial<QueryOption<T>> = {},
    flush: boolean = false
  ) {

    if (!this.ref) return

    if (flush) {
      this.#next_cursor = {}
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

    const has_more_data_refs = this.#refs.filter(ref => this.#next_cursor[ref] === undefined || (this.#next_cursor[ref] && this.#next_cursor[ref] != '#'))

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
      map(data => this.sync(data))
    )
    const subscription = Object.assign($.subscribe(), { reload })
    this.#subscriptions.add(subscription)
  }

  public reload() {
    this.#subscriptions.forEach(s => s.reload())
  }

  public reset() {
    this.fetch_data({}, true)
  }

  public fetch_more() {
    this.fetch_data(this.#state?.options)
  }

  public filter(filters: Partial<QueryOption<T>>) {
    this.fetch_data(filters, true)
  }

  public async add(payload: T) {
    if (this.ref.includes('.')) throw 'INVAILD_COLLECTION_REF_FOR_ADDING'
    return await this.collection_options.transporter.add(`${this.ref}`, payload as any) as { data: { item: T } }
  }

  #find_ref_by_id(id: string) {
    if (!id) throw 'ID_NOT_FOUND'
    const collection_ref = this.#state.items[this.#IdMap.get(id)].__collection_ref
    if (!collection_ref) throw 'COLLECTION_REF_NOT_FOUND'
    const ref = `${collection_ref}${id ? `/${id}` : ''}`
    return { ref, id, collection_ref }
  }

  public async update({ id: update_payload_id, ...payload }: Partial<T & { id: string }>) {
    const { id, ref } = this.#find_ref_by_id(update_payload_id)

    // Trigger local update
    this.sync([{
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
      return await this.collection_options.transporter.update(ref, payload as any) as any
    } catch (e) {
      this.sync([{
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

  public async remove(remove_document_id?: string) {
    const { id, ref } = this.#find_ref_by_id(remove_document_id)

    this.sync([{
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
      this.sync([{
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

  public async trigger<T>(name: string, payload?: object, trigger_document_id?: string) {
    const { ref } = this.#find_ref_by_id(trigger_document_id)
    return await this.collection_options.transporter.trigger(ref, name, {}, payload as any) as T
  }
}

