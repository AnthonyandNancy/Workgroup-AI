// F-05: the fork's independent identity and its coexistence with the official product.
//
// The requirement is that this fork and an installed official DeepSeek Harness can run on
// one machine without interfering. Three values decide that, and each has a failure mode
// that is silent rather than loud:
//
//   appId       — shared, the OS treats both as one product; installing the fork can
//                 replace the official app's registration and uninstall can remove it.
//   protocol    — shared, whichever product installed last captures the other's deep links.
//   data root   — shared, two writers interleave session and plugin files. Nothing errors;
//                 sessions just become inconsistent, which is the worst outcome to debug.
//
// These cases read the real build configuration and the real resolver rather than restating
// the constants, so a change to either is caught here.

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PRODUCT_APP_ID,
  PRODUCT_PROTOCOL,
  PRODUCT_NAME,
  PRODUCT_DATA_DIR_NAME,
  ProductIdentityError,
  assertCoexistence,
  resolveDataRoot,
  resolveProductIdentity,
} from '../../product/identity.mjs'
import { DSH_HOME_DIR_NAME, defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { desktopProductIdentity, desktopProductDefaults } from '../../../apps/desktop/src/product-identity.ts'

/** The values an installed official DeepSeek Harness uses. */
const OFFICIAL = Object.freeze({
  appId: 'ai.deepseek.harness',
  protocol: 'dsh',
  dataDirName: '.dsh',
})

/** Repository root, derived from this spec's own location. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

describe('fork product identity', () => {
  it('differs from the official product in every value the OS uses to identify an app', () => {
    expect(PRODUCT_APP_ID).not.toBe(OFFICIAL.appId)
    expect(PRODUCT_PROTOCOL).not.toBe(OFFICIAL.protocol)
    expect(PRODUCT_DATA_DIR_NAME).not.toBe(OFFICIAL.dataDirName)
  })

  it('is a valid reverse-DNS id, a valid URL scheme, and a safe directory name', () => {
    expect(PRODUCT_APP_ID).toMatch(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/)
    expect(PRODUCT_PROTOCOL).toMatch(/^[a-z][a-z0-9+.-]*$/)
    expect(PRODUCT_DATA_DIR_NAME).toMatch(/^\.[A-Za-z0-9._-]+$/)
    expect(PRODUCT_NAME.trim().length).toBeGreaterThan(0)
  })

  it('passes the coexistence assertion against the official values', () => {
    expect(assertCoexistence({
      officialAppId: OFFICIAL.appId,
      forkAppId: PRODUCT_APP_ID,
      officialScheme: OFFICIAL.protocol,
      forkScheme: PRODUCT_PROTOCOL,
      officialDataRoot: join(homedir(), OFFICIAL.dataDirName),
      forkDataRoot: join(homedir(), PRODUCT_DATA_DIR_NAME),
    })).toBe(true)
  })

  it('rejects each shared value, naming the one that collides', () => {
    const base = {
      officialAppId: OFFICIAL.appId,
      forkAppId: PRODUCT_APP_ID,
      officialScheme: OFFICIAL.protocol,
      forkScheme: PRODUCT_PROTOCOL,
      officialDataRoot: join(homedir(), OFFICIAL.dataDirName),
      forkDataRoot: join(homedir(), PRODUCT_DATA_DIR_NAME),
    }
    expect(() => assertCoexistence({ ...base, forkAppId: OFFICIAL.appId })).toThrow(/appId is shared/)
    expect(() => assertCoexistence({ ...base, forkScheme: OFFICIAL.protocol })).toThrow(/protocol scheme is shared/)
    expect(() => assertCoexistence({ ...base, forkDataRoot: join(homedir(), OFFICIAL.dataDirName) })).toThrow(/data root is shared/)
  })

  it('lets an environment override rebrand without editing source, and validates it', () => {
    const custom = resolveProductIdentity({ WORKGROUP_APP_ID: 'com.example.rebrand', WORKGROUP_PROTOCOL: 'exapp', WORKGROUP_PRODUCT_NAME: 'Example AI' })
    expect(custom.appId).toBe('com.example.rebrand')
    expect(custom.protocol).toBe('exapp')
    expect(custom.name).toBe('Example AI')

    expect(() => resolveProductIdentity({ WORKGROUP_APP_ID: 'not-reverse-dns' })).toThrow(ProductIdentityError)
    expect(() => resolveProductIdentity({ WORKGROUP_PROTOCOL: 'Not A Scheme' })).toThrow(ProductIdentityError)
    expect(() => resolveProductIdentity({ WORKGROUP_PRODUCT_NAME: '   ' })).toThrow(ProductIdentityError)
  })

  it('refuses a data-root name that would escape the home directory', () => {
    expect(() => resolveProductIdentity({ WORKGROUP_DATA_DIR_NAME: '../somewhere' })).toThrow(ProductIdentityError)
    expect(() => resolveProductIdentity({ WORKGROUP_DATA_DIR_NAME: 'a/b' })).toThrow(ProductIdentityError)
    expect(() => resolveProductIdentity({ WORKGROUP_DATA_DIR_NAME: 'visible' })).toThrow(ProductIdentityError)
  })
})

describe('fork and official data roots', () => {
  it('puts the fork default somewhere the official product never writes', () => {
    const fork = resolveDataRoot({ env: {}, home: '/home/employee' })
    const official = join('/home/employee', OFFICIAL.dataDirName)
    expect(fork).not.toBe(official)
    expect(fork).toBe(join('/home/employee', PRODUCT_DATA_DIR_NAME))
  })

  it('still honours WORKGROUP_HOME, which is how an operator or the test bench redirects a run', () => {
    expect(resolveDataRoot({ env: { WORKGROUP_HOME: '/scratch/dsh-home' }, home: '/home/employee' })).toBe('/scratch/dsh-home')
    expect(resolveDataRoot({ env: { WORKGROUP_HOME: '  ' }, home: '/home/employee' })).toBe(join('/home/employee', PRODUCT_DATA_DIR_NAME))
  })

  it('the harness default differs from the official home', () => {
    // The resolver actually used by the runtime, not the constant beside it.
    expect(DSH_HOME_DIR_NAME).toBe(PRODUCT_DATA_DIR_NAME)
    expect(defaultDshHome()).not.toBe(join(homedir(), OFFICIAL.dataDirName))
  })
})

describe('desktop product identity read from the packaged manifest', () => {
  it('uses the sealed values when packaging provided them', () => {
    const identity = desktopProductIdentity({
      workgroupProductName: 'Workgroup AI',
      workgroupProtocol: 'wgai',
      workgroupDataDirName: '.workgroup-ai',
    })
    expect(identity.protocol).toBe(PRODUCT_PROTOCOL)
    expect(identity.dataDirName).toBe(PRODUCT_DATA_DIR_NAME)
  })

  it('falls back to the fork defaults for an unsealed development manifest', () => {
    const identity = desktopProductIdentity({ name: 'dsh-desktop', version: '0.0.0' })
    expect(identity).toEqual(desktopProductDefaults)
    expect(identity.protocol).toBe(PRODUCT_PROTOCOL)
  })

  it('rejects a sealed value that would register the wrong thing', () => {
    expect(() => desktopProductIdentity({ workgroupProtocol: 'Not A Scheme' })).toThrow(/invalid deep-link scheme/)
    expect(() => desktopProductIdentity({ workgroupProtocol: 42 })).toThrow(/must be a non-empty string/)
    expect(() => desktopProductIdentity({ workgroupDataDirName: '../escape' })).toThrow(/invalid data root name/)
    expect(() => desktopProductIdentity(null)).toThrow(/invalid application manifest/)
  })
})

/**
 * The packaging entry point validates its whole release environment before returning, so a
 * case that wants one field must supply the policy origin the release path requires. These
 * are the smallest values that let the real config be built unsigned.
 */
function unsignedBuildEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    WORKGROUP_DESKTOP_UNSIGNED: '1',
    WORKGROUP_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://updates.test.invalid',
    WORKGROUP_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://auth.test.invalid'] }),
    ...extra,
  }
}

