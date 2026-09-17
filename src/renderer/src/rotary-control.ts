interface RotaryOptions {
  element: HTMLElement
  minimum: number
  maximum: number
  value: number
  pixelsPerStep: number
  deferred?: boolean
  angle: (value: number) => number
  describe: (value: number) => string
  onPreview?: (value: number) => void
  onChange: (value: number) => void
}

/** Pointer capture keeps a drag on its dial. Channel changes commit once on release. */
export function createRotaryControl(options: RotaryOptions) {
  const { element } = options
  let maximum = options.maximum
  let committed = options.value
  let value = committed
  let drag: { id: number; y: number; start: number } | undefined

  function render(): void {
    const available = maximum >= options.minimum
    element.setAttribute('aria-disabled', String(!available))
    element.tabIndex = available ? 0 : -1
    element.setAttribute('aria-valuemin', String(options.minimum))
    element.setAttribute('aria-valuemax', String(Math.max(options.minimum, maximum)))
    element.setAttribute('aria-valuenow', String(value))
    element.setAttribute('aria-valuetext', available ? options.describe(value) : '没有可选频道')
    element.style.setProperty('--dial-angle', `${options.angle(value)}deg`)
    options.onPreview?.(value)
  }

  function bounded(next: number): number {
    return Math.max(options.minimum, Math.min(Math.max(options.minimum, maximum), Math.round(next)))
  }

  function change(next: number, commit: boolean): void {
    value = bounded(next)
    render()
    if (commit && value !== committed) {
      committed = value
      options.onChange(value)
    }
  }

  function finish(commit: boolean): void {
    const previous = drag
    drag = undefined
    if (previous && element.hasPointerCapture(previous.id)) element.releasePointerCapture(previous.id)
    if (commit) change(value, true)
    else { value = committed; render() }
  }

  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || maximum < options.minimum) return
    event.preventDefault()
    element.focus({ preventScroll: true })
    element.setPointerCapture(event.pointerId)
    drag = { id: event.pointerId, y: event.clientY, start: value }
  })
  element.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return
    change(drag.start + (drag.y - event.clientY) / options.pixelsPerStep, !options.deferred)
  })
  element.addEventListener('pointerup', (event) => {
    if (drag?.id === event.pointerId) finish(true)
  })
  element.addEventListener('pointercancel', () => finish(false))
  element.addEventListener('lostpointercapture', () => { if (drag) finish(false) })
  element.addEventListener('keydown', (event) => {
    const steps: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }
    if (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopPropagation()
    if (maximum < options.minimum) return
    finish(false)
    change(event.key === 'Home' ? options.minimum : event.key === 'End' ? maximum : value + steps[event.key]!, true)
  })

  render()
  return {
    sync(next: number, nextMaximum = maximum): void {
      // External selection changes cancel a stale channel drag; volume events may
      // reflect the value just emitted by this control and keep its drag alive.
      if (drag && (options.deferred || nextMaximum !== maximum)) finish(false)
      maximum = nextMaximum
      committed = bounded(next)
      value = committed
      render()
    }
  }
}
