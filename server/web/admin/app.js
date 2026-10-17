/* Local-demo Hub admin UI. No framework, no build step. */
'use strict'

const state = {
  operator: null,
  users: [],
  workgroups: [],
  selectedId: null,
  messages: [],
  beforeSeq: null,
  hasMore: false,
  loadingMessages: false,
}

const $ = selector => document.querySelector(selector)
const loginView = $('#login-view')
const appView = $('#app-view')
const loginError = $('#login-error')
const appError = $('#app-error')

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function setAppError(message) {
  appError.textContent = message ?? ''
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`/api/v1/admin${path}`, {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  let data = {}
  try {
    data = await response.json()
  } catch {
    // A non-JSON response is still a failure; the status below is the useful fact.
  }
  if (!response.ok) {
    if (response.status === 401) showLogin()
    const error = new Error(data.error?.message ?? `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

function showLogin() {
  state.operator = null
  state.selectedId = null
  appView.hidden = true
  loginView.hidden = false
  $('#admin-password').value = ''
  loginError.textContent = ''
}

function showApp(operator) {
  state.operator = operator
  loginView.hidden = true
  appView.hidden = false
  $('#operator-name').textContent = `${operator.displayName} (${operator.userHandle})`
  setAppError('')
}

function fillUserSelect(select, users, { placeholder, exclude = [] } = {}) {
  select.replaceChildren()
  const first = document.createElement('option')
  first.value = ''
  first.textContent = placeholder
  select.append(first)
  const excluded = new Set(exclude)
  for (const user of users) {
    if (excluded.has(user.id)) continue
    const option = document.createElement('option')
    option.value = user.id
    option.textContent = `${user.displayName} (${user.userHandle})`
    select.append(option)
  }
}

async function loadUsers() {
  const result = await api('/users?limit=100')
  state.users = Array.isArray(result.users) ? result.users : []
  fillUserSelect($('#new-workgroup-owner'), state.users, { placeholder: '选择 owner 用户' })
  const createButton = $('#create-form button[type="submit"]')
  createButton.disabled = state.users.length === 0
  return state.users
}

function renderWorkgroups() {
  const list = $('#workgroup-list')
  list.replaceChildren()
  if (state.workgroups.length === 0) {
    const empty = el('li', 'muted', '暂无工作群。')
    list.append(empty)
    return
  }
  for (const workgroup of state.workgroups) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = workgroup.id === state.selectedId ? 'active' : ''
    const title = el('span', '', workgroup.name)
    const meta = el('span', 'row-meta', `${workgroup.ownerDisplayName} · ${workgroup.memberCount} 人 · ${workgroup.dissolvedAt ? '已解散' : '进行中'}`)
    button.append(title, meta)
    button.addEventListener('click', () => { location.hash = `#/workgroups/${workgroup.id}` })
    item.append(button)
    list.append(item)
  }
}

async function loadWorkgroups() {
  const result = await api('/workgroups?status=all&limit=100')
  state.workgroups = Array.isArray(result.workgroups) ? result.workgroups : []
  renderWorkgroups()
  return state.workgroups
}

function renderMessages(container) {
  container.replaceChildren()
  if (state.messages.length === 0) {
    container.append(el('li', 'muted', '暂无消息。'))
    return
  }
  for (const message of state.messages) {
    const item = el('li', 'message')
    const meta = el('div', 'meta', `${message.senderDisplayName || message.senderHandle || message.senderUserId} · ${formatTime(message.createdAt)} · #${message.roomSeq}`)
    const body = el('pre', '', message.body)
    item.append(meta, body)
    container.append(item)
  }
}

function renderDetail(workgroup) {
  const detail = $('#workgroup-detail')
  detail.replaceChildren()

  const head = el('div', 'detail-head')
  head.append(el('h1', '', workgroup.name))
  const status = el('span', 'muted', workgroup.dissolvedAt ? '已解散' : '进行中')
  head.append(status)
  detail.append(head, el('p', 'muted', `Owner: ${workgroup.ownerDisplayName} (${workgroup.ownerHandle}) · ${workgroup.memberCount} 人 · ${workgroup.messageCount} 条消息`))

  const renameSection = el('section', 'detail-section')
  renameSection.append(el('h2', '', '群名'))
  const renameForm = el('form', 'inline-form')
  const nameInput = document.createElement('input')
  nameInput.value = workgroup.name
  nameInput.maxLength = 120
  nameInput.required = true
  const renameButton = el('button', '', '保存')
  renameButton.type = 'submit'
  renameButton.disabled = Boolean(workgroup.dissolvedAt)
  renameForm.append(nameInput, renameButton)
  renameForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    setAppError('')
    try {
      await api(`/workgroups/${workgroup.id}`, { method: 'PATCH', body: JSON.stringify({ name: nameInput.value }) })
      await Promise.all([loadWorkgroups(), loadDetail(workgroup.id)])
    } catch (error) {
      setAppError(error.message)
    }
  })
  renameSection.append(renameForm)
  detail.append(renameSection)

  const membersSection = el('section', 'detail-section')
  membersSection.append(el('h2', '', '成员'))
  const members = el('ul', 'member-list')
  for (const member of workgroup.members ?? []) {
    const row = el('li', 'member-row')
    const who = el('span', 'who', `${member.displayName} (${member.userHandle})`)
    const role = el('span', 'role', member.role)
    row.append(who, role)
    if (member.role !== 'owner' && !workgroup.dissolvedAt) {
      const remove = el('button', 'danger', '移除')
      remove.type = 'button'
      remove.addEventListener('click', async () => {
        if (!confirm(`移除 ${member.displayName}？`)) return
        setAppError('')
        try {
          await api(`/workgroups/${workgroup.id}/members/${member.userId}`, { method: 'DELETE' })
          await Promise.all([loadWorkgroups(), loadDetail(workgroup.id)])
        } catch (error) {
          setAppError(error.message)
        }
      })
      row.append(remove)
    }
    members.append(row)
  }
  membersSection.append(members)

  if (!workgroup.dissolvedAt) {
    const addForm = el('form', 'inline-form')
    const addSelect = document.createElement('select')
    const memberIds = (workgroup.members ?? []).map(member => member.userId)
    fillUserSelect(addSelect, state.users, { placeholder: '选择要添加的用户', exclude: memberIds })
    const addButton = el('button', '', '添加成员')
    addButton.type = 'submit'
    addForm.append(addSelect, addButton)
    addForm.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!addSelect.value) return
      setAppError('')
      try {
        await api(`/workgroups/${workgroup.id}/members`, { method: 'POST', body: JSON.stringify({ userId: addSelect.value }) })
        await Promise.all([loadWorkgroups(), loadDetail(workgroup.id)])
      } catch (error) {
        setAppError(error.message)
      }
    })
    membersSection.append(addForm)
  }
  detail.append(membersSection)

  const messagesSection = el('section', 'detail-section')
  const messagesHead = el('div', 'detail-head')
  messagesHead.append(el('h2', '', '消息'))
  const older = el('button', 'secondary', '加载更早')
  older.type = 'button'
  older.disabled = !state.hasMore || state.loadingMessages
  messagesHead.append(older)
  messagesSection.append(messagesHead)
  const messageList = el('ul', 'message-list')
  messagesSection.append(messageList)

  const loadOlder = async () => {
    if (state.loadingMessages || !state.hasMore) return
    state.loadingMessages = true
    older.disabled = true
    try {
      const page = await api(`/workgroups/${workgroup.id}/messages?limit=50&beforeSeq=${state.beforeSeq}`)
      const olderMessages = (page.messages ?? []).slice().reverse()
      state.messages = [...olderMessages, ...state.messages]
      state.beforeSeq = page.nextBeforeSeq
      state.hasMore = page.hasMore === true
      renderMessages(messageList)
    } catch (error) {
      setAppError(error.message)
    } finally {
      state.loadingMessages = false
      older.disabled = !state.hasMore
    }
  }
  older.addEventListener('click', loadOlder)
  renderMessages(messageList)
  detail.append(messagesSection)

  const actions = el('section', 'detail-section')
  const dissolve = el('button', 'danger', '解散工作群')
  dissolve.type = 'button'
  dissolve.disabled = Boolean(workgroup.dissolvedAt)
  dissolve.addEventListener('click', async () => {
    if (!confirm(`解散「${workgroup.name}」？消息和审计会保留。`)) return
    setAppError('')
    try {
      await api(`/workgroups/${workgroup.id}`, { method: 'DELETE' })
      await loadWorkgroups()
      location.hash = '#/workgroups'
    } catch (error) {
      setAppError(error.message)
    }
  })
  actions.append(dissolve)
  detail.append(actions)
}