describe('the build configuration carries the fork identity', () => {
  it('sets appId, product name, protocol, and artifact naming from the product module', async () => {
    const { createElectronBuilderConfig } = await import('../../../apps/desktop/scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig(unsignedBuildEnv(), 'win32', 'x64')
    expect(config.appId).toBe(PRODUCT_APP_ID)
    expect(config.productName).toBe(PRODUCT_NAME)
    expect(config.protocols).toEqual([{ name: PRODUCT_NAME, schemes: [PRODUCT_PROTOCOL] }])
    expect(config.extraMetadata.workgroupProtocol).toBe(PRODUCT_PROTOCOL)
    expect(config.extraMetadata.workgroupDataDirName).toBe(PRODUCT_DATA_DIR_NAME)
    expect(config.appId).not.toBe(OFFICIAL.appId)
    // The artifact name must not read as an official DeepSeek Harness download.
    expect(config.artifactName).not.toMatch(/deepseek-harness/)
  }, 60_000)

  it('lets an explicit WORKGROUP_DESKTOP_APP_ID still win, keeping the upstream release path usable', async () => {
    const { createElectronBuilderConfig } = await import('../../../apps/desktop/scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig(unsignedBuildEnv({ WORKGROUP_DESKTOP_APP_ID: 'ai.example.distributor' }), 'win32', 'x64')
    expect(config.appId).toBe('ai.example.distributor')
    // The protocol is still the fork's: a rebranded build must not claim the official scheme.
    expect(config.protocols).toEqual([{ name: PRODUCT_NAME, schemes: [PRODUCT_PROTOCOL] }])
  }, 60_000)

  it('the platform dotenv templates a release is built from declare the fork appId', async () => {
    // Packaging reads `.env.windows` / `.env.macos`, which operators create by copying these
    // templates. An explicit appId wins over the product default, so a template carrying the
    // official value would hand every release the official identity — the one outcome the
    // fork's whole identity design exists to prevent.
    const { readFileSync } = await import('node:fs')
    for (const template of ['.env.windows.example', '.env.macos.example']) {
      const text = readFileSync(join(REPO_ROOT, 'apps', 'desktop', template), 'utf8')
      const line = text.split('\n').find(row => row.startsWith('WORKGROUP_DESKTOP_APP_ID=') || row.startsWith('DSH_DESKTOP_APP_ID='))
      expect(line, `${template} must declare an app id`).toBeDefined()
      expect(line).toBe(`WORKGROUP_DESKTOP_APP_ID=${PRODUCT_APP_ID}`)
      expect(text).not.toMatch(/^DSH_DESKTOP_APP_ID=/mu)
      expect(text).not.toContain('com.deepseek.harness')
    }
  })

  it('a local unsigned macOS build still reports the fork identity', async () => {
    // The local path once hardcoded the official appId, which made every local build an
    // official-identity app; only the full packaging path was covered before.
    const { localMacOSPackageEnvironment } = await import('../../../apps/desktop/scripts/desktop-package-environment.mjs')
    const environment = localMacOSPackageEnvironment({})
    expect(environment.WORKGROUP_DESKTOP_APP_ID).toBe(PRODUCT_APP_ID)
    expect(environment.WORKGROUP_DESKTOP_APP_ID).not.toBe(OFFICIAL.appId)
  })
})
