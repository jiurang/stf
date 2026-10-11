import {describe, expect, it} from 'vitest'
import {claimDevice, type MaajxDevice} from './maajx-console'

function device(serial: string, deviceId: string): MaajxDevice {
  return {
    deviceId
  , name: 'Redmi Note 13'
  , model: '23124RN87C'
  , serial
  , androidVersion: '14'
  , appVersion: 'v1.0.0'
  , online: true
  , lastSeenAt: 0
  , state: {
      deviceId
    , running: false
    , status: ''
    , entry: ''
    , shortSide: null
    , online: true
    , tasks: []
    , logEnabled: true
    }
  }
}

describe('claimDevice', () => {
  it('claims the device whose serial matches the adb serial', () => {
    const devices = [device('8d041652', 'dev-a'), device('9e10ff00', 'dev-b')]
    expect(claimDevice(devices, '9e10ff00')?.deviceId).toBe('dev-b')
  })

  it('never claims a device that reported no serial', () => {
    // 没取到 serial 的机器不该抢走任何一台 STF 设备
    const devices = [device('', 'dev-a'), device('', 'dev-b')]
    expect(claimDevice(devices, '')).toBeUndefined()
  })

  it('returns nothing when no serial matches', () => {
    expect(claimDevice([device('8d041652', 'dev-a')], 'deadbeef')).toBeUndefined()
    expect(claimDevice([], '8d041652')).toBeUndefined()
  })

  it('picks the first match when two devices report the same serial', () => {
    const devices = [device('8d041652', 'dev-a'), device('8d041652', 'dev-b')]
    expect(claimDevice(devices, '8d041652')?.deviceId).toBe('dev-a')
  })
})
