import type { LibraryTabDef, LibraryTabFilters } from '@shared/types'
import { withSortIcons } from '../../../components/SortIcon'
import { ChevronLeft, ChevronRight, Columns3, Plus, Shapes, Star, Trash2 } from 'lucide-react'
import { memo, useCallback, useMemo, type ReactElement } from 'react'
import { Button } from '../../../components/Button'
import { SelectField } from '../../../components/SelectField'
import { Toggle } from '../../../components/Toggle'
import { useLanguage, useT, type Translate } from '../../../i18n'
import { setFocus } from '../../../input/focus'
import { libraryControlsFilters } from '../../../lib/controls'
import { hiddenGames, visibleGames } from '../../../lib/library'
import {
  emptyTabFilters,
  MAX_LIBRARY_TABS_UI,
  RECOMMENDED_TABS,
  hasRecommendedTab,
  moveTab,
  newTabDef,
  platformLabelOf,
  tabName,
  type RecommendedTab
} from '../../../lib/libraryTabs'
import {
  LIBRARY_SORT_OPTIONS,
  librarySortOptions,
  type LibrarySort
} from '../../../lib/libraryView'
import { libraryPlatformFilters, type PlatformFilter } from '../../../lib/platformFilters'
import { libraryReleaseEras, type ReleaseEra } from '../../../lib/releaseEras'
import { libraryTagFilters, type TagFilter } from '../../../lib/steamTags'
import { libraryStoreFilters, platformKindOf, type StoreFilter } from '../../../lib/storeFilters'
import { customFilterNames } from '../../../lib/customFilters'
import { useCustomFilters } from '../../../state/customFilters'
import { useLibraryStore } from '../../../state/library'
import { addTab, libraryTabDefs, setTabs } from '../../../state/libraryTabs'
import { FiltersPill } from '../../Library/FiltersPill'
import { fk, useSettingsPatch, type SectionProps } from '../common'

// Part of Settings › Library (the Library's tabs used to be a section of their own): its focus keys are the Library
// section's, under 'tabs:'.
const tabKey = (name: string): string => fk('library', `tabs:${name}`)
const ADD_KEY = tabKey('add')

/** The choices the Filters menus offer: from every game, as the Library's All Games tab offers them. */
interface FilterOptions {
  platformLabel: (id: string) => string
  platformOptions: readonly PlatformFilter[]
  tagOptions: readonly TagFilter[]
  storeOptions: readonly StoreFilter[]
  eraOptions: readonly ReleaseEra[]
  controlsOptions: readonly string[]
  hiddenCount: number
  favoriteCount: number
  recompCount: number
  /** Filters > Custom: how many of the library's games each of the user's filters holds (by filter id). */
  customCounts: ReadonlyMap<string, number>
}

/**
 * The Library's tabs, left to right: each named by its filters, with its sort and filters to change, moved left or
 * right, or deleted (one always stays). New tabs are All Games on Title A–Z with playable games first; the recommended tabs are added
 * with one press.
 */
