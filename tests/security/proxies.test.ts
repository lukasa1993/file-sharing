import { expect, test } from 'bun:test'
import { trustedProxyPeers } from '../../app/proxy.ts'

const request = (chain?: string) =>
  new Request('http://localhost/', {
    headers: chain === undefined ? {} : { 'x-forwarded-for': chain },
  })

test('validates entire network addresses and accepts only decimal prefix lengths', () => {
  for (const entry of [
    '',
    'not-an-address',
    '/24',
    '192.0.2.4/24/0',
    '::1/128/',
  ]) {
    expect(() => trustedProxyPeers([entry])).toThrow(
      'Invalid trusted proxy address',
    )
  }
  for (const width of [
    '',
    ' ',
    ' 8',
    '8 ',
    '0x10',
    '1e1',
    '+1',
    '-1',
    '1.5',
    '33',
  ]) {
    expect(() => trustedProxyPeers(['192.0.2.4/' + width])).toThrow(
      'Invalid trusted proxy prefix',
    )
  }
  expect(() => trustedProxyPeers(['2001:db8::/129'])).toThrow(
    'Invalid trusted proxy prefix',
  )
  const outside = '198.51.100.9'
  const accept4 = trustedProxyPeers(['0.0.0.0/0'])
  expect(accept4('203.0.113.8', request(outside))).toBe(outside)
  for (const network of ['192.0.2.4', '192.0.2.4/32']) {
    const resolve = trustedProxyPeers([network])
    expect(resolve('192.0.2.4', request(outside))).toBe(outside)
    expect(resolve('192.0.2.5', request(outside))).toBe('192.0.2.5')
  }
  for (const network of ['2001:db8::1', '2001:db8::1/128']) {
    const resolve = trustedProxyPeers([network])
    expect(resolve('2001:db8::1', request(outside))).toBe(outside)
    expect(resolve('2001:db8::2', request(outside))).toBe('2001:db8::2')
  }
})

test('follows only known proxy hops and preserves the directly connected peer', () => {
  const resolve = trustedProxyPeers(['192.0.2.0/29', '2001:db8::/64'])
  const ip = '198.51.100.8'
  expect(resolve(undefined, request(ip))).toBeUndefined()
  expect(resolve('192.0.2.1', request())).toBe('192.0.2.1')
  expect(resolve('198.51.100.9', request(ip))).toBe('198.51.100.9')
  expect(resolve('::FFFF:192.0.2.7', request(ip))).toBe(ip)
  expect(resolve('::ffff:198.51.100.8', request())).toBe(ip)
  expect(resolve('::ffff:1:2', request())).toBe('::ffff:1:2')
  expect(resolve('ab:cd::192.0.2.4', request(ip))).toBe('ab:cd::192.0.2.4')
  expect(
    resolve(
      '2001:db8::1',
      request('203.0.113.7, 198.51.100.8, 192.0.2.3, 2001:db8::2'),
    ),
  ).toBe(ip)
  expect(resolve('2001:db8:1::1', request(ip))).toBe('2001:db8:1::1')
})

test('caps forwarded chains at sixteen hops and validates each trusted entry', () => {
  const resolve = trustedProxyPeers(['192.0.2.0/29'])
  const repeated = Array.from({ length: 16 }, () => '192.0.2.4')
  expect(
    resolve('198.51.100.8', request([...repeated, '192.0.2.7'].join(','))),
  ).toBe('198.51.100.8')
  expect(resolve('192.0.2.1', request(repeated.join(', ')))).toBe('192.0.2.4')
  expect(() =>
    resolve('192.0.2.1', request([...repeated, '192.0.2.5'].join(', '))),
  ).toThrow('Invalid proxy chain')
  expect(() => resolve('192.0.2.1', request('invalid'))).toThrow(
    'Invalid proxy address',
  )
})
