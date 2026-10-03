import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { APP_VERSION } from '../../shared/app-version'
it('keeps display/package/lock versions aligned and release targets explicit and unpublished', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  expect([pkg.version, lock.version, lock.packages[''].version, APP_VERSION]).toEqual(Array(4).fill('0.5.0'))
  expect(pkg.build.win.target).toEqual(['nsis', 'portable'])
  expect(pkg.build.mac.target).toEqual(['dmg', 'zip'])
  expect(pkg.build.linux.target).toEqual(['AppImage'])
  expect(pkg.build.directories.output).toBe('release/${os}-v${version}')
  const script = readFileSync('scripts/package-desktop.mjs', 'utf8')
  expect(script).toContain("'--publish', 'never'")
  expect(script.indexOf('if (existsSync(output))')).toBeLessThan(script.indexOf('spawnSync(process.execPath'))
  expect(pkg.build.publish).toBeUndefined()
})
