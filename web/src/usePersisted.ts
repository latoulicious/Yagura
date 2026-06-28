import { useEffect, useState } from 'react'

function read<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : initial
  } catch {
    return initial
  }
}

/** useState backed by localStorage (best-effort; ignores storage errors). */
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [state, setState] = useState(() => ({ key, value: read(key, initial) }))
  // Re-read when the key changes — otherwise value keeps the previous key's data.
  if (state.key !== key) setState({ key, value: read(key, initial) })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state.value))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [key, state.value])
  return [state.value, (v: T) => setState({ key, value: v })]
}
