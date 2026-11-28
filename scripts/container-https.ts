import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run the image's operator CLI and production entry point, with a local trusted TLS endpoint.
const image = process.env.LSHARE_IMAGE || 'fileserver:check'
const nginx = process.env.NGINX_BIN || 'nginx'
// Rootless Docker on some hosts publishes TCP ports in a different network namespace.
const privateSocket = process.env.LSHARE_PROXY_SOCKET === '1'
const emulator = process.env.QEMU_AARCH64
const architecture = emulator
  ? [
      '--platform',
      'linux/arm64',
      '--mount',
      'type=bind,src=' + emulator + ',dst=/qemu,readonly',
    ]
  : []
const execute = (program: string) =>
  emulator
    ? ['--entrypoint', '/qemu', image, program]
    : ['--entrypoint', program, image]
const base = await mkdtemp(join(tmpdir(), 'lshare-https-'))
const name = 'lshare-tls-' + randomUUID()
const volume = name + '-storage'
let proxy: ReturnType<typeof Bun.spawn> | undefined

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(command[0] + ' failed: ' + errors.trim())
  return output.trim()
}

function csrf(html: string) {
  const value = /<meta\b[^>]*name="csrf-token"[^>]*content="([^"]+)"/.exec(
    html,
  )?.[1]
  assert.ok(value, 'Missing CSRF token on the rendered page')
  return value
}

function session(response: Response) {
  const header = response.headers.getSetCookie()[0]
  assert.ok(
    header && /;\s*Secure\b/i.test(header) && /;\s*HttpOnly\b/i.test(header),
  )
  return header.split(';')[0] || ''
}

