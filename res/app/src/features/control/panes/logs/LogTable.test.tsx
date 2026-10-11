import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import {MantineProvider} from '@mantine/core'
import {enhanceEntry, type LogcatMessage} from './logcat'
import {LogTable} from './LogTable'

// jsdom 缺这两样：一个给表格量视口，一个给 Mantine 判断配色方案
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false
    , media: query
    , onchange: null
    , addEventListener() {}
    , removeEventListener() {}
    , addListener() {}
    , removeListener() {}
    , dispatchEvent: () => false
  }))
})

afterEach(cleanup)

function entry(message: string, id: number, priority = 5) {
  const base: LogcatMessage = {
    serial: 'serial-1'
    , date: new Date(2024, 0, 1, 9, 5, 7, 42).getTime() / 1000
    , pid: 1234
    , tid: 1240
    , priority
    , tag: 'MaaFramework'
    , message
  }

  return enhanceEntry(base, id)
}

function mount(entries: ReturnType<typeof entry>[]) {
  return render(
    <MantineProvider>
      <LogTable
        entries={entries}
        native
        follow={false}
        onFollowChange={() => undefined}
        empty={<span>nothing</span>}
      />
    </MantineProvider>
  )
}

const structured = entry('{"task_id":1842,"type":"Task.Succeeded","detail":{"hit":128}}', 1)
const plain = entry('[PipelineTask.run] pipeline = 开始赚钱', 2)

describe('LogTable', () => {
  it('summarises a json message instead of dumping it', () => {
    mount([structured, plain])
    expect(screen.getByText('Task.Succeeded')).toBeTruthy()
    expect(screen.getByText('task_id')).toBeTruthy()
    expect(screen.queryByText(/task_id":1842/)).toBeNull()
    expect(screen.getByText('[PipelineTask.run] pipeline = 开始赚钱')).toBeTruthy()
  })

  it('expands into the key/value view and folds back', () => {
    mount([structured])
    const row = screen.getByRole('button')
    expect(screen.queryByText('hit')).toBeNull()

    fireEvent.click(row)
    expect(screen.getByText('hit')).toBeTruthy()
    expect(screen.getByText('128')).toBeTruthy()

    fireEvent.click(row)
    expect(screen.queryByText('hit')).toBeNull()
  })

  it('only expands the rows that carry json', () => {
    mount([plain])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('grows the sizer by the height of the expanded panel', () => {
    const {container} = mount([structured])
    const sizer = container.querySelector('[class*="sizer"]') as HTMLElement
    const closed = Number.parseInt(sizer.style.height, 10)
    expect(closed).toBe(22)

    fireEvent.click(screen.getByRole('button'))
    const open = Number.parseInt(sizer.style.height, 10)
    // 头部 28 + 上下留白 12 + 四行 20（detail/hit/task_id/type）
    expect(open).toBe(22 + 28 + 12 + 4 * 20)
  })
})
