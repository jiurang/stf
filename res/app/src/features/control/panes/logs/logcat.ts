export interface LogcatMessage {
  serial: string
  date: number
  pid: number
  tid: number
  priority: number
  tag: string
  message: string
}

export interface LogEntry extends LogcatMessage {
  id: number
  dateLabel: string
  deviceLabel: string
  priorityLabel: string
}

export interface LogFilters {
  priority: number
  date: string
  pid: string
  tid: string
  tag: string
  message: string
}

export type LogExtension = 'json' | 'log'

export const logLevels = [
  'UNKNOWN'
  , 'DEFAULT'
  , 'VERBOSE'
  , 'DEBUG'
  , 'INFO'
  , 'WARN'
  , 'ERROR'
  , 'FATAL'
  , 'SILENT'
]

export const priorityLabels = logLevels.map((level) => level.charAt(0) + level.slice(1).toLowerCase())

export const levelNumbers = priorityLabels
  .map((name, number) => ({number, name}))
  .slice(2, 8)

/** logcat 优先级数值，2 是 Verbose，数字越大越严重 */
export const PRIORITY_VERBOSE = 2
export const PRIORITY_INFO = 4
export const PRIORITY_WARN = 5

/**
 * 「只看关键」的门槛
 *
 * 默认就压到 Warn：MaaFramework 这类长跑任务里 Info 及以下是纯噪声，
 * 一次任务能刷出几千条，等真正要看的 Error/Warn 出现时早就被顶出屏幕了。
 * 想看全随时一键放开，不必先去下拉框里翻。
 */
export const KEY_ONLY_PRIORITY = PRIORITY_WARN

export const defaultFilters: LogFilters = {
  priority: KEY_ONLY_PRIORITY
  , date: ''
  , pid: ''
  , tid: ''
  , tag: ''
  , message: ''
}

export const logExtensions: LogExtension[] = ['json', 'log']

