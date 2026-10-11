import {describe, expect, it} from 'vitest'
import {
  defaultFilters
  , enhanceEntry
  , filterEntries
  , flattenLogJson
  , formatLogs
  , isKeyOnly
  , isValidDateFilter
  , levelNumbers
  , logFileName
  , parseLogJson
  , PRIORITY_INFO
  , PRIORITY_VERBOSE
  , sanitizePid
  , sanitizeTid
  , stringMatcher
  , summarizeLogJson
  , type LogcatMessage
} from './logcat'

function message(overrides: Partial<LogcatMessage>): LogcatMessage {
  return {
    serial: 'serial-1'
    , date: new Date(2024, 0, 1, 9, 5, 7, 42).getTime() / 1000
    , pid: 1234
    , tid: 1240
    , priority: 4
    , tag: 'ActivityManager'
    , message: 'Start proc'
    , ...overrides
  }
}

const entries = [
  enhanceEntry(message({priority: 2, tag: 'Zygote', message: 'verbose line'}), 1)
  , enhanceEntry(message({priority: 3, pid: 77, tid: 78, message: 'debug line'}), 2)
  , enhanceEntry(message({priority: 5, tag: 'WindowManager', message: 'warn line'}), 3)
  , enhanceEntry(message({priority: 6, message: 'error line'}), 4)
]

describe('enhanceEntry', () => {
  it('labels the date and priority like LogcatService', () => {
    const entry = entries[1]!
    expect(entry.dateLabel).toBe('09:05:07.042')
    expect(entry.priorityLabel).toBe('Debug')
    expect(entry.deviceLabel).toBe('Android')
  })

  it('offers the Verbose to Fatal levels', () => {
    expect(levelNumbers.map((level) => level.name)).toEqual(['Verbose', 'Debug', 'Info', 'Warn', 'Error', 'Fatal'])
    expect(levelNumbers[0]!.number).toBe(2)
  })
})

describe('stringMatcher', () => {
  it('matches substrings case-insensitively', () => {
    expect(stringMatcher('activity')('ActivityManager')).toBe(true)
    expect(stringMatcher('zygote')('ActivityManager')).toBe(false)
  })

  it('negates with a leading bang', () => {
    expect(stringMatcher('!activity')('ActivityManager')).toBe(false)
    expect(stringMatcher('!zygote')('ActivityManager')).toBe(true)
  })

  it('supports regular expressions and ignores incomplete or invalid ones', () => {
    expect(stringMatcher('/^Act.*ger$/')('ActivityManager')).toBe(true)
    expect(stringMatcher('/^act/')('ActivityManager')).toBe(false)
    expect(stringMatcher('/^act/i')('ActivityManager')).toBe(true)
    expect(stringMatcher('/^act')('Zygote')).toBe(true)
    expect(stringMatcher('/([/')('Zygote')).toBe(true)
  })
})

describe('filterEntries', () => {
  /** 默认压到 Warn 之后，测别的条件时得先把优先级放开 */
  const all = {...defaultFilters, priority: PRIORITY_VERBOSE}

  it('hides Info and below by default so the lines that matter stay on screen', () => {
    expect(defaultFilters.priority).toBe(5)
    expect(filterEntries(entries, defaultFilters, true).map((entry) => entry.id)).toEqual([3, 4])
  })

  it('brings everything back on the verbose floor', () => {
    expect(filterEntries(entries, all, true)).toEqual(entries)
  })

  it('filters by minimum priority', () => {
    const result = filterEntries(entries, {...defaultFilters, priority: 6}, true)
    expect(result.map((entry) => entry.id)).toEqual([4])
  })

  it('treats the key-only switch as Warn and above', () => {
    expect(isKeyOnly(defaultFilters)).toBe(true)
    expect(isKeyOnly({...defaultFilters, priority: 6})).toBe(true)
    expect(isKeyOnly({...defaultFilters, priority: PRIORITY_INFO})).toBe(false)
    expect(isKeyOnly(all)).toBe(false)
  })

  it('filters by tag, pid, tid and text', () => {
    expect(filterEntries(entries, {...all, tag: 'window'}, true).map((entry) => entry.id)).toEqual([3])
    expect(filterEntries(entries, {...all, pid: '77'}, true).map((entry) => entry.id)).toEqual([2])
    expect(filterEntries(entries, {...all, tid: '78'}, true).map((entry) => entry.id)).toEqual([2])
    expect(filterEntries(entries, {...all, message: 'error'}, true).map((entry) => entry.id)).toEqual([4])
  })

  it('still filters by tag alongside the default priority floor', () => {
    expect(filterEntries(entries, {...defaultFilters, tag: 'window'}, true).map((entry) => entry.id)).toEqual([3])
  })

  it('ignores the native-only filters on the web platform', () => {
    expect(filterEntries(entries, {...all, tag: 'window'}, false)).toEqual(entries)
  })

  it('filters by time label', () => {
    expect(filterEntries(entries, {...all, date: '09:05'}, true)).toHaveLength(4)
    expect(filterEntries(entries, {...all, date: '10:'}, true)).toHaveLength(0)
  })
})