try {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
  const port = probe.port
  probe.stop(true)
  const origin = 'https://127.0.0.1:' + port
  await run([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=lshare-local-test',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-out',
    join(base, 'cert.pem'),
    '-keyout',
    join(base, 'key.pem'),
  ])
  if (privateSocket) await mkdir(join(base, 'relay'), { mode: 0o700 })
  const ca = await readFile(join(base, 'cert.pem'), 'utf8')
  await run(['docker', 'volume', 'create', volume])
  const volumeMount = [
    '--mount',
    'type=volume,src=' + volume + ',dst=/acceptance',
  ]
  const restricted = [
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
  ]
  // Grant ownership of the new, empty test volume to the production UID.
  await run([
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    ...restricted,
    '--cap-add',
    'CHOWN',
    '--user',
    '0',
    ...volumeMount,
    ...architecture,
    ...execute('/usr/bin/chown'),
    '1000:1000',
    '/acceptance',
  ])
  const operator = [
    'docker',
    'run',
    '--rm',
    '--network',
    'none',
    ...restricted,
    ...volumeMount,
    ...architecture,
    ...execute('/usr/local/bin/bun'),
  ]
  await run([
    ...operator,
    'scripts/ops.ts',
    'init',
    '/acceptance/state',
    'tls-owner',
    '--container',
  ])
  const { password } = JSON.parse(
    await run([
      ...operator,
      '-e',
      "console.log(await Bun.file('/acceptance/state/config/bootstrap.json').text())",
    ]),
  ) as { password: string }
  const mount = (from: string, to: string, readonly = false) => [
    '--mount',
    'type=volume,src=' +
      volume +
      ',volume-subpath=state/' +
      from +
      ',dst=' +
      to +
      (readonly ? ',readonly' : ''),
  ]
  const gateway = await run([
    'docker',
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ])
  await run([
    'docker',
    'run',
    '-d',
    '--name',
    name,
    ...restricted,
    '--tmpfs',
    '/tmp:rw,nodev,nosuid,noexec',
    ...(privateSocket
      ? ['--mount', 'type=bind,src=' + join(base, 'relay') + ',dst=/relay']
      : ['-p', '127.0.0.1::8080']),
    '-e',
    'PUBLIC_ORIGIN=' + origin,
    '-e',
    'TRUSTED_PROXY_CIDRS=' + (privateSocket ? '127.0.0.1' : gateway),
    ...mount('config', '/etc/fileserver', true),
    ...mount('data', '/var/lib/fileserver'),
    ...mount('storage', '/srv/files'),
    ...architecture,
    ...(emulator
      ? [...execute('/usr/local/bin/bun'), 'run', 'dist/app/server.js']
      : [image]),
  ])
  let upstream: string
  if (privateSocket) {
    // Pass unchanged HTTP over a private socket to the container's actual TCP listener.
    await run([
      'docker',
      'exec',
      '-d',
      name,
      ...(emulator ? ['/qemu'] : []),
      '/usr/local/bin/bun',
      '-e',
      `import {createServer,connect} from 'node:net';
      createServer(client => {
        const server = connect(8080, '127.0.0.1');
        client.on('error', () => server.destroy()); server.on('error', () => client.destroy());
        client.on('close', () => server.destroy()); server.on('close', () => client.destroy());
        client.pipe(server).pipe(client);
      }).listen('/relay/backend.sock')`,
    ])
    upstream = 'unix:' + join(base, 'relay/backend.sock') + ':'
  } else {
    upstream = await run(['docker', 'port', name, '8080/tcp'])
    assert.match(upstream, /^127\.0\.0\.1:\d+$/)
  }
  await writeFile(
    join(base, 'nginx.conf'),
    `
worker_processes 1;
pid nginx.pid;
error_log nginx-error.log error;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path client_temp;
  proxy_temp_path proxy_temp;
  fastcgi_temp_path fastcgi_temp;
  uwsgi_temp_path uwsgi_temp;
  scgi_temp_path scgi_temp;
  server {
    listen 127.0.0.1:${port} ssl;
    ssl_certificate cert.pem;
    ssl_certificate_key key.pem;
    location / {
      proxy_pass http://${upstream};
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_request_buffering off;
      proxy_buffering off;
      gzip off;
    }
  }
}`,
  )
  proxy = Bun.spawn(
    [
      nginx,
      '-e',
      'stderr',
      '-p',
      base + '/',
      '-c',
      'nginx.conf',
      '-g',
      'daemon off;',
    ],
    { stdout: 'ignore', stderr: 'inherit' },
  )
  const request = (path: string, init: RequestInit = {}) => {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin)
    return fetch(url, {
      ...init,
      redirect: 'manual',
      tls: { ca },
      signal: AbortSignal.timeout(10_000),
    })
  }
  let ready = false
  for (let attempt = 0; attempt < (emulator ? 480 : 120); attempt++) {
    if (proxy.exitCode !== null)
      throw new Error('NGINX stopped before readiness')
    const response = await request('/readyz').catch(() => undefined)
    if (response) {
      await response.body?.cancel()
      if (response.status === 200) {
        ready = true
        break
      }
    }
    await Bun.sleep(250)
  }
  if (!ready) {
    const errors = await readFile(join(base, 'nginx-error.log'), 'utf8')
    throw new Error(
      'Container readiness through TLS timed out. ' +
        errors.trim().split('\n').at(-1),
    )
  }
  const login = await request('/login')
  assert.ok(login.headers.get('strict-transport-security'))
  const authenticated = await request('/login', {
    method: 'POST',
    headers: { cookie: session(login), origin },
    body: new URLSearchParams({
      username: 'tls-owner',
      password,
      csrf: csrf(await login.text()),
    }),
  })
  assert.equal(authenticated.status, 303)
  const cookie = session(authenticated)
  const page = await request('/_/files?mount=files', { headers: { cookie } })
  const owner = { cookie, origin, 'X-CSRF-Token': csrf(await page.text()) }
  const protocol = { ...owner, 'Tus-Resumable': '1.0.0' }
  const data = randomBytes(130_123)
  const filename = 'handoff.bin'
  const created = await request('/_/uploads', {
    method: 'POST',
    headers: {
      ...protocol,
      'Upload-Length': String(data.length),
      'Upload-Metadata':
        'mount ' +
        Buffer.from('files').toString('base64') +
        ',filename ' +
        Buffer.from(filename).toString('base64'),
    },
  })
  assert.equal(created.status, 201)
  const path = created.headers.get('location')
  assert.ok(path)
  const split = 65_537
  for (const [start, end] of [
    [0, split],
    [split, data.length],
  ] as const) {
    const chunk = await request(path, {
      method: 'PATCH',
      headers: {
        ...protocol,
        'Upload-Offset': String(start),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: data.subarray(start, end),
    })
    assert.equal(chunk.status, 204)
    assert.equal(chunk.headers.get('upload-offset'), String(end))
    if (!start) {
      const head = await request(path, { method: 'HEAD', headers: protocol })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('upload-offset'), String(split))
    }
  }
  const shared = await request('/_/api/v1/shares', {
    method: 'POST',
    headers: { ...owner, 'content-type': 'application/json' },
    body: JSON.stringify({
      targets: [{ mountId: 'files', segments: [filename] }],
      alias: 'tls-handoff',
      access: 'public',
      confirmPublic: true,
      mode: 'direct',
    }),
  })
  assert.equal(shared.status, 201)
  const share = (await shared.json()) as { id: string }
  const head = await request('/tls-handoff', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(data.length))
  const etag = head.headers.get('etag')
  assert.ok(etag && !etag.startsWith('W/'))
  assert.match(head.headers.get('content-disposition') || '', /handoff\.bin/)
  for (const [start, end] of [
    [0, split],
    [split, data.length],
  ] as const) {
    const response = await request('/tls-handoff', {
      headers: { range: 'bytes=' + start + '-' + (end - 1), 'if-range': etag },
    })
    assert.equal(response.status, 206)
    assert.equal(
      response.headers.get('content-range'),
      'bytes ' + start + '-' + (end - 1) + '/' + data.length,
    )
    assert.equal(response.headers.get('content-length'), String(end - start))
    assert.equal(response.headers.get('content-encoding'), null)
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      data.subarray(start, end),
    )
  }
  assert.equal(
    (
      await request('/_/api/v1/shares/' + share.id, {
        method: 'DELETE',
        headers: owner,
      })
    ).status,
    204,
  )
  assert.equal((await request('/tls-handoff')).status, 404)
  console.log(
    'Verified container operator, TLS login and cookie, resumable upload, recipient ranges, original bytes and revocation through NGINX.',
  )
} finally {
  if (proxy) {
    proxy.kill()
    await proxy.exited
  }
  await run(['docker', 'rm', '-f', name]).catch(() => undefined)
  await run(['docker', 'volume', 'rm', volume]).catch(() => undefined)
  await rm(base, { recursive: true, force: true })
}
