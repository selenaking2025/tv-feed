export function readStoredBoolean(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

export function writeStoredBoolean(key: string, value: boolean): boolean {
  try {
    localStorage.setItem(key, String(value))
    return true
  } catch {
    return false
  }
}