async function loadDetail(workgroupId) {
  state.selectedId = workgroupId
  renderWorkgroups()
  const result = await api(`/workgroups/${workgroupId}`)
  state.messages = []
  state.beforeSeq = null
  state.hasMore = false
  renderDetail(result.workgroup)
  const page = await api(`/workgroups/${workgroupId}/messages?limit=50`)
  state.messages = (page.messages ?? []).slice().reverse()
  state.beforeSeq = page.nextBeforeSeq
  state.hasMore = page.hasMore === true
  const messageList = $('#workgroup-detail .message-list')
  if (messageList) {
    renderMessages(messageList)
    const older = $('#workgroup-detail .detail-head button.secondary')
    if (older) older.disabled = !state.hasMore
  }
}

async function route() {
  if (state.operator === null) return
  const match = /^#\/workgroups\/([^/]+)$/.exec(location.hash)
  if (!match) {
    state.selectedId = null
    renderWorkgroups()
    const detail = $('#workgroup-detail')
    detail.replaceChildren(el('p', 'muted', '选择左侧工作群查看详情。'))
    return
  }
  try {
    await loadDetail(decodeURIComponent(match[1]))
  } catch (error) {
    setAppError(error.message)
  }
}

async function enterApp(operator) {
  showApp(operator)
  await loadUsers()
  await loadWorkgroups()
  await route()
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  loginError.textContent = ''
  const button = $('#login-form button[type="submit"]')
  button.disabled = true
  try {
    const result = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        userHandle: $('#admin-handle').value,
        password: $('#admin-password').value,
      }),
    })
    await enterApp(result.operator)
  } catch (error) {
    loginError.textContent = error.message
  } finally {
    button.disabled = false
  }
})

$('#logout').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST', body: '{}' })
  } catch {
    // A failed logout still clears the local view.
  }
  showLogin()
})

$('#refresh-workgroups').addEventListener('click', async () => {
  setAppError('')
  try {
    await loadWorkgroups()
  } catch (error) {
    setAppError(error.message)
  }
})

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  setAppError('')
  const name = $('#new-workgroup-name').value
  const ownerUserId = $('#new-workgroup-owner').value
  if (!ownerUserId) {
    setAppError('请选择 owner 用户。')
    return
  }
  try {
    const result = await api('/workgroups', {
      method: 'POST',
      body: JSON.stringify({ name, ownerUserId }),
    })
    $('#new-workgroup-name').value = ''
    await loadWorkgroups()
    location.hash = `#/workgroups/${result.workgroup.id}`
  } catch (error) {
    setAppError(error.message)
  }
})

window.addEventListener('hashchange', () => { void route() })

async function boot() {
  try {
    const result = await api('/session')
    await enterApp(result.operator)
  } catch (error) {
    if (error.status !== 401) loginError.textContent = error.message
    showLogin()
  }
}

void boot()
