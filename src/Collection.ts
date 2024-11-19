
import { Subject, Subscription, Observable, merge, BehaviorSubject } from 'rxjs'
import { LivequeryBaseEntity, QueryOption, QueryStream, Transporter, UpdatedData, Paging, Response } from '@livequery/types'
import { bufferTime, filter, finalize, first, map, share, skip, tap, toArray } from 'rxjs/operators'

export type LoadingIndicator = false | 'backward' | 'forward' | 'both'

export type CollectionOption<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
  transporter: Transporter,
  sync_delay?: number
  options?: Partial<QueryOption<T>>
  realtime?: boolean
}

export type SmartQueryItem<T> = T & {
  __remove: Function
  __removing: boolean
  __update: (data: Partial<T>) => any
  __updating: boolean
  __adding: boolean
  __trigger: <R extends {}>(name: string, payload?: any, query?: any) => Promise<Response<R>>
  __ref: string
}

export type CollectionStream<T extends LivequeryBaseEntity = LivequeryBaseEntity> = {
  items: SmartQueryItem<T>[],
  paging: Partial<Paging>
  loading?: LoadingIndicator
  options: Partial<QueryOption<T>>
  error?: boolean
  code?: string
  message?: string
}


export class CollectionObservable<T extends LivequeryBaseEntity = LivequeryBaseEntity> extends BehaviorSubject<CollectionStream<T>> {


  public readonly $changes = new Subject<UpdatedData<T>>()

  #pages = new Map<string, Paging>()
  #queries = new Set<Subscription>()
  #sorters = new Array<{ key: string, order: number }>
  #IdMap = new Map<string, number>()
  #refs: string[] = []


  // $: BehaviorSubject<CollectionStream<T>> = new BehaviorSubject<CollectionStream<T>>({
  //   items: [] as SmartQueryItem<T>[],
  //   loading: false,
  //   options: {},
  //   paging: {}
  // }) 
  unsubscribe() {
    super.unsubscribe();
    this.#queries.forEach(s => s.unsubscribe())
  }

  constructor(private ref: string | false | null | '' | undefined, private collection_options: CollectionOption<T>) {
    super({
      items: [] as SmartQueryItem<T>[],
      loading: false,
      paging: {},
      options: collection_options.options || {}
    })
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

  #sync(stream: Array<QueryStream<T> & { ref: string }>, from_local: boolean = false, direction?: LoadingIndicator) {
    const state = this.getValue()
    const realtime = this.collection_options.realtime ?? true
    const actions = { update: false, reindex: false }

    for (const { data, error, code, message } of stream) {

      if (!from_local) {
        state.loading = false
        actions.update = true
      }

      // Error & paging
      if (error) {
        state.error = true
        state.code = code
        state.message = message
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
            true
            || (
              // Is realtime update that match filters
              (realtime || from_local) && Object
                .keys(state.options || {})
                .filter(key => !key.includes('_'))
                .every(key => {
                  try {
                    const [field, expression] = key.split(':')
                    const a = payload[field as keyof typeof payload] as number
                    const b = state.options?.[field as keyof QueryOption<T>] as any as number
                    if (!expression) return a == b
                    if (expression == 'ne') return a != b
                    if (expression == 'lt') return typeof a == 'number' && typeof b == 'number' && a < b
                    if (expression == 'lte') return typeof a == 'number' && typeof b == 'number' && a <= b
                    if (expression == 'gt') return typeof a == 'number' && typeof b == 'number' && a > b
                    if (expression == 'gte') return typeof a == 'number' && typeof b == 'number' && a >= b
                    if (expression == 'in' || expression == 'like') return Array.isArray(a) && a?.includes(b)
                    if (expression == 'between') {
                      const [x, y] = b as any as number[]
                      return x <= a && a <= y
                    }
                  } catch (e) { }
                  return false
                })
            )
          ) {

            const item = {
              ...payload as T,
              id: payload.id || (payload as any)._id as string,
              __adding: false,
              __updating: false,
              __removing: false,
              __remove: () => this.remove(payload?.id),
              __trigger: <R extends {}>(name: string, input: any = undefined, query: any) => this.trigger<R>(name, input, payload?.id, query),
              __update: (input: Partial<T>) => this.update({ ...input, id: payload?.id }),
              __ref: change.ref
            }

            direction == 'forward' ? state.items.push(item) : state.items.unshift(item)

            actions.reindex = true
            actions.update = true
          }
        }

        if (index >= 0 && (realtime || from_local)) {

          if (type == 'added' || type == 'modified') {
            actions.update = true
            const sort_key_value_updated = this.#sorters.some(({ key }) => {
              const value = payload[key as keyof typeof payload]
              if (typeof value == 'string' || typeof value == 'number') return true
            })

            if (sort_key_value_updated) {
              actions.reindex = true
            }
            state.items[index] = {
              ...state.items[index],
              __adding: false,
              __updating: false,
              __removing: false,
              ...payload
            }
          }


