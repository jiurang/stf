import {Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type UIEvent} from 'react'
import {Badge} from '@mantine/core'
import {IconChevronRight} from '@tabler/icons-react'
import {useTranslation} from '@/core/i18n'
import {CopyButton} from '@/ui/CopyButton'
import {flattenLogJson, parseLogJson, summarizeLogJson, type LogEntry, type ParsedLogJson} from './logcat'
import classes from './Logs.module.css'

const rowHeight = 22
const overscan = 20
// 面板宽度随拖拽在 320px 到 2/3 窗口之间动。窄到放不下时让表格横向滚动，
// 而不是把列压扁 —— 压扁的结果是连同唯一有信息的那一列一起没掉，等于白看
const nativeColumns = '72px 88px 52px 52px minmax(64px, 160px) minmax(200px, 1fr)'
const webColumns = '72px 88px minmax(200px, 1fr)'

/** 展开区的高度预算：改这四个数要同步改 .detail 的 CSS 行高与内边距 */
const jsonLineHeight = 20
const jsonPanelHeader = 28
const jsonPanelPadding = 12
const maxJsonRows = 12

const priorityColors: Record<string, string> = {
  Verbose: 'gray'
  , Debug: 'blue'
  , Info: 'green'
  , Warn: 'yellow'
  , Error: 'red'
  , Fatal: 'red'
}

function cellClass(...names: Array<string | undefined>): string {
  return [classes.cell, ...names].join(' ')
}

/** 展开一行要占多高：行数可数出来，不必等渲染完再量 */
function detailHeight(parsed: ParsedLogJson): number {
  const total = flattenLogJson(parsed.value).length
  const shown = Math.min(total, maxJsonRows)
  return jsonPanelHeader + jsonPanelPadding + (shown + (total > shown ? 1 : 0)) * jsonLineHeight
}

const LogRow = memo(function LogRow({
  entry
  , native
  , expanded
  , onToggle
}: {
  entry: LogEntry
  native: boolean
  expanded: boolean
  onToggle: (entry: LogEntry) => void
}) {
  const {t} = useTranslation()
  const parsed = useMemo(() => parseLogJson(entry.message), [entry.message])
  const summary = useMemo(() => (parsed ? summarizeLogJson(parsed) : null), [parsed])
  // 只在真的展开时摊平：折叠态的 JSON 只需要标题那几个字段
  const rows = useMemo(() => (expanded && parsed ? flattenLogJson(parsed.value) : []), [expanded, parsed])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!parsed || (event.key !== 'Enter' && event.key !== ' ')) {
      return
    }

    event.preventDefault()
    onToggle(entry)
  }

  return (
    <div
      className={`${classes.rowWrapper} log-${entry.priorityLabel}`}
      data-priority={entry.priorityLabel}
      data-structured={parsed ? '' : undefined}
    >
      <div
        className={classes.row}
        role={parsed ? 'button' : undefined}
        tabIndex={parsed ? 0 : undefined}
        aria-expanded={parsed ? expanded : undefined}
        title={entry.message}
        onClick={parsed ? () => onToggle(entry) : undefined}
        onKeyDown={parsed ? onKeyDown : undefined}
      >
        <span className={classes.cell}>
          <Badge
            size='xs'
            radius='sm'
            fullWidth
            variant={entry.priorityLabel === 'Fatal' ? 'filled' : 'light'}
            color={priorityColors[entry.priorityLabel] || 'gray'}
          >
            {entry.priorityLabel}
          </Badge>
        </span>
        <span className={cellClass(classes.dim)}>{entry.dateLabel}</span>
        {native && (
          <>
            <span className={cellClass(classes.dim, classes.number)}>{entry.pid}</span>
            <span className={cellClass(classes.dim, classes.number)}>{entry.tid}</span>
            <span className={cellClass(classes.tag)} title={entry.tag}>{entry.tag}</span>
          </>
        )}
        <span className={cellClass(classes.message)}>
          {summary ?
            <span className={classes.summary}>
              {summary.prefix && <span className={classes.prefix}>{summary.prefix}</span>}
              {summary.title && <span className={classes.chip}>{summary.title}</span>}
              {summary.pairs.map((pair) => (
                <span key={pair.key} className={classes.pair}>
                  <span className={classes.pairKey}>{pair.key}</span>
                  <span className={classes.pairValue}>{pair.value}</span>
                </span>
              ))}
              <IconChevronRight size={13} className={classes.chevron} data-open={expanded || undefined} />
            </span> :
            entry.message}
        </span>
      </div>
      {expanded && parsed && (
        <div className={classes.detail} onClick={(event) => event.stopPropagation()}>
          <div className={classes.detailHeader}>
            <span className={classes.detailTitle} title={entry.message}>
              {parsed.prefix || t('JSON')}
            </span>
            <CopyButton value={entry.message} />
          </div>
          <dl className={classes.jsonGrid}>
            {rows.slice(0, maxJsonRows).map((row, index) => (
              <Fragment key={`${row.key}-${index}`}>
                <dt className={classes.jsonKey} data-kind={row.kind} style={{paddingLeft: 10 + row.depth * 14}}>
                  {row.key}
                </dt>
                <dd className={classes.jsonValue} data-kind={row.kind}>{row.value}</dd>
              </Fragment>
            ))}
            {rows.length > maxJsonRows && (
              <>
                <dt className={classes.jsonKey}>…</dt>
                <dd className={classes.jsonValue}>{t('+{{count}} more', {count: rows.length - maxJsonRows})}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  )
})

function findEntryIndex(entries: LogEntry[], id: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (entries[middle]!.id < id) {
      low = middle + 1
    }
    else {
      high = middle
    }
  }
  return low
}

/** offsets 为每行顶边的累计高度，二分找出 scrollTop 落在第几行 */
function findRowAtOffset(offsets: Float64Array, top: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle]! <= top) {
      low = middle
    }
    else {
      high = middle - 1
    }
  }
  return low
}

