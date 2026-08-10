import type { CatalogCountry } from './contracts.ts'

const countryNameCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base'
})

const localizedCountryNames: Record<string, string> = {
  CN: '中国 / China',
  HK: '中国香港 / Hong Kong',
  TW: '中国台湾 / Taiwan',
  MO: '中国澳门 / Macao'
}

const countrySearchAliases: Record<string, string> = {
  CN: '中国 中国大陆 大陆 china mainland',
  HK: '中国香港 香港 hong kong',
  TW: '中国台湾 台湾 taiwan',
  MO: '中国澳门 澳门 macao macau'
}

export function sortCountriesForDisplay(countries: CatalogCountry[]): CatalogCountry[] {
  return [...countries].sort((a, b) => {
    if (a.code === 'CN') return b.code === 'CN' ? 0 : -1
    if (b.code === 'CN') return 1
    return countryNameCollator.compare(a.name, b.name) || a.code.localeCompare(b.code, 'en')
  })
}

export function displayCountryName(code: string, fallbackName: string): string {
  return localizedCountryNames[code] ?? fallbackName
}

export function getCountrySearchAliases(code: string): string {
  return countrySearchAliases[code] ?? ''
}
