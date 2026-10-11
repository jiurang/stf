import {useEffect, useMemo, useRef, useState} from 'react'
import {
  Badge
, Button
, Group
, NumberInput
, ScrollArea
, Select
, Stack
, Switch
, Text
} from '@mantine/core'
import {
  IconCloudOff
, IconDeviceMobile
, IconListDetails
, IconPlayerPlayFilled
, IconPlayerStopFilled
, IconTrash
} from '@tabler/icons-react'
import {appState} from '@/core/app-state'
import {useTranslation} from '@/core/i18n'
import {NothingToShow} from '@/ui/NothingToShow'
import {WidgetCard} from '@/ui/WidgetCard'
import type {PaneProps} from '../../types'
import {
  claimDevice
, MAX_LOG_LINES
, MaajxConsole
, maajxEnabled
, type CommandResult
, type MaajxDevice
} from './maajx-console'
import classes from './MaajxPane.module.css'

const RESULT_LIMIT = 20

function useMaajxConsole(serial: string, enabled: boolean) {
  const [connected, setConnected] = useState(false)
  const [devices, setDevices] = useState<MaajxDevice[]>([])
  const [lines, setLines] = useState<string[]>([])
  const [results, setResults] = useState<CommandResult[]>([])
  const client = useRef<MaajxConsole | null>(null)
  const watching = useRef('')

  useEffect(() => {
    const base = appState.config.maajxUrl
    if (!enabled || !base) {
      return
    }

    const console = new MaajxConsole(base)
    client.current = console
    console.onConnectionChange = setConnected
    console.onDevices = setDevices
    console.onState = (deviceId, state) => {
      setDevices((current) => current.map((device) => (
        device.deviceId === deviceId ? {...device, state} : device
      )))
    }
    console.onLogs = (deviceId, incoming) => {
      // 服务端只推给正在观看的连接，但重连换设备时仍可能撞上旧的，挡一道
      if (deviceId !== watching.current) {
        return
      }

      setLines((current) => {
        const next = current.concat(incoming)
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      })
    }
    console.onCommandResult = (result) => {
      setResults((current) => [result, ...current].slice(0, RESULT_LIMIT))
    }
    console.start()

    return () => {
      console.stop()
      client.current = null
      watching.current = ''
    }
  }, [enabled])

  // STF 认设备靠 adb 串号，云控上报的 serial 对得上才是同一台机器
  const device = useMemo(() => claimDevice(devices, serial), [devices, serial])
  const deviceId = device?.deviceId || ''

  useEffect(() => {
    if (!deviceId) {
      return
    }

    watching.current = deviceId
    setLines([])
    client.current?.watch(deviceId)
  }, [deviceId])

  return {
    connected
  , devices
  , device
  , lines
  , results
  , setLines
  , command: (command: string, args?: Record<string, unknown>) => {
      if (deviceId) {
        client.current?.command(deviceId, command, args)
      }
    }
  , setLogEnabled: (logEnabled: boolean) => {
      if (deviceId) {
        client.current?.setLogEnabled(deviceId, logEnabled)
      }
    }
  }
}

function NotClaimed({serial, devices}: {serial: string, devices: MaajxDevice[]}) {
  const {t} = useTranslation()
  const known = devices.filter((device) => device.serial)
  return (
    <NothingToShow
      icon={<IconDeviceMobile size={30} />}
      message={t('This device has not registered with the cloud controller yet.')}
    >
      <Stack gap={4} align='center'>
        <Text size='xs' c='dimmed'>{t('ADB serial')}: <Text span ff='monospace'>{serial}</Text></Text>
        {known.length > 0 ?
          <Text size='xs' c='dimmed'>
            {t('Serials known to the cloud')}: {known.map((device) => device.serial).join(', ')}
          </Text> :
          <Text size='xs' c='dimmed'>{t('The cloud controller has no device registered yet.')}</Text>}
        <Text size='xs' c='dimmed'>
          {t('Make sure the app on this device has cloud control enabled and the serial matches adb.')}
        </Text>
      </Stack>
    </NothingToShow>
  )
}

