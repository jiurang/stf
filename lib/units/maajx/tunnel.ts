/**
* adb 反向隧道：把设备上的 127.0.0.1:<port> 接到本单元
*
* 为什么是 reverse 而不是 forward：设备上的 App 只认自己本机的固定端口，它不知道
* STF 在哪、也不需要知道。reverse 在设备侧开监听，流量原路送回本机，于是这一层
* 完全不碰文件系统 —— 目录属主、文件权限、应用 uid 都不参与。
*
* 隧道活不过设备重启：它只存在于 adb server 的内存与设备侧 adbd 的监听里。所以
* 「设备重新上线」就是唯一正确的重建时机，也就是 tracker 的 add 事件，不另设
* 定时器。设备掉线时 adb 会自己收走隧道，这里只需把串号忘掉。
*/

import cp from 'child_process'
import adbutil from '../../util/adbutil.js'
import logger from '../../util/logger.js'

type Logger = ReturnType<typeof logger.createLogger>

export interface TunnelOptions {
  /** 同一个端口既是设备侧的监听口，也是本单元的监听口 */
  port: number
  adbHost: string
  adbPort: number
}

export class TunnelManager {
  private log: Logger
  private options: TunnelOptions
  private adb: ReturnType<typeof adbutil>
  private tracker: {end?: () => void} | null = null
  /** 已经建好隧道的串号；设备上报属性变化会反复触发 change，别重复建 */
  private connected = new Set<string>()
  private adbMissing = false

  constructor(log: Logger, options: TunnelOptions) {
    this.log = log
    this.options = options
    this.adb = adbutil({
      adbHost: options.adbHost
    , adbPort: options.adbPort
    })
  }

  track() {
    var self = this
    this.adb.trackDevices().then(function(tracker) {
      self.tracker = tracker as unknown as {end?: () => void}
      tracker.on('add', function(device) {
        self.onDeviceUp(String(device.id))
      })
      tracker.on('change', function(device) {
        self.onDeviceUp(String(device.id))
      })
      tracker.on('remove', function(device) {
        self.onDeviceDown(String(device.id))
      })
      self.log.info('Watching ADB devices, cloud tunnels on tcp:%d', self.options.port)
    })
    .catch(function(err) {
      self.log.warn('Unable to track ADB devices, no cloud tunnels will be set up: %s', err.message)
    })
  }

  dispose() {
    var self = this
    var tracker = this.tracker
    this.tracker = null
    var serials = Array.from(this.connected)
    this.connected.clear()
    serials.forEach(function(serial) {
      // 撤不干净也不要紧：设备下次上线会重建，只是这段时间白占一个监听口
      runAdb(self.options, ['reverse', '--remove', 'tcp:' + self.options.port])
      .catch(function() {
        self.log.info('device %s: cloud tunnel left behind, rebuilt on reconnect', serial)
      })
    })
    if (tracker && tracker.end) {
      try {
        tracker.end()
      }
      catch (err) {
        // 已经断了：忽略
      }
    }
  }

  private onDeviceUp(serial: string) {
    if (!serial || this.connected.has(serial) || this.adbMissing) {
      return
    }
    var self = this
    this.reverse(serial).then(function() {
      self.connected.add(serial)
      self.log.info('device %s: cloud tunnel up on tcp:%d', serial, self.options.port)
    })
    .catch(function(err) {
      // 设备刚被列出来时可能还没就绪，失败就留给下一次 change/上线再试
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        self.adbMissing = true
        self.log.fatal('adb executable not found, cloud tunnels are disabled')
        return
      }
      self.log.warn('device %s: cannot set up cloud tunnel: %s', serial, err.message)
    })
  }

  private onDeviceDown(serial: string) {
    if (this.connected.delete(serial)) {
      this.log.info('device %s: cloud tunnel gone with the device', serial)
    }
  }

  private reverse(serial: string) {
    var opts = this.options
    return runAdb(opts, [
        '-s', serial
      , 'reverse'
      , 'tcp:' + opts.port
      , 'tcp:' + opts.port
      ])
  }
}

/** 跑一条 adb 命令；非零退出码带上 stderr，方便在日志里看出「设备还没就绪」这类原因 */
function runAdb(opts: TunnelOptions, args: string[]) {
  return new Promise<void>(function(resolve, reject) {
    var proc = cp.spawn('adb', [
        '-H', opts.adbHost
      , '-P', String(opts.adbPort)
    , ...args
    ])
    var stderr: Buffer[] = []
    proc.stderr.on('data', function(data) {
      stderr.push(data)
    })
    proc.on('error', function(err) {
      reject(err)
    })
    proc.on('close', function(code, signal) {
      if (signal) {
        reject(new Error('adb exited with signal ' + signal))
      }
      else if (code === 0) {
        resolve()
      }
      else {
        var detail = Buffer.concat(stderr).toString().trim()
        reject(new Error('adb exited with status ' + code + (detail ? ': ' + detail : '')))
      }
    })
  })
}
