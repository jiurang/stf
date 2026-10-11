import {memo, useMemo, useState} from 'react'
import {Button, Group, Loader, Select, Switch, Text, TextInput, Tooltip} from '@mantine/core'
import {
  IconDeviceFloppy
  , IconFilterOff
  , IconListDetails
  , IconPlayerPlayFilled
  , IconSearch
  , IconTrash
} from '@tabler/icons-react'
import type {Control} from '@/core/control'
import {useTranslation} from '@/core/i18n'
import {withErrorModal} from '@/ui/modals'
import {usePlatform} from '@/ui/modes'
import {NothingToShow} from '@/ui/NothingToShow'
import type {PaneProps} from '../../types'
import {
  filterEntries
  , isKeyOnly
  , isValidDateFilter
  , KEY_ONLY_PRIORITY
  , levelNumbers
  , PRIORITY_VERBOSE
  , type LogFilters
} from './logcat'
import {clearLogs, currentLogEntries, setLogFilter, startLogcat, stopLogcat, useDeviceLogs} from './logcat-store'
import {LogTable} from './LogTable'
import {openSaveLogModal} from './SaveLogModal'
import classes from './Logs.module.css'

const levelOptions = levelNumbers.map(({number, name}) => ({value: String(number), label: name}))

function levelName(priority: number): string {
  return levelNumbers.find((level) => level.number === priority)?.name || String(priority)
}

function EmptyState({total, started}: {total: number, started: boolean}) {
  const {t} = useTranslation()
  if (total > 0) {
    return <NothingToShow icon={<IconFilterOff size={28} />} message={t('No log entries match the filters')} />
  }
  if (started) {
    return <NothingToShow icon={<Loader size='sm' type='dots' />} message={t('Waiting for log entries')} />
  }
  return <NothingToShow icon={<IconListDetails size={28} />} message={t('Press Get to start logging')} />
}

const LogsToolbar = memo(function LogsToolbar({
  serial
  , control
  , started
  , filters
  , native
  , follow
  , onFollowChange
  , hasEntries
}: {
  serial: string
  control: Control
  started: boolean
  filters: LogFilters
  native: boolean
  follow: boolean
  onFollowChange: (follow: boolean) => void
  hasEntries: boolean
}) {
  const {t} = useTranslation()

  function toggleLogging() {
    if (started) {
      withErrorModal(() => stopLogcat(serial, control))
    }
    else {
      onFollowChange(true)
      withErrorModal(() => startLogcat(serial, control))
    }
  }

  function textFilter(key: Exclude<keyof LogFilters, 'priority'>, placeholder: string, width?: number) {
    return (
      <TextInput
        size='xs'
        name={key}
        w={width}
        className={width ? undefined : classes.grow}
        placeholder={placeholder}
        aria-label={placeholder}
        value={filters[key]}
        error={key === 'date' && !isValidDateFilter(filters.date)}
        leftSection={key === 'message' ? <IconSearch size={14} /> : undefined}
        onChange={(event) => setLogFilter(serial, key, event.currentTarget.value)}
      />
    )
  }

  return (
    <>
      <Group className={classes.toolbar} gap='xs'>
        <Tooltip label={t('Start/Stop Logging')}>
          <Button
            size='xs'
            variant={started ? 'filled' : 'light'}
            {...(started ? {color: 'red'} : {})}
            aria-pressed={started}
            leftSection={started ? <span className={classes.live} /> : <IconPlayerPlayFilled size={14} />}
            onClick={toggleLogging}
          >
            {started ? t('Stop') : t('Get')}
          </Button>
        </Tooltip>
        <Tooltip label={t('Hide Info and below, which bury the lines that matter')}>
          <Switch
            size='xs'
            label={t('只看关键')}
            checked={isKeyOnly(filters)}
            onChange={(event) => setLogFilter(
              serial
              , 'priority'
              , event.currentTarget.checked ? KEY_ONLY_PRIORITY : PRIORITY_VERBOSE
            )}
          />
        </Tooltip>
        <Select
          size='xs'
          w={112}
          name='priority'
          placeholder={t('Logcat Level')}
          aria-label={t('Logcat Level')}
          data={levelOptions}
          value={String(filters.priority)}
          allowDeselect={false}
          onChange={(value) => value && setLogFilter(serial, 'priority', Number(value))}
        />
        <Group gap='xs' ml='auto' wrap='nowrap'>
          <Switch
            size='xs'
            label={t('Auto Scroll')}
            checked={follow}
            onChange={(event) => onFollowChange(event.currentTarget.checked)}
          />
          <Button
            size='xs'
            variant='default'
            title={t('Clear')}
            disabled={!hasEntries}
            leftSection={<IconTrash size={14} />}
            onClick={() => clearLogs(serial)}
          >
            {t('Clear')}
          </Button>
          <Button
            size='xs'
            variant='default'
            title={t('Save Logs')}
            disabled={!hasEntries}
            leftSection={<IconDeviceFloppy size={14} />}
            onClick={() => openSaveLogModal(serial, currentLogEntries(serial))}
          >
            {t('Save Logs')}
          </Button>
        </Group>
      </Group>
      <Group className={classes.toolbar} gap='xs'>
        {textFilter('date', t('Time'), 112)}
        {native && textFilter('pid', t('PID'), 76)}
        {native && textFilter('tid', t('TID'), 76)}
        {native && textFilter('tag', t('Tag'), 140)}
        {textFilter('message', t('Text'))}
      </Group>
    </>
  )
})

export default function LogsPane({device, control}: PaneProps) {
  const {t} = useTranslation()
  const [platform] = usePlatform()
  const native = platform === 'native'
  const {serial} = device
  const {entries, started, filters} = useDeviceLogs(serial)
  const [follow, setFollow] = useState(true)
  const visible = useMemo(() => filterEntries(entries, filters, native), [entries, filters, native])
  const hidden = entries.length - visible.length

  return (
    <div className={`${classes.root} stf-logs`}>
      <LogsToolbar
        serial={serial}
        control={control}
        started={started}
        filters={filters}
        native={native}
        follow={follow}
        onFollowChange={setFollow}
        hasEntries={entries.length > 0}
      />
      <LogTable
        entries={visible}
        native={native}
        follow={follow}
        onFollowChange={setFollow}
        empty={<EmptyState total={entries.length} started={started} />}
      />
      <Group className={`${classes.footer} stf-logcat-counts`} gap={6} wrap='nowrap' justify='flex-end'>
        {hidden > 0 && (
          <>
            <Text className={classes.footerText}>
              {t('{{shown}} of {{total}} shown · {{hidden}} below {{level}} hidden', {
                shown: visible.length.toLocaleString()
                , total: entries.length.toLocaleString()
                , hidden: hidden.toLocaleString()
                , level: levelName(filters.priority)
              })}
            </Text>
            <Button
              size='compact-xs'
              variant='subtle'
              onClick={() => setLogFilter(serial, 'priority', PRIORITY_VERBOSE)}
            >
              {t('Show all')}
            </Button>
          </>
        )}
        {hidden === 0 && (
          <Text className={classes.footerText}>{entries.length.toLocaleString()}</Text>
        )}
      </Group>
    </div>
  )
}
