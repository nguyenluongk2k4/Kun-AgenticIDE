import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const NINE_ROUTER_HOST = '127.0.0.1'
const NINE_ROUTER_PORT = 20_128
const NINE_ROUTER_BASE_URL = `http://${NINE_ROUTER_HOST}:${NINE_ROUTER_PORT}/v1`
const NINE_ROUTER_MODELS_URL = `${NINE_ROUTER_BASE_URL}/models`
const NINE_ROUTER_INSTALL_TIMEOUT_MS = 180_000
const NINE_ROUTER_START_TIMEOUT_MS = 45_000
const NINE_ROUTER_HEALTH_POLL_MS = 500
const NINE_ROUTER_STOP_GRACE_MS = 5_000

let child: ChildProcess | null = null
let startPromise: Promise<void> | null = null
const intentionalStops = new WeakSet<ChildProcess>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

function managedInstallRoot(dataDir: string): string {
  return join(expandHomePath(dataDir), 'tools', '9router')
}

function managedBinaryPath(root: string): string {
  return join(root, 'node_modules', '.bin', process.platform === 'win32' ? '9router.cmd' : '9router')
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function nineRouterArgs(): string[] {
  return ['--host', NINE_ROUTER_HOST, '--port', String(NINE_ROUTER_PORT), '--no-browser', '--tray', '--skip-update']
}

function resolveNineRouterLaunch(binary: string): { command: string; args: string[]; cwd: string } {
  if (process.platform === 'win32' && /\.cmd$/i.test(binary)) {
    const shimDir = dirname(binary)
    const embeddedNode = join(shimDir, 'node.exe')
    const cliPath = join(shimDir, 'node_modules', '9router', 'cli.js')
    return {
      command: existsSync(embeddedNode) ? embeddedNode : 'node',
      args: [cliPath, ...nineRouterArgs()],
      cwd: join(shimDir, 'node_modules', '9router')
    }
  }
  return {
    command: binary,
    args: nineRouterArgs(),
    cwd: dirname(binary)
  }
}

async function findInstalledNineRouterBinary(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const args = process.platform === 'win32' ? ['9router'] : ['9router']
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 10_000,
      windowsHide: true
    })
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const preferred = process.platform === 'win32'
      ? lines.find((line) => /9router\.cmd$/i.test(line))
      : lines[0]
    return preferred ?? lines[0] ?? ''
  } catch {
    return ''
  }
}

async function isNineRouterHealthy(timeoutMs = 1_500): Promise<boolean> {
  try {
    const response = await fetch(NINE_ROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' }
    })
    return response.ok
  } catch {
    return false
  }
}

async function ensureManagedBinary(dataDir: string): Promise<string> {
  const installed = await findInstalledNineRouterBinary()
  if (installed) return installed
  const root = managedInstallRoot(dataDir)
  const binary = managedBinaryPath(root)
  if (existsSync(binary)) return binary
  await mkdir(root, { recursive: true })
  try {
    await execFileAsync(
      npmCommand(),
      ['install', '--no-fund', '--no-audit', '--prefix', root, '9router@latest'],
      {
        timeout: NINE_ROUTER_INSTALL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to install 9router automatically with npm. Ensure npm is available, then retry. ${message}`
    )
  }
  if (!existsSync(binary)) {
    throw new Error(`9router was installed but its executable was not found at ${binary}`)
  }
  return binary
}

async function waitForHealthy(
  startedChild: ChildProcess,
  getSpawnError?: () => Error | null
): Promise<void> {
  const deadline = Date.now() + NINE_ROUTER_START_TIMEOUT_MS
  for (;;) {
    if (await isNineRouterHealthy()) return
    const spawnError = getSpawnError?.()
    if (spawnError) {
      throw new Error(`9router failed to start: ${spawnError.message}`)
    }
    if (startedChild.exitCode !== null || startedChild.signalCode !== null) {
      const exitLabel = startedChild.signalCode
        ? `signal ${startedChild.signalCode}`
        : `code ${startedChild.exitCode ?? 'unknown'}`
      throw new Error(`9router exited before becoming healthy (${exitLabel})`)
    }
    if (Date.now() >= deadline) {
      throw new Error('9router did not become healthy before the startup timeout elapsed')
    }
    await sleep(NINE_ROUTER_HEALTH_POLL_MS)
  }
}

export async function ensureNineRouterRunning(dataDir: string): Promise<void> {
  if (await isNineRouterHealthy()) return
  if (child && child.exitCode === null && child.signalCode === null) {
    await waitForHealthy(child)
    return
  }
  if (startPromise) return startPromise
  let task: Promise<void>
  task = (async () => {
    const binary = await ensureManagedBinary(dataDir)
    const launch = resolveNineRouterLaunch(binary)
    let spawnError: Error | null = null
    const startedChild = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: process.env,
      stdio: 'ignore',
      windowsHide: true
    })
    child = startedChild
    startedChild.once('exit', () => {
      if (child === startedChild) child = null
    })
    startedChild.once('error', (error) => {
      if (child === startedChild) child = null
      if (!intentionalStops.has(startedChild)) spawnError = error instanceof Error ? error : new Error(String(error))
    })
    await waitForHealthy(startedChild, () => spawnError)
  })().finally(() => {
    if (startPromise === task) startPromise = null
  })
  startPromise = task
  return task
}

export async function stopNineRouterAndWait(): Promise<void> {
  if (startPromise) {
    try {
      await startPromise
    } catch {
      /* ignore startup failures while stopping */
    }
  }
  const running = child
  if (!running) return
  intentionalStops.add(running)
  const exited = new Promise<void>((resolve) => {
    running.once('exit', () => resolve())
  })
  running.kill()
  await Promise.race([
    exited,
    sleep(NINE_ROUTER_STOP_GRACE_MS).then(() => undefined)
  ])
  if (running.exitCode === null && running.signalCode === null) {
    running.kill('SIGKILL')
    await exited.catch(() => undefined)
  }
  if (child === running) child = null
}

export { NINE_ROUTER_BASE_URL }
