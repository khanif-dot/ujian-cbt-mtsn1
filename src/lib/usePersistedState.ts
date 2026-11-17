import { useCallback, useEffect, useRef, useState } from 'react';

type StorageKind = 'session' | 'local';

function getStorage(kind: StorageKind): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPersistedValue<T>(key: string, fallback: T, kind: StorageKind = 'session'): T {
  const storage = getStorage(kind);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePersistedValue<T>(key: string, value: T, kind: StorageKind = 'session'): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

export function clearPersistedValue(key: string, kind: StorageKind = 'session'): void {
  const storage = getStorage(kind);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore
  }
}

/**
 * State hook yang otomatis menyimpan draft input ke sessionStorage/localStorage
 * sehingga melakukan refresh browser saat mengisi form tidak menghilangkan inputan.
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T | (() => T),
  kind: StorageKind = 'session'
): [T, React.Dispatch<React.SetStateAction<T>>, () => void] {
  const initialRef = useRef(initialValue);

  const [state, setState] = useState<T>(() => {
    const fallback =
      typeof initialRef.current === 'function'
        ? (initialRef.current as () => T)()
        : initialRef.current;
    return readPersistedValue<T>(key, fallback, kind);
  });

  useEffect(() => {
    writePersistedValue(key, state, kind);
  }, [key, state, kind]);

  const resetPersisted = useCallback(() => {
    clearPersistedValue(key, kind);
    const fallback =
      typeof initialRef.current === 'function'
        ? (initialRef.current as () => T)()
        : initialRef.current;
    setState(fallback);
  }, [key, kind]);

  return [state, setState, resetPersisted];
}
