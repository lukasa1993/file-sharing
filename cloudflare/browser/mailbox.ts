import { watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type Mailbox = 'owner' | 'sender'

export function addressFor(mailbox: Mailbox) {
  const raw = process.env.E2E_APP_URL
  if (!raw)
    throw new Error('Start the disposable Cloudflare fixture to run this test.')
  return 'cloud-' + mailbox + '-' + new URL(raw).port + '@example.test'
}

async function latestCode(directory: string, address: string) {
  const messages: { code: string; at: number }[] = []
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue
    const file = join(directory, name)
    const delivery: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (
      !delivery ||
      typeof delivery !== 'object' ||
      !('to' in delivery) ||
      delivery.to !== address ||
      !('text' in delivery) ||
      typeof delivery.text !== 'string'
    )
      continue
    const code = delivery.text.match(/\b[0-9]{8}\b/)?.[0]
    if (code) messages.push({ code, at: (await stat(file)).mtimeMs })
  }
  return messages.sort((a, b) => b.at - a.at)[0]?.code
}

export async function readVerificationCode(mailbox: Mailbox) {
  const directory = process.env.E2E_MAIL_SPOOL
  if (!directory)
    throw new Error('The disposable fixture must provide a private mail spool.')
  const address = addressFor(mailbox)
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      watcher.close()
      clearTimeout(deadline)
    }
    const check = () => {
      latestCode(directory, address)
        .then((code) => {
          if (code) {
            cleanup()
            resolve(code)
          }
        })
        .catch((error: unknown) => {
          cleanup()
          reject(error)
        })
    }
    // fs.watch registers synchronously. A delivery during the initial scan triggers a second scan.
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null || filename.endsWith('.json')) check()
    })
    const deadline = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          'The verification email did not arrive in the disposable mailbox.',
        ),
      )
    }, 20000)
    watcher.on('error', (error) => {
      cleanup()
      reject(error)
    })
    check()
  })
}
