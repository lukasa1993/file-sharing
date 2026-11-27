import { BlockList, isIP } from 'node:net'
import { AppError } from './contracts.ts'

function normalize(ip: string) {
  return ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4
    ? ip.slice(7)
    : ip
}
export function trustedProxyPeers(ranges: readonly string[]) {
  const allowed = new BlockList()
  for (const range of ranges) {
    const [address, width, extra] = range.split('/')
    if (!address || extra !== undefined || !isIP(address))
      throw new Error('Invalid trusted proxy address')
    const bits = isIP(address) === 4 ? 32 : 128
    const length = width === undefined ? bits : Number(width)
    if (
      width === '' ||
      (width !== undefined && /\D/.test(width)) ||
      length > bits
    )
      throw new Error('Invalid trusted proxy prefix')
    allowed.addSubnet(address, length, bits === 32 ? 'ipv4' : 'ipv6')
  }
  function trusted(ip: string) {
    return allowed.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')
  }
  return (
    socketPeer: string | undefined,
    request: Request,
  ): string | undefined => {
    if (!socketPeer) return undefined
    let peer = normalize(socketPeer)
    if (!trusted(peer)) return peer
    const header = request.headers.get('x-forwarded-for')
    if (!header) return peer
    const hops = header.split(',')
    if (hops.length > 16) throw new AppError(400, 'Invalid proxy chain')
    for (const item of hops.reverse()) {
      if (!trusted(peer)) break
      const ip = normalize(item.trim())
      if (!isIP(ip)) throw new AppError(400, 'Invalid proxy address')
      peer = ip
    }
    return peer
  }
}