          if (type == 'removed') {
            actions.update = true
            state.items.splice(index, 1)
            for (const [document_id, i] of this.#IdMap) {
              i == index && this.#IdMap.delete(document_id)
              i > index && this.#IdMap.set(document_id, i - 1)
            }
          }
        }
      }

    }
    if (actions.reindex) {
      state.items = state.items.sort((a: LivequeryBaseEntity, b: LivequeryBaseEntity) => {

        for (const { key, order } of this.#sorters) {
          const aa = a[key as keyof typeof a]
          const bb = b[key as keyof typeof b]
          if (typeof aa == 'number' && typeof bb == 'number') {
            const rs = aa - bb
            if (rs == 0) continue
            return rs * order
          }

          if (typeof aa == 'string' && typeof bb == 'string') {
            const rs = aa.localeCompare(bb)
            if (rs == 0) continue
            return rs * order
          }
        }

        return -1
      })
      this.#IdMap.clear()
      state.items.map((item, index) => this.#IdMap.set(item.id, index))
    }


    if (state.paging?.count) {
      const d = state.items.length - state.paging.count.current
      state.paging.count.current = state.items.length
      state.paging.count.total += d
    }

    if (direction && stream.some(d => d.data?.paging)) {

      // Cache paging
      this.#pages.clear()
      stream.forEach(s => s.data?.paging && this.#pages.set(s.ref, s.data?.paging))

      // Caculate paging here
      const last_page_total = state.items.length
      const total = stream.reduce((p, c) => p + (c.data?.paging?.count?.total || 0), 0)
      const prev = stream.reduce((p, c) => p + (c.data?.paging?.count?.prev || 0), 0)
      const next = stream.reduce((p, c) => p + (c.data?.paging?.count?.next || 0), 0)

      state.paging = {
        count: {
          current: state.items.length,
          next: next - (direction == 'backward' ? last_page_total : 0),
          prev: prev - (direction == 'forward' ? last_page_total : 0),
          total
        },
        has: {
          next: stream.some(s => s.data?.paging?.has?.next),
          prev: stream.some(s => s.data?.paging?.has?.prev)
        },
        page: {
          current: Math.min(...stream.map(s => s.data?.paging?.page?.current || 0)),
          total: Math.max(...stream.map(s => s.data?.paging?.page?.total || 0))
        }
      }

    }

    actions.update && this.next(state)
  }



  private fetch_data(
    options: Partial<QueryOption<T>> = {},
    loading: LoadingIndicator,
    flush: boolean = false
  ) {
    if (!this.ref) return
    if (this.#refs.length == 0) return
    if (this.getValue().loading) return

    this.collection_options.options = options

    this.#sorters = Object.keys(options).filter(k => k.endsWith(':sort')).map(k => {
      const key = k.split(':sort')[0]
      const order = options[k as keyof typeof options] == 1 ? 1 : -1
      return { key, order }
    })
    this.#sorters.every(a => a.key != 'id') && this.#sorters.push({ key: 'id', order: -1 })

    const state = {
      ... this.getValue(),
      items: flush ? [] : this.getValue().items,
      loading,
      options: {
        ... this.getValue().options || {},
        ...options
      }
    }

    if (flush) {
      this.#pages.clear()
      this.#queries.forEach(s => s.unsubscribe())
      this.#queries.clear()
      this.#IdMap.clear()
    }

    const remain_data_refs = this.#refs.filter(ref => {
      const paging = this.#pages.get(ref)
      if (!paging) return true
      return loading == 'forward' ? paging.has?.next : paging.has?.prev
    })

    const no_more_data = !flush && (remain_data_refs.length == 0 || this.getValue().loading)
    if (no_more_data) return

    this.next(state)


    const queries = remain_data_refs.map((ref, index) => {
      const cursor = this.#pages.get(ref)?.cursor
      const opts = {
        ...options,
        ...loading == 'backward' && cursor?.first ? { ':before': cursor?.first } : {},
        ...loading == 'forward' && cursor?.last ? { ':after': cursor?.last } : {},
      }
      return this
        .collection_options
        .transporter
        .query<T>(ref, opts).pipe(
          map(data => ({
            ...data,
            ref
          })),
          share()
        )
    })


    const first_values = merge(
      ...queries.map(q => q.pipe(
        filter(r => !!r.data?.paging || !!r.error),
        first()
      ))
    ).pipe(
      toArray(),
      tap(list => this.#sync(list, false, loading))
    ).subscribe()

    const subscription = merge(...queries.map(q => q.pipe(skip(1)))).pipe(
      bufferTime(this.collection_options?.sync_delay || 500),
      filter(list => list.length > 0),
      map(data => this.#sync(data, false, loading)),
      finalize(() => first_values.unsubscribe())
    ).subscribe()



    this.#queries.add(subscription)
  }


  public reset() {
    this.fetch_data({}, 'both', true)
  }

  public fetch_more() {
    const { options } = this.getValue()
    this.fetch_data(options, 'forward')

  }

  public fetch_prev() {
    const { options } = this.getValue()
    this.fetch_data(options, 'backward')
  }

  // public fetch_around_cursor(cursor: string) {
  //   const state = this.$.getValue()
  //   this.fetch_data(state.options, 'both')
  // }

  public filter(filters: Partial<QueryOption<T>>) {
    this.fetch_data(filters, 'forward', true)
  }



  #find_ref_by_id(id: string | undefined | '' | false) {
    if (!id || !this.ref) return { ref: this.ref, collection_ref: this.ref }
    const index = this.#IdMap.get(id)
    if (index == undefined) return {}
    const origin_ref = this.getValue().items[index].__ref
    if (!origin_ref) throw 'COLLECTION_REF_NOT_FOUND'
    const refs = origin_ref.split('/')
    const collection_ref = refs.slice(0, refs.length - (refs.length % 2 == 1 ? 0 : 1)).join('/')
    const ref = `${collection_ref}/${id}`
    return { ref, id, collection_ref, index }
  }

  public async add(payload: Partial<T>) {
    const r = await this.collection_options.transporter.add<T>(`${this.ref}`, payload)
    if (r.data && r.data.item && !r.data.item.id) {
      r.data.item.id = (r.data.item as any)._id
    }
    return r
  }

  public async update({ id: update_payload_id, ...payload }: Partial<T>) {
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
      return await this.collection_options.transporter.update(ref, payload as Partial<T>)
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

  public async remove(remove_document_id?: string) {
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

  public async trigger<R extends {}>(name: string, payload?: object, trigger_document_id?: string, query: { [key: string]: string | number | boolean } = {}) {
    const { ref } = this.#find_ref_by_id(trigger_document_id)
    if (!ref) throw new Error('INVAILD_REF')
    return await this.collection_options.transporter.trigger<R>(ref, name, payload, query)
  }
}

