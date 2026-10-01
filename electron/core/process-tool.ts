import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { RegisteredExecutable } from '../../shared/types'

const forbidden = /[|&;<>`$\r\n]/
const MAX_STDERR = 1024
const deniedInterpreters = new Set(['node', 'nodejs', 'python', 'python3', 'pythonw', 'deno', 'bun'])
const safeGitCommands = new Set(['status', 'log', 'diff', 'show', 'rev-parse'])

function executableName(path: string): string { return basename(path).replace(/\.exe$/i, '').toLocaleLowerCase('en-US') }

export function hasWindowsAliasSegment(path: string): boolean {
  return path.split(/[\\/]/).filter(Boolean).some((segment) => /[. ]$/.test(segment))
}

export function isSafeRegisteredExecutable(path: string, args: string[]): boolean {
  const name = executableName(path)
  if (deniedInterpreters.has(name) || args.some((arg) => arg === '*')) return false
  if (name === 'git') return typeof args[0] === 'string' && safeGitCommands.has(args[0].toLocaleLowerCase('en-US'))
  return true
}

function validateArgument(value: string): void {
  if (!value || value.length > 1024 || forbidden.test(value) || /^(?:[A-Za-z_][A-Za-z0-9_]*=)/.test(value)) throw new Error('进程参数不安全')
}

function permits(executable: RegisteredExecutable, args: string[]): boolean {
  let policy: unknown
  try { policy = JSON.parse(executable.argumentPolicyJson) } catch { return false }
  if (!Array.isArray(policy) || policy.length !== args.length || !isSafeRegisteredExecutable(executable.absolutePath, args)) return false
  return policy.every((rule, index) => typeof rule === 'string' && rule !== '*' && rule === args[index])
}

export interface ProcessResult { exitCode: number | null; stderr: string }

export function executeRegisteredProcess(options: {
  executable: RegisteredExecutable
  args: string[]
  cwd: string
  signal: AbortSignal
  spawnProcess?: typeof spawn
}): Promise<ProcessResult> {
  const { executable, args, cwd, signal, spawnProcess = spawn } = options
  if (!executable.isEnabled || !isAbsolute(executable.absolutePath) || !isAbsolute(cwd)
    || hasWindowsAliasSegment(executable.absolutePath) || hasWindowsAliasSegment(cwd) || !permits(executable, args)) return Promise.reject(new Error('登记可执行文件不可用'))
  try { args.forEach(validateArgument) } catch (error) { return Promise.reject(error) }
  if (signal.aborted) return Promise.resolve({ exitCode: null, stderr: 'cancelled' })
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try { child = spawnProcess(executable.absolutePath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }) } catch { reject(new Error('受控进程无法启动')); return }
    let stderr = ''
    let settled = false
    const finish = (value: ProcessResult) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(value) } }
    // kill() requests termination; only close confirms the process is gone.
    const abort = () => { if (!settled) child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    child.stderr?.on('data', (chunk: Buffer) => { if (!settled) stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_STDERR) })
    child.once('error', () => { if (!settled) { settled = true; reject(new Error('受控进程无法启动')) } })
    child.once('close', (exitCode) => finish({ exitCode: signal.aborted ? null : exitCode, stderr: stderr.replace(/[\r\n]/g, ' ').slice(0, MAX_STDERR) }))
    if (signal.aborted) abort()
  })
}