export function LogTable({entries, native, follow, onFollowChange, empty}: {
  entries: LogEntry[]
  native: boolean
  follow: boolean
  onFollowChange: (follow: boolean) => void
  empty: ReactNode
}) {
  const {t} = useTranslation()
  const viewportRef = useRef<HTMLDivElement>(null)
  const latest = useRef({entries, follow, onFollowChange})
  const anchor = useRef<{id: number, offset: number} | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  // 只记展开的行额外占了多高：JSON 解析因此只发生在真正展开的那几行上
  const [expanded, setExpanded] = useState<Record<number, number>>({})
  const keepAnchor = useRef(false)

  latest.current = {entries, follow, onFollowChange}

  // 展开的行更高，前缀和得跟着变，否则滚动条会和内容对不上
  const offsets = useMemo(() => {
    const acc = new Float64Array(entries.length + 1)
    for (let index = 0; index < entries.length; index++) {
      acc[index + 1] = acc[index]! + rowHeight + (expanded[entries[index]!.id] || 0)
    }

    return acc
  }, [entries, expanded])

  const toggle = useCallback((entry: LogEntry) => {
    const parsed = parseLogJson(entry.message)
    if (!parsed) {
      return
    }

    // 展开会把下面的行顶下去，这一轮得按锚点回原处，不能顺手甩到底部
    keepAnchor.current = true
    setExpanded((current) => {
      if (current[entry.id]) {
        const next = {...current}
        delete next[entry.id]
        return next
      }

      return {...current, [entry.id]: detailHeight(parsed)}
    })
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return undefined
    }

    const observer = new ResizeObserver(() => setHeight(viewport.clientHeight))
    observer.observe(viewport)
    setHeight(viewport.clientHeight)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    if (follow && !keepAnchor.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
    else if (anchor.current) {
      const target = offsets[findEntryIndex(entries, anchor.current.id)]! + anchor.current.offset
      if (Math.abs(viewport.scrollTop - target) >= 1) {
        viewport.scrollTop = target
      }
    }

    keepAnchor.current = false
    setScrollTop(viewport.scrollTop)
  }, [entries, follow, height, expanded, offsets])

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget
    const top = viewport.scrollTop
    const index = findRowAtOffset(offsets, top)
    const current = latest.current
    const entry = current.entries[index]
    anchor.current = entry ? {id: entry.id, offset: top - offsets[index]!} : null
    setScrollTop(top)
    const atBottom = viewport.scrollHeight - top - viewport.clientHeight < rowHeight / 2
    if (atBottom !== current.follow) {
      current.onFollowChange(atBottom)
    }
  }

  const start = Math.max(0, findRowAtOffset(offsets, scrollTop) - overscan)
  const end = Math.min(entries.length, findRowAtOffset(offsets, scrollTop + height) + overscan)
  const style = {
    '--log-columns': native ? nativeColumns : webColumns
    , '--log-row-height': `${rowHeight}px`
    , '--json-line-height': `${jsonLineHeight}px`
  }

  return (
    <div className={`${classes.table} stf-logcat-table`} style={style as CSSProperties}>
      <div className={`${classes.viewport} console-message-text selectable`} ref={viewportRef} onScroll={onScroll}>
        <div className={classes.header}>
          <span className={classes.cell}>{t('Level')}</span>
          <span className={classes.cell}>{t('Time')}</span>
          {native && (
            <>
              <span className={cellClass(classes.number)}>{t('PID')}</span>
              <span className={cellClass(classes.number)}>{t('TID')}</span>
              <span className={classes.cell}>{t('Tag')}</span>
            </>
          )}
          <span className={classes.cell}>{t('Text')}</span>
        </div>
        <div className={classes.sizer} style={{height: offsets[entries.length]}}>
          <div style={{transform: `translateY(${offsets[start]}px)`}}>
            {entries.slice(start, end).map((entry) => (
              <LogRow
                key={entry.id}
                entry={entry}
                native={native}
                expanded={Boolean(expanded[entry.id])}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      </div>
      {entries.length === 0 && <div className={classes.empty}>{empty}</div>}
    </div>
  )
}
