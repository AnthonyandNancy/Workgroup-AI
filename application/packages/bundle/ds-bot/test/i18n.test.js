import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

function clientSources(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) files.push(...clientSources(child))
    else if (entry.name.endsWith('.js')) files.push(child)
  }
  return files
}

/** Every literal first argument of a `t(...)` call, with source escapes resolved. */
function translatedKeys(text) {
  const keys = []
  for (let at = text.indexOf('t('); at >= 0; at = text.indexOf('t(', at + 2)) {
    if (at > 0 && /[\w$]/.test(text[at - 1])) continue
    let index = at + 2
    while (/\s/.test(text[index] ?? '')) index += 1
    const quote = text[index]
    if (quote !== "'" && quote !== '"') continue
    let key = ''
    index += 1
    while (index < text.length) {
      if (text[index] === '\\') { key += text[index + 1] ?? ''; index += 2; continue }
      if (text[index] === quote) break
      key += text[index]
      index += 1
    }
    if (text[index] === quote) keys.push(key)
  }
  return keys
}

test('every literal the client translates has a Chinese entry', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  for (const file of clientSources(dir)) {
    const name = decodeURIComponent(file.pathname).split('/src/client/')[1] ?? file.pathname
    const text = readFileSync(file, 'utf8')
    for (const key of translatedKeys(text)) {
      if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})
