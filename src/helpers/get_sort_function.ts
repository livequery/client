export function get_sort_function(data: any, key: string, order: 'asc' | 'desc' = 'desc') {

    const type = typeof data?.[key]

    if (type == 'bigint' || type == 'number') {
        if (order == 'asc') return (a, b) => a[key] - b[key] || ((a.created_at || 1) - (b.created_at || 0))
        if (order == 'desc') return (a, b) => b[key] - a[key] || ((a.created_at || 1) - (b.created_at || 0))
    }
    if (type == 'string') {
        if (order == 'asc') return (a, b) => (a[key] as string).localeCompare(b[key]) || ((a.created_at || 1) - (b.created_at || 0))
        if (order == 'desc') return (a, b) => (b[key] as string).localeCompare(a[key]) || ((a.created_at || 1) - (b.created_at || 0))
    }

    return () => 1
}