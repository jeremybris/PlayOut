// Packaging invariants (`npm run test:scripts`, part of `npm test`): what ends up in app.asar is decided by
// package.json `dependencies` (electron-vite externalises them from the main/preload bundles and
// electron-builder copies them) and by `files:` in electron-builder.yml. Renderer-only packages are
// bundled by Vite and must stay in devDependencies, otherwise tens of megabytes of unused node_modules
// ship with every build (and the portable exe re-extracts them on every start).
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { assertCaptured } from './screenshot.mjs'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dependencies = Object.keys(pkg.dependencies ?? {})
const devDependencies = Object.keys(pkg.devDependencies ?? {})

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const ALIASES = ['@shared', '@renderer']

/** Bare package name of an import specifier: 'electron-log/main' -> 'electron-log', '@a/b/c' -> '@a/b'. */
function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Test files and the shared test fakes next to them (`test-helpers.ts`, vitest imports) are never bundled. */
function isTestFile(name) {
  return /\.test\.tsx?$/.test(name) || /^test-helpers\.tsx?$/.test(name)
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(entry.name) && !isTestFile(entry.name)) out.push(path)
  }
  return out
}

/** Runtime (non type-only) bare imports of every source file under `dirs`, as package names. */
function runtimeImports(...dirs) {
  const found = new Set()
  const re =
    /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\s*from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(re)) {
        const spec = m[1] ?? m[2]
        if (spec.startsWith('.') || spec.startsWith('/')) continue
        if (ALIASES.some((a) => spec === a || spec.startsWith(`${a}/`))) continue
        if (BUILTINS.has(spec) || spec === 'electron') continue
        found.add(packageName(spec))
      }
    }
  }
  return found
}

describe('package.json dependencies', () => {
  const mainSide = runtimeImports(
    join(root, 'src/main'),
    join(root, 'src/preload'),
    join(root, 'src/shared')
  )
  const rendererOnly = [...runtimeImports(join(root, 'src/renderer'))].filter(
    (p) => !mainSide.has(p)
  )

  it('lists every package the main process or preload imports', () => {
    for (const name of mainSide) {
      assert.ok(
        dependencies.includes(name),
        `${name} is imported by main/preload but not in dependencies`
      )
    }
  })

  it('does not list renderer-only packages (Vite bundles them into out/renderer)', () => {
    assert.ok(rendererOnly.length > 0, 'expected the renderer to import some packages of its own')
    for (const name of rendererOnly) {
      assert.ok(
        !dependencies.includes(name),
        `${name} is only used by the renderer; move it to devDependencies`
      )
      assert.ok(
        devDependencies.includes(name),
        `${name} is imported by the renderer but not declared`
      )
    }
  })

  it('keeps the known renderer-only packages out of app.asar', () => {
    for (const name of [
      'lucide-react',
      'simple-icons',
      'zustand',
      '@noriginmedia/norigin-spatial-navigation',
      'react',
      'react-dom'
    ]) {
      assert.ok(!dependencies.includes(name), `${name} must not be in dependencies`)
    }
  })

  it('covers every module the built main/preload bundles require (when a build exists)', (t) => {
    const bundles = ['out/main', 'out/preload']
      .map((d) => join(root, d))
      .filter(existsSync)
      .flatMap((d) =>
        readdirSync(d)
          .filter((f) => /\.(js|mjs|cjs)$/.test(f))
          .map((f) => join(d, f))
      )
    if (bundles.length === 0) return t.skip('no build in out/')
    for (const file of bundles) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1]
        if (spec.startsWith('.') || BUILTINS.has(spec) || spec === 'electron') continue
        assert.ok(
          dependencies.includes(packageName(spec)),
          `${relative(root, file)} requires ${spec}, which is not in dependencies`
        )
      }
    }
  })
})

describe('electron-builder.yml', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  // Minimal parse of the `files:` list: the quoted entries of the block that follows `files:`.
  const block = yml.split(/^files:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  const files = [...block.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1])

  it('has a files list', () => {
    assert.ok(files.length > 0, 'files: list not found')
  })

  for (const pattern of [
    '!src/*',
    '!docs/*',
    '!scripts/*',
    '!out/web/**',
    '!coop-helper/**',
    '!xbox-helper/**',
    '!ingame-helper/**',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!vite.web.config.{js,ts,mjs,cjs}',
    '!vitest.config.{js,ts,mjs,cjs}'
  ]) {
    it(`excludes ${pattern}`, () => {
      assert.ok(files.includes(pattern), `files: is missing '${pattern}'`)
    })
  }

  it('does not exclude the build output or the resources', () => {
    for (const p of files) {
      assert.ok(!/^!out\/(main|preload|renderer)\b/.test(p), `${p} would drop the app bundle`)
      assert.ok(!/^!resources\b/.test(p), `${p} would drop the resources`)
    }
  })
})

describe('resources/ingame (scripts/build-ingame-helper.mjs)', () => {
  it('ships the in-game overlay helper, its DLL and the licence text', () => {
    for (const name of ['PlayOutIngame64.exe', 'PlayOutOverlay64.dll', 'LICENSES.txt']) {
      assert.ok(
        existsSync(join(root, 'resources', 'ingame', name)),
        `resources/ingame/${name} is missing`
      )
    }
  })
})

describe('resources/xbox (scripts/build-xbox-helper.mjs)', () => {
  const dir = join(root, 'resources', 'xbox')

  it('ships the helper with its LGPL codec beside it and the licence texts', () => {
    for (const name of ['PlayOutXbox.exe', 'VendoredFlac.dll', 'LICENSES.txt']) {
      assert.ok(existsSync(join(dir, name)), `resources/xbox/${name} is missing`)
    }
    const licences = readFileSync(join(dir, 'LICENSES.txt'), 'utf8')
    for (const text of [
      'XISOSharp',
      'CHDSharp',
      'CCISharp',
      'ZArchiveSharp',
      'StfsSharp',
      'This product includes software developed by in <in@fishtank.com>',
      'GNU LESSER GENERAL PUBLIC LICENSE'
    ]) {
      assert.ok(licences.includes(text), `LICENSES.txt does not mention ${text}`)
    }
  })
})

describe('screenshot.mjs assertCaptured', () => {
  const fakeFs = (mtimeMs) => ({
    existsSync: () => mtimeMs !== undefined,
    statSync: () => ({ mtimeMs })
  })

  it('accepts a file written after the run started', () => {
    assert.doesNotThrow(() => assertCaptured('x.png', 1000, fakeFs(1000)))
    assert.doesNotThrow(() => assertCaptured('x.png', 1000, fakeFs(5000)))
  })

  it('rejects a missing capture (the exit code alone cannot tell a skipped run)', () => {
    assert.throws(() => assertCaptured('x.png', 1000, fakeFs(undefined)), /was not written/)
  })

  it('rejects a stale capture left over from an earlier run', () => {
    assert.throws(() => assertCaptured('x.png', 1000, fakeFs(999)), /was not updated/)
  })

  it('uses the real file system by default', () => {
    const self = resolve(import.meta.dirname, 'screenshot.mjs')
    assert.doesNotThrow(() => assertCaptured(self, statSync(self).mtimeMs))
    assert.throws(() => assertCaptured(join(root, 'does-not-exist.png'), 0), /was not written/)
  })
})