export const logMimeTypes: Record<LogExtension, string> = {
  json: 'application/json;charset=utf-8'
  , log: 'text/plain;charset=utf-8'
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

export function enhanceEntry(data: LogcatMessage, id: number): LogEntry {
  const date = new Date(data.date * 1000)
  return {
    ...data
    , id
    , dateLabel: `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}` +
      `.${pad(date.getMilliseconds(), 3)}`
    , deviceLabel: 'Android'
    , priorityLabel: priorityLabels[data.priority] || priorityLabels[0]!
  }
}

type Matcher = (value: string) => boolean

export function stringMatcher(searchValue: string): Matcher {
  const content = searchValue.slice(1)
  switch (searchValue.charAt(0)) {
    case '/': {
      const lastSlash = content.lastIndexOf('/')
      if (lastSlash === -1) {
        return () => true
      }
      let regex: RegExp
      try {
        regex = new RegExp(content.substring(0, lastSlash), content.substring(lastSlash + 1))
      }
      catch {
        return () => true
      }
      return (value) => value.match(regex) !== null
    }
    case '!': {
      const excluded = content.toLowerCase()
      return (value) => value.toLowerCase().indexOf(excluded) === -1
    }
    default: {
      const included = searchValue.toLowerCase()
      return (value) => value.toLowerCase().indexOf(included) !== -1
    }
  }
}

export function sanitizePid(value: string): string {
  return value.replace(/[^0-9:]/g, '')
}

export function sanitizeTid(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

const datePattern = [
  '^(?:(?:([0-1]?\\d|2[0-3]):)?(:[0-5]\\d|[0-5]\\d):|\\d)'
  , '?(:[0-5]\\d|[0-5]\\d{1,2})?(\\.[0-9]?\\d{0,2}|:[0-5]?\\d{0,1})|(\\d{0,2})'
].join('')

export function isValidDateFilter(value: string): boolean {
  const matches = value.match(new RegExp(datePattern, 'g'))
  return Boolean(matches && matches.some((item) => item === value))
}

/** 当前是否处在「只看关键」档位，工具栏的开关据此亮着 */
export function isKeyOnly(filters: LogFilters): boolean {
  return filters.priority >= KEY_ONLY_PRIORITY
}

export function createEntryFilter(filters: LogFilters, native: boolean): (entry: LogEntry) => boolean {
  const checks: Array<(entry: LogEntry) => boolean> = []
  // 优先级是常驻条件：默认就压到 Warn，没有任何「不过滤」的档位可言。
  // 早先那条「没筛选就直接返回原数组」的捷径得拿掉 ——
  // 默认值本身就是有筛选的，走捷径等于把优先级下限整个跳过，绿色那批会照灌满表格。
  checks.push((entry) => entry.priority >= filters.priority)
  if (filters.date) {
    const matches = stringMatcher(filters.date)
    checks.push((entry) => matches(entry.dateLabel))
  }
  if (native && filters.pid) {
    const matches = stringMatcher(filters.pid)
    checks.push((entry) => matches(String(entry.pid)))
  }
  if (native && filters.tid) {
    const matches = stringMatcher(filters.tid)
    checks.push((entry) => matches(String(entry.tid)))
  }
  if (native && filters.tag) {
    const matches = stringMatcher(filters.tag)
    checks.push((entry) => matches(entry.tag))
  }
  if (filters.message) {
    const matches = stringMatcher(filters.message)
    checks.push((entry) => matches(entry.message))
  }
  return (entry) => checks.every((check) => check(entry))
}

export function filterEntries(entries: LogEntry[], filters: LogFilters, native: boolean): LogEntry[] {
  return entries.filter(createEntryFilter(filters, native))
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {[key: string]: JsonValue}

export interface ParsedLogJson {

  /** JSON 之前的那截前缀文字，可能是 '' */
  prefix: string
  value: JsonValue[] | {[key: string]: JsonValue}
}

/** 折叠行里先给结论的那几个字段，按「有多说明问题」排序 */
const TITLE_KEYS = ['type', 'level', 'tag', 'name']

/** 跟着结论走的补充字段，能命中就命中，命中不了就按原顺序取 */
const PAIR_KEYS = ['msg', 'message', 'entry', 'task_id', 'id', 'text']

function asStructured(value: unknown): ParsedLogJson['value'] | null {
  if (Array.isArray(value)) {
    return value as JsonValue[]
  }

  if (value !== null && typeof value === 'object') {
    return value as {[key: string]: JsonValue}
  }

  return null
}

function structured(parse: () => unknown): ParsedLogJson | null {
  try {
    const value = asStructured(parse())
    return value === null ? null : {prefix: '', value}
  }
  catch {
    // 不是 JSON：日志里本来就有大量带方括号的普通文本，认不出来就老实当文本渲染
    return null
  }
}

/**
 * 从一条日志正文里认出 JSON
 *
 * 两种形态都收：整条就是 JSON，以及「一句前缀 + 一段 JSON」。
 * 只认对象与数组 —— 裸的 `123` / `true` 格式化出来反而更难读。
 */
export function parseLogJson(message: string): ParsedLogJson | null {
  const text = message.trim()
  if (!text) {
    return null
  }

  const whole = structured(() => JSON.parse(text))
  if (whole) {
    return whole
  }

  const start = text.search(/[[{]/)
  if (start < 0) {
    return null
  }

  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end <= start) {
    return null
  }

  const embedded = structured(() => JSON.parse(text.slice(start, end + 1)))
  if (!embedded) {
    return null
  }

  return {prefix: text.slice(0, start).trim(), value: embedded.value}
}

/** 折叠成一行时的标量写法；容器只报规模，不把整段 JSON 塞回主表 */
function scalarText(value: JsonValue): string {
  if (value === null) {
    return 'null'
  }

  if (typeof value === 'object') {
    return Array.isArray(value) ? `${value.length} 项` : `${Object.keys(value).length} 个字段`
  }

  return String(value)
}

export interface LogSummary {
  prefix: string
  title: string | null
  pairs: Array<{key: string, value: string}>
}

/** 折叠行：一句话能说清是什么，剩下的才轮到键值对 */
export function summarizeLogJson(parsed: ParsedLogJson): LogSummary {
  if (Array.isArray(parsed.value)) {
    return {prefix: parsed.prefix, title: `${parsed.value.length} 项`, pairs: []}
  }

  const record = parsed.value
  const titleKey = TITLE_KEYS.find((key) => record[key] !== undefined && record[key] !== null)
  const rank = (key: string): number => {
    const index = PAIR_KEYS.indexOf(key)
    return index < 0 ? PAIR_KEYS.length : index
  }

  // 先记住原始次序再排序：sort 回调里拿不到还没赋值完的 keys
  const order = new Map(Object.keys(record).map((key, index) => [key, index]))
  const keys = Object.keys(record)
    .filter((key) => key !== titleKey)
    .sort((a, b) => rank(a) - rank(b) || order.get(a)! - order.get(b)!)

  return {
    prefix: parsed.prefix
    , title: titleKey === undefined ? null : scalarText(record[titleKey]!)
    , pairs: keys.slice(0, 3).map((key) => ({key, value: scalarText(record[key]!)}))
  }
}

export interface JsonRow {
  key: string
  value: string
  kind: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  depth: number
}

function rowKind(value: JsonValue): JsonRow['kind'] {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  return typeof value as JsonRow['kind']
}

/**
 * 展开后的键值视图：递归摊平
 *
 * 容器自己也占一行（写成 `{3}`），不然叶子字段飘在那儿看不出属于哪层。
 * 超过 maxDepth 就不再往下钻，就地转回 JSON 文本。
 */
export function flattenLogJson(value: ParsedLogJson['value'], maxDepth = 3): JsonRow[] {
  const rows: JsonRow[] = []

  const walk = (key: string, node: JsonValue, depth: number) => {
    const kind = rowKind(node)
    if (kind !== 'object' && kind !== 'array') {
      rows.push({key, value: scalarText(node), kind, depth})
      return
    }

    const children: Array<[string, JsonValue]> = kind === 'array' ?
      (node as JsonValue[]).map((item, index) => [`[${index}]`, item]) :
      Object.entries(node as {[key: string]: JsonValue})

    if (children.length === 0 || depth >= maxDepth) {
      rows.push({key, value: JSON.stringify(node), kind, depth})
      return
    }

    rows.push({key, value: kind === 'array' ? `[${children.length}]` : `{${children.length}}`, kind, depth})
    children.forEach(([childKey, child]) => walk(childKey, child, depth + 1))
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(`[${index}]`, item, 0))
  }
  else {
    Object.entries(value).forEach(([key, child]) => walk(key, child, 0))
  }

  return rows
}

export function formatLogs(
  serial: string
, entries: LogEntry[]
, extension: LogExtension
, lineLimit = entries.length
): string {
  const lines = entries.slice(0, Math.min(lineLimit, entries.length))
  if (extension === 'log') {
    return lines
      .map((line) => [line.date, line.pid, line.tag, line.priorityLabel, line.message].join('\t') + '\n')
      .join('')
  }
  return JSON.stringify({
    deviceOS: lines.length ? lines[0]!.deviceLabel : 'Android'
    , serial: lines.length ? lines[0]!.serial : serial
    , logs: lines.map((line) => ({
      date: line.date
      , pid: line.pid
      , tag: line.tag
      , priorityLabel: line.priorityLabel
      , message: line.message
    }))
  })
}

export function logFileName(serial: string, fileName: string, extension: LogExtension): string {
  return `${fileName || `${serial}_logs`}.${extension}`
}
