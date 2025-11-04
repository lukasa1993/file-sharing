#!/usr/bin/env bun
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

type RunResult = {
  code: number
  stdout: string
  stderr: string
}

const APP_NAME = process.env.APP_NAME && process.env.APP_NAME.length > 0 ? process.env.APP_NAME : 'file-sharing'
const BRANCH = process.env.BRANCH && process.env.BRANCH.length > 0 ? process.env.BRANCH : 'main'
const BUN_BIN = process.env.BUN_BIN && process.env.BUN_BIN.length > 0 ? process.env.BUN_BIN : 'bun'

// repoDir resolves to the repository root: scripts/.. -> .
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function log(message: string): void {
  const now = new Date().toISOString()
  console.log(`[${now}] ${message}`)
}

async function run(cmd: string, args: readonly string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const code = await proc.exited
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])

  return { code, stdout, stderr }
}

async function gitStatusPorcelain(): Promise<string> {
  const res = await run('git', ['status', '--porcelain'], repoDir)
  // If git errors (non-repo?), surface stderr to aid debugging
  if (res.code !== 0) throw new Error(`git status failed: ${res.stderr.trim()}`)
  return res.stdout
}

async function fetchBranch(branch: string): Promise<void> {
  const res = await run('git', ['fetch', 'origin', branch, '--prune'], repoDir)
  if (res.code !== 0) throw new Error(`git fetch failed: ${res.stderr.trim()}`)
}

async function revParse(ref: string): Promise<string> {
  const res = await run('git', ['rev-parse', ref], repoDir)
  if (res.code !== 0) throw new Error(`git rev-parse ${ref} failed: ${res.stderr.trim()}`)
  return res.stdout.trim()
}

async function checkout(branch: string): Promise<void> {
  const res = await run('git', ['checkout', branch], repoDir)
  if (res.code !== 0) throw new Error(`git checkout ${branch} failed: ${res.stderr.trim()}`)
}

async function hardReset(ref: string): Promise<void> {
  const res = await run('git', ['reset', '--hard', ref], repoDir)
  if (res.code !== 0) throw new Error(`git reset --hard ${ref} failed: ${res.stderr.trim()}`)
}

async function bunInstall(): Promise<void> {
  // Try frozen lockfile first
  let res = await run(BUN_BIN, ['install', '--frozen-lockfile'], repoDir)
  if (res.code !== 0) {
    log('bun install --frozen-lockfile failed, falling back to normal install')
    res = await run(BUN_BIN, ['install'], repoDir)
    if (res.code !== 0) throw new Error(`bun install failed: ${res.stderr.trim()}`)
  }
}

function resolvePm2Bin(): string {
  const local = path.join(repoDir, 'node_modules', '.bin', 'pm2')
  if (fs.existsSync(local)) return local
  return 'pm2'
}

async function pm2ReloadOrRestart(appName: string): Promise<void> {
  const pm2 = resolvePm2Bin()

  // Try reload first (zero-downtime when using cluster)
  let res = await run(pm2, ['reload', appName, '--update-env'], repoDir)
  if (res.code === 0) return

  log(`pm2 reload failed (${res.stderr.trim()}), attempting restart`)
  res = await run(pm2, ['restart', appName, '--update-env'], repoDir)
  if (res.code !== 0) throw new Error(`pm2 restart failed: ${res.stderr.trim()}`)
}

async function main(): Promise<number> {
  log(`Auto-update start for APP_NAME="${APP_NAME}" BRANCH="${BRANCH}" in ${repoDir}`)

  // 1) Ensure working tree is clean
  const porcelain = await gitStatusPorcelain()
  if (porcelain.trim().length > 0) {
    log('Working tree has local changes. Skipping auto-update.')
    return 0
  }

  // 2) Fetch & compare
  await fetchBranch(BRANCH)

  const local = await revParse('HEAD')
  const remote = await revParse(`origin/${BRANCH}`)

  if (local === remote) {
    log('No updates found. Exiting.')
    return 0
  }

  // 3) Update to remote
  log(`Updating from ${local.slice(0, 7)} to ${remote.slice(0, 7)}`)
  await checkout(BRANCH)
  await hardReset(`origin/${BRANCH}`)

  // 4) Install deps
  log('Running bun install...')
  await bunInstall()

  // 5) No build step required: Bun runs TypeScript directly

  // 6) Reload/restart the app
  log(`Reloading PM2 app "${APP_NAME}"`)
  await pm2ReloadOrRestart(APP_NAME)

  log('Update complete.')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${new Date().toISOString()}] Auto-update failed: ${message}`)
    process.exit(1)
  })
