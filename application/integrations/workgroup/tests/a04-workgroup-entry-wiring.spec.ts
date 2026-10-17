import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const readClientSource = name => readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', name), 'utf8')

describe('workgroup creation entry wiring', () => {
  it('passes reactive workgroup actions from overlays into SettingsDialog', () => {
    const source = readClientSource('overlays.js')
    expect(source).toMatch(/h\(SettingsDialog, \{[^}]*workgroups[^}]*\}\)/s)
  })

  it('passes workgroup actions into GroupsPage and keeps the local group action', () => {
    const source = readClientSource('settings.js')
    expect(source).toMatch(/function GroupsPage\(\{ roster, actions, run, workgroups \}\)/)
    expect(source).toMatch(/h\(GroupsPage, \{ roster, actions, run, workgroups \}\)/)
    expect(source).toMatch(/onClick: \(\) => setCreating\(true\)[\s\S]*?t\('Create group chat'\)/)
  })

  it('renders the workgroup entry below the local group entry and calls the shared action', () => {
    const source = readClientSource('settings.js')
    const groupIndex = source.indexOf("t('Create group chat')")
    const workgroupIndex = source.indexOf("t('Create workgroup chat')")
    expect(groupIndex, 'the original group entry must still exist').toBeGreaterThanOrEqual(0)
    expect(workgroupIndex, 'the workgroup entry must exist').toBeGreaterThan(groupIndex)
    expect(source).toMatch(/workgroups !== undefined\s*\?[\s\S]*?onClick: \(\) => void run\(workgroups\.create\(\)\.then\(sessionId => \{ if \(sessionId !== undefined\) actions\.closeSettings\(\); return sessionId \}\)\)[\s\S]*?t\('Create workgroup chat'\)/)
  })

  it('returns the entered Session id and stacks the settings creation entries', () => {
    const indexSource = readClientSource('index.js')
    const settingsSource = readClientSource('settings.js')
    const stylesSource = readClientSource('styles.js')
    expect(indexSource).toMatch(/const workgroupActions = \{[\s\S]*?create: async \(\) => \{[\s\S]*?return enterWorkgroup\(\{/)
    expect(settingsSource).toMatch(/className: 'bt-actions bt-groups-create-actions'/)
    expect(stylesSource).toMatch(/\.bt-actions\{display:flex;gap:8px;flex-wrap:wrap;align-items:center\}/)
    expect(stylesSource).toMatch(/\.bt-groups-create-actions\{flex-direction:column;align-items:flex-start\}/)
  })

  it('passes the workgroup action object through SettingsDialog', () => {
    const source = readClientSource('settings.js')
    expect(source).toMatch(/export function SettingsDialog\(\{[^}]*workgroups[^}]*\}/s)
  })
})
