import { checkAccount, deploymentAccount, pack } from './cloud-preflight'
const mode = Bun.argv.slice(2).join(' ')
if (!['', '--prepare', '--check'].includes(mode))
  throw new Error(
    'Use cloud:deploy, cloud:deploy --check, or cloud:deploy --prepare.',
  )
const settings = deploymentAccount(mode === '--prepare')
await pack(settings, false)
await checkAccount(settings, mode === '--prepare')
if (!mode) await pack(settings, true)
else if (!settings.access)
  console.log(
    'New private bucket prepared. Create the bucket-scoped S3 credential and run cloud:deploy --check.',
  )
else
  console.log(
    'Cloudflare prerequisites verified. No Worker version or routes were published.',
  )
