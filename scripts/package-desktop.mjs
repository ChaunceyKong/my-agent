import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const platform = process.argv[2]
const targets = { win: ['--win', 'nsis', 'portable', '--x64'], mac: ['--mac', 'dmg', 'zip'], linux: ['--linux', 'AppImage'] }
if (!Object.hasOwn(targets, platform)) throw new Error('Expected win, mac or linux packaging target')
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version')
const output = resolve(root, 'release', `${platform}-v${version}`)
if (existsSync(output)) throw new Error(`Release output already exists; refusing to overwrite: ${output}`)
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [cli, ...targets[platform], '--publish', 'never', `--config.directories.output=${output}`], { cwd: root, stdio: 'inherit', shell: false })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
