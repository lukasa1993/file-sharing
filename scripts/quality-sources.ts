export const critical =
  /^(?:server\.ts$|scripts\/(ops|storage-inventory)\.ts$|shared\/|cloudflare\/(api|catalog|identity|mail|r2|sharing|transfers|worker)\.ts$|app\/(application|config|filesystem|http|identity|inspection|metadata|operations|proxy|router|runtime|security|shares|state-lease|transfers|transport)(?:\/|\.))/
const production =
  /^(?:(?:app|shared)\/.*\.[cm]?[jt]sx?|public\/.*\.[cm]?js|cloudflare\/(?!browser\/|tests\/|e2e\.config\.ts$).*\.[cm]?[jt]sx?)$/
export const qualityDirectories = [
  'app',
  'public',
  'shared',
  'cloudflare',
  'scripts',
  'tests',
]
export const qualityFiles = [
  'server.ts',
  'bun.lock',
  'package.json',
  'tsconfig.json',
  'tsconfig.cloudflare.json',
  'wrangler.jsonc',
  'e2e.config.ts',
]

export async function sourceFiles() {
  const files = ['server.ts', 'scripts/ops.ts', 'scripts/storage-inventory.ts']
  for (const folder of ['app', 'public', 'shared', 'cloudflare']) {
    for await (const entry of new Bun.Glob('**/*').scan({
      cwd: folder,
      onlyFiles: true,
    })) {
      const path = folder + '/' + entry
      if (production.test(path) && !path.endsWith('.d.ts')) files.push(path)
    }
  }
  return files.sort()
}
