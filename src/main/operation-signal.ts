/** Stop awaiting abandoned work even when an injected transport ignores cancellation. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { finish(); reject(signal.reason) }
    const finish = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(value => { finish(); resolve(value) }, error => { finish(); reject(error) })
  })
}