export function LibraryTabsSettings({ settings }: Pick<SectionProps, 'settings'>): ReactElement {
  const t = useT()
  const patch = useSettingsPatch()
  const defs = settings.ui.libraryTabs ?? []
  const games = useLibraryStore((s) => s.games)
  const platforms = useLibraryStore((s) => s.platforms)
  const platformsById = useLibraryStore((s) => s.platformsById)
  const options = useMemo((): FilterOptions => {
    const visible = visibleGames(games, settings)
    const platformLabel = platformLabelOf(platformsById)
    return {
      platformLabel,
      platformOptions: libraryPlatformFilters(visible, platforms, platformLabel),
      tagOptions: libraryTagFilters(visible),
      storeOptions: libraryStoreFilters(visible, platformKindOf(platformsById)),
      eraOptions: libraryReleaseEras(visible),
      controlsOptions: libraryControlsFilters(visible),
      hiddenCount: hiddenGames(games, settings).length,
      favoriteCount: visible.filter((g) => g.favorite).length,
      recompCount: visible.filter((g) => g.metadata.recomp).length,
      customCounts: new Map(
        (settings.library.customFilters ?? []).map((filter) => {
          const ids = new Set(filter.gameIds)
          return [filter.id, visible.filter((g) => ids.has(g.id)).length] as const
        })
      )
    }
  }, [games, settings, platforms, platformsById])
  const full = defs.length >= MAX_LIBRARY_TABS_UI

  // Added without leaving Settings; focus goes to the new tab's Filters pill, to set its filters here.
  const add = useCallback((def: LibraryTabDef = newTabDef()) => {
    if (!addTab(def, { show: false })) return
    setTimeout(() => void setFocus(tabKey(`${def.id}:filters`)), 0)
  }, [])
  const addRecommended = useCallback(
    (tab: RecommendedTab) =>
      add(newTabDef({ filters: tab.filters, sort: tab.sort, playableFirst: tab.playableFirst })),
    [add]
  )

  return (
    <>
      <div className="section">
        <div className="section__title">{t('settingsTabs.title')}</div>
        <p className="settings-note">{t('settingsTabs.note')}</p>
        {/* The tabs at the top of the Library show their filters' icons instead of their names (TabStrip.tsx); the
            list below keeps the names, which say what each tab is. */}
        <Toggle
          focusKey={tabKey('icons')}
          icon={<Shapes />}
          label={t('settingsTabs.icons.label')}
          description={t('settingsTabs.icons.description')}
          checked={settings.ui.libraryTabIcons ?? true}
          onChange={(v) => patch({ ui: { libraryTabIcons: v } })}
        />
        {defs.map((def, index) => (
          <TabRow
            key={def.id}
            def={def}
            first={index === 0}
            last={index === defs.length - 1}
            only={defs.length === 1}
            options={options}
          />
        ))}
        <div className="settings-row">
          <div className="settings-row__text">
            <span className="settings-row__desc">
              {full
                ? t('settingsTabs.full', { max: MAX_LIBRARY_TABS_UI })
                : t('settingsTabs.newTab')}
            </span>
          </div>
          <div className="settings-row__actions">
            <Button focusKey={ADD_KEY} icon={<Plus />} onPress={() => add()} aria-disabled={full}>
              {t('settingsTabs.add')}
            </Button>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section__title">{t('settingsTabs.recommended.title')}</div>
        {RECOMMENDED_TABS.map((tab) => {
          const added = hasRecommendedTab(defs, tab)
          return (
            <div key={tab.key} className="settings-card">
              <div className="settings-row">
                <span className="control__icon">
                  <Star />
                </span>
                <div className="settings-row__text">
                  <span className="settings-row__label">{tab.name}</span>
                  <span className="settings-row__desc">
                    {t('settingsTabs.recommended.description', {
                      description: tab.description,
                      sort:
                        LIBRARY_SORT_OPTIONS.find((o) => o.value === tab.sort)?.label ?? tab.sort
                    })}
                  </span>
                </div>
                <div className="settings-row__actions">
                  <Button
                    focusKey={tabKey(`recommended:${tab.key}`)}
                    icon={<Plus />}
                    variant={added ? 'ghost' : 'secondary'}
                    aria-disabled={full}
                    onPress={() => {
                      if (!full) addRecommended(tab)
                    }}
                  >
                    {added
                      ? t('settingsTabs.recommended.addAgain')
                      : t('settingsTabs.recommended.add')}
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

interface TabRowProps {
  def: LibraryTabDef
  first: boolean
  last: boolean
  only: boolean
  options: FilterOptions
}

/** Replace one tab, read fresh from the store (a burst of picks never works on a stale list). */
function changeTab(id: string, change: (def: LibraryTabDef) => LibraryTabDef): void {
  setTabs(libraryTabDefs().map((d) => (d.id === id ? change(d) : d)))
}

/** A tab's sort line: the sort, whether it is reversed and plays playable games first, and its search, as one sentence. */
function sortLine(def: LibraryTabDef, sortLabel: string, t: Translate): string {
  const line =
    def.sortReversed && def.playableFirst
      ? t('settingsTabs.row.sortReversedPlayableFirst', { sort: sortLabel })
      : def.sortReversed
        ? t('settingsTabs.row.sortReversed', { sort: sortLabel })
        : def.playableFirst
          ? t('settingsTabs.row.sortPlayableFirst', { sort: sortLabel })
          : sortLabel
  return def.query ? t('settingsTabs.row.searching', { sort: line, query: def.query }) : line
}

/** One tab: its name and sort, Move left / right, the Sort and Filters pills, Delete. */
const TabRow = memo(function TabRow({
  def,
  first,
  last,
  only,
  options
}: TabRowProps): ReactElement {
  const t = useT()
  const id = def.id
  const customFilters = useCustomFilters()
  const customName = useMemo(() => customFilterNames(customFilters), [customFilters])
  const key = (name: string): string => tabKey(`${id}:${name}`)
  const setFilter = useCallback(
    <K extends keyof LibraryTabFilters>(name: K, value: LibraryTabFilters[K]) =>
      changeTab(id, (d) => ({ ...d, filters: { ...d.filters, [name]: value } })),
    [id]
  )
  const onSort = useCallback(
    (sort: LibrarySort) =>
      changeTab(id, (d) =>
        d.sort === sort
          ? { ...d, sortReversed: !d.sortReversed }
          : { ...d, sort, sortReversed: false }
      ),
    [id]
  )
  const move = (delta: number): void => setTabs(moveTab(libraryTabDefs(), id, delta))
  const remove = (): void => {
    if (only) return
    const defs = libraryTabDefs()
    const index = defs.findIndex((d) => d.id === id)
    const rest = defs.filter((d) => d.id !== id)
    setTabs(rest)
    // Focus moves to the tab that took this one's place (or the one before it), else to Add tab.
    const next = rest[Math.min(index, rest.length - 1)]
    setTimeout(() => void setFocus(next ? tabKey(`${next.id}:delete`) : ADD_KEY), 0)
  }
  const sortLabel = LIBRARY_SORT_OPTIONS.find((o) => o.value === def.sort)?.label ?? def.sort
  // The Sort menu alphabetical in the language shown.
  const language = useLanguage()
  const sortOptions = useMemo(() => withSortIcons(librarySortOptions(language)), [language])
  return (
    <div className="settings-card settings-tab">
      <div className="settings-row">
        <span className="control__icon">
          <Columns3 />
        </span>
        <div className="settings-row__text">
          <span className="settings-row__label">
            {tabName(def.filters, options.platformLabel, customName)}
          </span>
          <span className="settings-row__value">{sortLine(def, sortLabel, t)}</span>
        </div>
        <div className="settings-row__actions">
          <Button
            focusKey={key('left')}
            variant="ghost"
            icon={<ChevronLeft />}
            aria-label={t('settingsTabs.row.moveLeft')}
            title={t('settingsTabs.row.moveLeft')}
            aria-disabled={first}
            onPress={() => move(-1)}
          />
          <Button
            focusKey={key('right')}
            variant="ghost"
            icon={<ChevronRight />}
            aria-label={t('settingsTabs.row.moveRight')}
            title={t('settingsTabs.row.moveRight')}
            aria-disabled={last}
            onPress={() => move(1)}
          />
          <SelectField
            focusKey={key('sort')}
            variant="pill"
            className="settings-tab__sort"
            label={t('settingsTabs.row.sort')}
            value={def.sort}
            options={sortOptions}
            direction={def.sortReversed ? 'up' : 'down'}
            onChange={onSort}
          />
          <FiltersPill
            focusKey={key('filters')}
            platforms={def.filters.platforms}
            platformOptions={options.platformOptions}
            onPlatforms={(v) => setFilter('platforms', v)}
            tags={def.filters.tags}
            tagOptions={options.tagOptions}
            onTags={(v) => setFilter('tags', v)}
            stores={def.filters.stores}
            storeOptions={options.storeOptions}
            onStores={(v) => setFilter('stores', v)}
            eras={def.filters.eras}
            eraOptions={options.eraOptions}
            onEras={(v) => setFilter('eras', v)}
            sizes={def.filters.sizes}
            onSizes={(v) => setFilter('sizes', v)}
            hltb={def.filters.hltb}
            onHltb={(v) => setFilter('hltb', v)}
            difficulty={def.filters.difficulty ?? []}
            onDifficulty={(v) => setFilter('difficulty', v)}
            reviews={def.filters.reviews ?? []}
            onReviews={(v) => setFilter('reviews', v)}
            controls={def.filters.controls ?? []}
            controlsOptions={options.controlsOptions}
            onControls={(v) => setFilter('controls', v)}
            players={def.filters.players ?? []}
            onPlayers={(v) => setFilter('players', v)}
            online={def.filters.online ?? []}
            onOnline={(v) => setFilter('online', v)}
            hidden={def.filters.hidden}
            onHidden={(v) => setFilter('hidden', v)}
            hiddenCount={options.hiddenCount}
            favorites={def.filters.favorites}
            onFavorites={(v) => setFilter('favorites', v)}
            favoriteCount={options.favoriteCount}
            coop={def.filters.coop}
            onCoop={(v) => setFilter('coop', v)}
            recomp={def.filters.recomp}
            onRecomp={(v) => setFilter('recomp', v)}
            recompCount={options.recompCount}
            developers={def.filters.developers ?? []}
            onDevelopers={(v) => setFilter('developers', v)}
            publishers={def.filters.publishers ?? []}
            onPublishers={(v) => setFilter('publishers', v)}
            custom={def.filters.custom ?? []}
            onCustom={(v) => setFilter('custom', v)}
            customCounts={options.customCounts}
            onClearFilters={() => changeTab(id, (d) => ({ ...d, filters: emptyTabFilters() }))}
          />
          <Button
            focusKey={key('delete')}
            variant="ghost"
            icon={<Trash2 />}
            aria-label={t('settingsTabs.row.delete')}
            title={only ? t('settingsTabs.row.lastTab') : t('settingsTabs.row.delete')}
            aria-disabled={only}
            onPress={remove}
          />
        </div>
      </div>
    </div>
  )
})