describe('parseLogJson', () => {
  it('takes a message that is entirely json', () => {
    expect(parseLogJson('{"task_id":7,"type":"Task.Succeeded"}')).toEqual({
      prefix: ''
      , value: {task_id: 7, type: 'Task.Succeeded'}
    })
  })

  it('keeps the text in front of an embedded object', () => {
    const parsed = parseLogJson('maafw notify: {"task_id":7,"type":"Task.Succeeded"}')
    expect(parsed!.prefix).toBe('maafw notify:')
    expect(parsed!.value).toEqual({task_id: 7, type: 'Task.Succeeded'})
  })

  it('ignores plain text, bare scalars and unparseable brackets', () => {
    expect(parseLogJson('')).toBeNull()
    expect(parseLogJson('[MaaFramework] node done')).toBeNull()
    expect(parseLogJson('123')).toBeNull()
    expect(parseLogJson('true')).toBeNull()
    expect(parseLogJson('java.lang.Foo{a=1}')).toBeNull()
  })
})

describe('summarizeLogJson', () => {
  it('leads with the type and keeps the fields worth knowing', () => {
    const parsed = parseLogJson('{"detail":"x","task_id":7,"type":"Task.Succeeded","entry":"daily","zzz":"dropped"}')!
    const summary = summarizeLogJson(parsed)
    expect(summary.title).toBe('Task.Succeeded')
    expect(summary.pairs).toEqual([
      {key: 'entry', value: 'daily'}
      , {key: 'task_id', value: '7'}
      , {key: 'detail', value: 'x'}
    ])
  })

  it('keeps the text in front of the json in the summary', () => {
    const summary = summarizeLogJson(parseLogJson('maafw notify: {"type":"Task.Succeeded"}')!)
    expect(summary.prefix).toBe('maafw notify:')
  })

  it('summarizes arrays by size', () => {
    const summary = summarizeLogJson(parseLogJson('[1,2,3]')!)
    expect(summary.title).toBe('3 项')
    expect(summary.pairs).toEqual([])
  })
})

describe('flattenLogJson', () => {
  it('keeps the nesting visible through the container rows', () => {
    const parsed = parseLogJson('{"outer":{"inner":{"leaf":1}}}')!
    const rows = flattenLogJson(parsed.value)
    expect(rows.map((row) => `${row.depth}:${row.key}`)).toEqual(['0:outer', '1:inner', '2:leaf'])
    expect(rows[0]!.value).toBe('{1}')
    expect(rows[2]!.kind).toBe('number')
  })

  it('keeps objects past the depth limit as one json blob', () => {
    const rows = flattenLogJson(parseLogJson('{"a":{"b":{"c":{"d":{"e":1}}}}}')!.value)
    expect(rows[rows.length - 1]).toEqual({key: 'd', value: '{"e":1}', kind: 'object', depth: 3})
  })
})

describe('input sanitizing', () => {
  it('keeps digits and colons in pid and digits in tid', () => {
    expect(sanitizePid('12a:3')).toBe('12:3')
    expect(sanitizeTid('12a:3')).toBe('123')
  })

  it('validates time filters', () => {
    expect(isValidDateFilter('')).toBe(true)
    expect(isValidDateFilter('09:05:07.042')).toBe(true)
    expect(isValidDateFilter('05:07')).toBe(true)
    expect(isValidDateFilter('abc')).toBe(false)
  })
})

describe('formatLogs', () => {
  it('writes tab separated lines for the log format', () => {
    const output = formatLogs('serial-1', entries, 'log')
    const lines = output.split('\n').filter(Boolean)
    expect(lines).toHaveLength(4)
    expect(lines[0]!.split('\t')).toEqual([String(entries[0]!.date), '1234', 'Zygote', 'Verbose', 'verbose line'])
  })

  it('writes the device and entries for the json format', () => {
    const output = JSON.parse(formatLogs('serial-1', entries, 'json'))
    expect(output.deviceOS).toBe('Android')
    expect(output.serial).toBe('serial-1')
    expect(output.logs[3]).toEqual({
      date: entries[3]!.date
      , pid: 1234
      , tag: 'ActivityManager'
      , priorityLabel: 'Error'
      , message: 'error line'
    })
  })

  it('clamps the sample to the collected lines', () => {
    expect(JSON.parse(formatLogs('serial-1', entries.slice(0, 2), 'json', 4)).logs).toHaveLength(2)
    expect(formatLogs('serial-1', entries.slice(0, 2), 'log', 4).split('\n').filter(Boolean)).toHaveLength(2)
    expect(JSON.parse(formatLogs('serial-1', entries, 'json', 3)).logs).toHaveLength(3)
  })

  it('writes valid json without entries', () => {
    expect(JSON.parse(formatLogs('serial-1', [], 'json'))).toEqual({deviceOS: 'Android', serial: 'serial-1', logs: []})
    expect(formatLogs('serial-1', [], 'log')).toBe('')
  })

  it('names the file after the serial unless a name is given', () => {
    expect(logFileName('serial-1', '', 'json')).toBe('serial-1_logs.json')
    expect(logFileName('serial-1', 'my-logs', 'log')).toBe('my-logs.log')
  })
})
