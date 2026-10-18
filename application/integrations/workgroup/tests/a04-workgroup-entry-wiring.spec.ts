import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const readClientSource = name => readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', name), 'utf8')

// The three entry surfaces stay where they were. What changed is where the workgroup knowledge
// lives: the original group-chat files are back to their local semantics, and the workgroup rows
// reach them through the generic extension props the integration layer supplies.
describe('workgroup creation entry wiring', () => {
  it('offers the workgroup row directly below the local group row in the new-chat menu', () => {
    const overlays = readClientSource('overlays.js')
    const newChat = readClientSource('new-chat.js')
    // The menu component knows nothing about workgroups; it renders what it is handed, after the
    // local group entry.
    expect(newChat).not.toMatch(/workgroup/i)
    expect(newChat).toMatch(/export function NewChat\(\{ mode, roster, actions, extraOptions = \[\] \}\)/)
    const groupIndex = newChat.indexOf("t('Create group chat')")
    const extrasIndex = newChat.indexOf('for (const entry of extraOptions)')
    expect(groupIndex).toBeGreaterThanOrEqual(0)
    expect(extrasIndex).toBeGreaterThan(groupIndex)
    expect(overlays).toMatch(/extraOptions: workgroups === undefined \? \[\] : \[\{[\s\S]*?label: t\('Create workgroup chat'\)[\s\S]*?run: \(\) => workgroups\.openWorkgroupCreate\(\)/)
  })

  it('offers the workgroup row below the local group button in Group chats settings', () => {
    const settings = readClientSource('settings.js')
    const overlays = readClientSource('overlays.js')
    expect(settings).not.toMatch(/workgroup/i)
    expect(settings).toMatch(/function GroupsPage\(\{ roster, actions, run, extraGroups = \[\] \}\)/)
    const localIndex = settings.indexOf("t('Create group chat')")
    const extrasIndex = settings.indexOf('extraGroups.map(')
    expect(localIndex).toBeGreaterThanOrEqual(0)
    expect(extrasIndex).toBeGreaterThan(localIndex)
    expect(overlays).toMatch(/extraGroups: workgroups === undefined \? \[\] : \[\{[\s\S]*?label: t\('Create workgroup chat'\)/)
    // Opening the form from settings must close the dialog first, or the form would render behind it.
    expect(overlays).toMatch(/actions\.closeSettings\?\.\(\); workgroups\.openWorkgroupCreate\(\)/)
  })

  it('offers the workgroup command below the local group command in the palette', () => {
    const palette = readClientSource('palette.js')
    const overlays = readClientSource('overlays.js')
    expect(palette).not.toMatch(/workgroup/i)
    expect(palette).toMatch(/export function CommandPalette\(\{ start, token, roster, actions, useSessions, extraCommands = \[\] \}\)/)
    const groupIndex = palette.indexOf("t('Create group chat')")
    const extrasIndex = palette.indexOf('...extraCommands')
    expect(groupIndex).toBeGreaterThanOrEqual(0)
    expect(extrasIndex).toBeGreaterThan(groupIndex)
    expect(overlays).toMatch(/extraCommands: workgroups === undefined \? \[\] : \[\{[\s\S]*?title: t\('Create workgroup chat'\)/)
  })

  it('opens the copied creation form instead of creating a dated room', () => {
    const source = readClientSource('index.js')
    expect(source).toMatch(/create: \(\) => \{ actions\.openNewChat\('workgroup'\); return Promise\.resolve\(undefined\) \}/)
    expect(source).toMatch(/openWorkgroupCreate: \(\) => \{ actions\.closeSettings\?\.\(\); actions\.openNewChat\('workgroup'\) \}/)
    // A room is created by the form's submit, never by the entry.
    expect(source).not.toMatch(/create: async \(\) => \{[\s\S]*?workgroupHub\.createRoom\(newWorkgroupName/)
  })

  it('renders the copied creation form for the workgroup mode, not the local new-chat pane', () => {
    const overlays = readClientSource('overlays.js')
    expect(overlays).toMatch(/ui\.newChat === 'workgroup'[\s\S]*?h\(WorkgroupCreate/)
    expect(overlays).toMatch(/onCreated: \(room\) => \{ void workgroups\.openWorkgroup\(room\.id\); actions\.closeOverlay\(\) \}/)
  })

  it('keeps the workgroup branch out of the original group-chat files', () => {
    // The requirement's isolation rule, checked where it is easiest to break: the files the copied
    // interface came from must not grow a workgroup condition again.
    for (const name of ['new-chat.js', 'palette.js', 'settings.js', 'group-settings.js', 'sidebar.js']) {
      expect(readClientSource(name), name).not.toMatch(/workgroup/i)
    }
  })
})
