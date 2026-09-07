import type { CacheStatus, Catalog, CatalogLoadFailure, CatalogSyncProgress } from '../../shared/catalog-contracts.ts'
import { displayCountryName, sortCountriesForDisplay } from '../../shared/countries.ts'

type CatalogStatusElements = Record<
  'catalogState' | 'catalogStats' | 'loadingList' | 'channelWindow' | 'channelSpacer' |
  'catalogFailure' | 'catalogFailureTitle' | 'catalogFailureMessage' | 'catalogDiagnostics' |
  'toggleCatalogDiagnostics' | 'resultCount', HTMLElement
> & { search: HTMLInputElement; country: HTMLSelectElement; category: HTMLSelectElement }

/** Catalog presentation only; this view does not own catalog or safety state. */
export function createCatalogStatusView(elements: CatalogStatusElements, familySafety: () => boolean) {
  return {
    populateFacets, renderCatalogStats, updateCatalogStatus, showFailure, begin, progress,
    setCatalogFailureVisible, setCatalogControlsEnabled, toggleCatalogDiagnostics
  }

  function populateFacets(value: Catalog): void {
    replaceSelectOptions(
      elements.country,
      '所有地区',
      sortCountriesForDisplay(value.countries).map((country) => ({
        value: country.code,
        label: `${country.flag} ${displayCountryName(country.code, country.name)} · ${formatCount(country.count)}`
      }))
    )
    replaceSelectOptions(
      elements.category,
      '所有类型',
      value.categories.map((category) => ({ value: category.id, label: `${category.name} · ${formatCount(category.count)}` }))
    )
  }

  function replaceSelectOptions(select: HTMLSelectElement, allLabel: string, options: Array<{ value: string; label: string }>): void {
    const previous = select.value
    const nodes: HTMLOptionElement[] = []
    const all = document.createElement('option')
    all.value = ''
    all.textContent = allLabel
    nodes.push(all)
    for (const item of options) {
      const option = document.createElement('option')
      option.value = item.value
      option.textContent = item.label
      nodes.push(option)
    }
    select.replaceChildren(...nodes)
    if (options.some((item) => item.value === previous)) select.value = previous
  }

  function updateCatalogStatus(status: CacheStatus, count: number): void {
    delete elements.catalogState.dataset.syncStage
    const labels: Record<CacheStatus, string> = {
      network: `已同步 iptv-org · ${formatCount(count)} 台`,
      'fresh-cache': `本机目录 · ${formatCount(count)} 台`,
      'stale-cache': `离线缓存 · ${formatCount(count)} 台`,
      'legacy-cache': `旧版离线缓存 · ${formatCount(count)} 台`,
      'offline-sample': `离线样例 · ${formatCount(count)} 台`
    }
    elements.catalogState.textContent = `${labels[status]}${familySafety() ? ' · 家庭安全' : ''}`
    elements.catalogState.classList.toggle('warning', status === 'stale-cache' || status === 'legacy-cache' || status === 'offline-sample')
  }

  function renderCatalogStats(value: Catalog): void {
    const rows: Array<readonly [string, string]> = [
      ['目录来源', value.source === 'iptv-org' ? 'iptv-org API' : '内置离线样例'],
      ['家庭安全模式', familySafety() ? '已开启 · 本地允许列表' : '未开启 · 上游元数据保守过滤'],
      ['筛选后频道', formatCount(value.stats.channels)],
      ['候选线路', formatCount(value.stats.candidateStreams)],
      ['按标记排除成人 / 停播', formatCount(value.stats.excludedUnsafeChannel)],
      ['排除屏蔽频道', formatCount(value.stats.excludedBlockedChannel)],
      ['排除不兼容线路', formatCount(value.stats.excludedBrowserIncompatible)],
      ['跳过异常上游记录', formatCount(value.stats.discardedUpstreamRecords ?? 0)],
      ['家庭允许列表排除线路', formatCount(value.stats.excludedFamilySafety ?? 0)],
      ['目录生成时间', new Date(value.generatedAt).toLocaleString('zh-CN')]
    ]
    const fragment = document.createDocumentFragment()
    for (const [term, detail] of rows) {
      const dt = document.createElement('dt')
      const dd = document.createElement('dd')
      dt.textContent = term
      dd.textContent = detail
      fragment.append(dt, dd)
    }
    elements.catalogStats.replaceChildren(fragment)
  }

  function setCatalogFailureVisible(visible: boolean): void {
    elements.catalogFailure.hidden = !visible
    if (!visible) delete elements.catalogFailure.dataset.errorCode
    elements.channelWindow.hidden = visible
    elements.channelSpacer.hidden = visible
  }

  function setCatalogControlsEnabled(enabled: boolean): void {
    elements.search.disabled = !enabled
    elements.country.disabled = !enabled
    elements.category.disabled = !enabled
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.disabled = !enabled
  }

  function toggleCatalogDiagnostics(): void {
    const expanded = elements.toggleCatalogDiagnostics.getAttribute('aria-expanded') === 'true'
    elements.toggleCatalogDiagnostics.setAttribute('aria-expanded', String(!expanded))
    elements.toggleCatalogDiagnostics.textContent = expanded ? '查看诊断信息' : '隐藏诊断信息'
    elements.catalogDiagnostics.hidden = expanded
  }

  function showFailure(failure: CatalogLoadFailure): void {
    elements.loadingList.hidden = true
    elements.channelWindow.replaceChildren()
    elements.channelWindow.hidden = true
    elements.channelSpacer.hidden = true
    setCatalogControlsEnabled(false)
    setCatalogFailureVisible(true)
    elements.catalogFailure.dataset.errorCode = failure.code
    elements.catalogFailureTitle.textContent = failure.title
    elements.catalogFailureMessage.textContent = failure.message
    elements.catalogDiagnostics.textContent = [
      `错误类别：${failure.code}`,
      `可重试：${failure.retryable ? '是' : '否'}`,
      `诊断：${failure.detail || '没有更多诊断信息'}`
    ].join('\n')
    elements.catalogDiagnostics.hidden = true
    elements.toggleCatalogDiagnostics.setAttribute('aria-expanded', 'false')
    elements.toggleCatalogDiagnostics.textContent = '查看诊断信息'
    elements.catalogState.textContent = '无法获取 iptv-org 目录'
    elements.catalogState.classList.add('warning')
    elements.resultCount.textContent = '未载入真实频道'
  }

  function begin(message: string, hasCatalog: boolean): void {
    setCatalogFailureVisible(false)
    elements.catalogState.classList.remove('warning')
    elements.catalogState.textContent = message
    if (!hasCatalog) {
      elements.channelWindow.hidden = true
      elements.channelSpacer.hidden = true
      elements.loadingList.hidden = false
      elements.resultCount.textContent = message
    }
  }

  function progress(update: CatalogSyncProgress, hasCatalog: boolean): void {
    elements.catalogState.dataset.syncStage = update.stage
    elements.catalogState.textContent = update.message
    if (!hasCatalog) elements.resultCount.textContent = update.message
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}