export default function MaajxPane({device: stfDevice}: PaneProps) {
  const {t} = useTranslation()
  const enabled = maajxEnabled()
  const {connected, devices, device, lines, results, setLines, command, setLogEnabled} =
    useMaajxConsole(stfDevice.serial, enabled)
  const viewport = useRef<HTMLDivElement>(null)

  const [entry, setEntry] = useState<string | null>(null)
  const [shortSide, setShortSide] = useState<number | string>('')

  const state = device?.state
  const online = Boolean(device?.online)
  const tasks = state?.tasks || []
  const taskOptions = tasks.map((task) => ({value: task.entry, label: task.name || task.entry}))

  // 新日志到达时贴到底部，跟 logcat 面板一个习惯
  useEffect(() => {
    const node = viewport.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [lines])

  useEffect(() => {
    setEntry(state?.entry || null)
    setShortSide(state?.shortSide || '')
  }, [state?.entry, state?.shortSide])

  if (!enabled) {
    return (
      <NothingToShow
        icon={<IconCloudOff size={30} />}
        message={t('Cloud control is not enabled on this STF instance.')}
      />
    )
  }

  return (
    <div className={classes.root}>
      <WidgetCard
        title={t('MaaJx Cloud Control')}
        icon={IconDeviceMobile}
        color='grape'
        actions={(
          <Badge
            size='sm'
            variant='light'
            color={connected ? 'teal' : 'gray'}
          >
            {connected ? t('Connected') : t('Disconnected')}
          </Badge>
        )}
      >
        <Stack gap='sm'>
          <Group gap='xs'>
            <Badge size='sm' variant='light' color={online ? 'green' : 'red'}>
              {online ? t('Online') : t('Offline')}
            </Badge>
            {state?.running ?
              <Badge size='sm' variant='light' color='blue'>{t('Running')}</Badge> :
              <Badge size='sm' variant='light' color='gray'>{t('Idle')}</Badge>}
            {state?.status && <Text size='xs' c='dimmed'>{state.status}</Text>}
          </Group>

          <Group gap='xs' align='flex-end'>
            <Button
              size='compact-xs'
              leftSection={<IconPlayerPlayFilled size={14} />}
              disabled={!online || state?.running === true}
              onClick={() => command('start')}
            >
              {t('Start')}
            </Button>
            <Button
              size='compact-xs'
              color='red'
              leftSection={<IconPlayerStopFilled size={14} />}
              disabled={!online || !state?.running}
              onClick={() => command('stop')}
            >
              {t('Stop')}
            </Button>
          </Group>

          <Group gap='xs' align='flex-end' grow>
            <Select
              size='xs'
              label={t('Task')}
              placeholder={t('Task')}
              data={taskOptions}
              value={entry}
              disabled={!online || taskOptions.length === 0}
              onChange={(value) => {
                setEntry(value)
                if (value) {
                  command('setConfig', {entry: value})
                }
              }}
            />
            <NumberInput
              size='xs'
              label={t('Screenshot short side')}
              description={t('0 keeps the current value')}
              min={0}
              max={4096}
              value={shortSide}
              disabled={!online}
              onChange={setShortSide}
            />
            <Button
              size='compact-xs'
              variant='default'
              disabled={!online || shortSide === ''}
              onClick={() => {
                const value = Number(shortSide)
                if (value > 0) {
                  command('setConfig', {shortSide: value})
                }
              }}
            >
              {t('Apply')}
            </Button>
          </Group>

          <Switch
            size='xs'
            label={t('Receive logs from the cloud device')}
            checked={state?.logEnabled ?? true}
            disabled={!device}
            onChange={(event) => setLogEnabled(event.currentTarget.checked)}
          />
        </Stack>
      </WidgetCard>

      <WidgetCard
        title={t('Cloud Logs')}
        icon={IconListDetails}
        color='gray'
        actions={(
          <Button
            size='compact-xs'
            variant='default'
            leftSection={<IconTrash size={14} />}
            disabled={lines.length === 0}
            onClick={() => setLines([])}
          >
            {t('Clear')}
          </Button>
        )}
      >
        {results.length > 0 && (
          <Stack gap={2} mb='xs'>
            {results.map((result, index) => (
              <Text key={`${result.commandId}-${index}`} size='xs' c={result.ok ? 'teal' : 'red'}>
                {result.command} → {result.message}
              </Text>
            ))}
          </Stack>
        )}
        <ScrollArea className={classes.logScroll} viewportRef={viewport} type='auto'>
          {lines.length === 0 ?
            <Text size='xs' c='dimmed' ta='center' py='md'>
              {state?.logEnabled === false ?
                t('Log reception is off for this device') :
                t('Waiting for logs from the cloud device')}
            </Text> :
            lines.map((line, index) => (
              <div key={index} className={classes.line}>{line}</div>
            ))}
        </ScrollArea>
      </WidgetCard>

      {!device && devices.length >= 0 && (
        <NotClaimed serial={stfDevice.serial} devices={devices} />
      )}
    </div>
  )
}
