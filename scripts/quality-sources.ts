export const critical =
  /^(?:server\.ts$|scripts\/(ops|storage-inventory)\.ts$|app\/(application|config|filesystem|http|identity|inspection|metadata|operations|proxy|router|runtime|security|shares|state-lease|transfers|transport)(?:\/|\.))/
const production = /^(app\/.*\.[cm]?[jt]sx?|public\/.*\.[cm]?js|server\.ts)$/

export async function sourceFiles() {
  const files = ['server.ts', 'scripts/ops.ts', 'scripts/storage-inventory.ts']
  for (const folder of ['app', 'public']) {
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
