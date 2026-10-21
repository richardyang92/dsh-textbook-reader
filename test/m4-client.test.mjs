import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

test('M4 client: bundle registers the DSH module and contributes sidebar/main slots', async (t) => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const windowListeners = new Map()
  const documentListeners = new Map()
  const window = {
    __ModuleLoader__: { load(options) { captured = options } },
    location: { href: 'http://127.0.0.1:55555/' },
    addEventListener(type, handler) { windowListeners.set(type, handler) },
    removeEventListener(type) { windowListeners.delete(type) },
    parent: {},
  }
  const document = {
    addEventListener(type, handler) { documentListeners.set(type, handler) },
    removeEventListener(type) { documentListeners.delete(type) },
  }
  vm.runInNewContext(code, { window, document, console, URL, setTimeout, clearTimeout })
  assert.equal(captured?.id, 'dsh-textbook-reader')
  assert.equal(typeof captured.factory, 'function')

  const stateSlots = []
  let hookCursor = 0
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (initial) => {
      const index = hookCursor++
      if (!(index in stateSlots)) stateSlots[index] = initial
      return [
        stateSlots[index],
        (next) => {
          stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next
        },
      ]
    },
  }
  const mod = captured.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require ${name}`)
  })
  assert.deepEqual([...mod.inject].sort(), ['layout', 'locale', 'slots'])
  assert.equal(typeof mod.apply, 'function')

  const registered = []
  const cleanups = []
  let selected = null
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    layout: { selectPanel: (id) => { selected = id } },
    slots: {
      inject: (_name, callback) => { callback() },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: (factory) => { cleanups.push(factory()) },
  }
  mod.apply(ctx)
  assert.deepEqual(registered.map((item) => item.options.name).sort(), ['main', 'sidebar.panellist'])
  assert.equal(registered.find((item) => item.options.name === 'sidebar.panellist').options.id, 'textbook-reader')
  assert.equal(registered.find((item) => item.options.name === 'main').options.key, 'textbook-reader')

  const click = documentListeners.get('click')
  assert.equal(typeof click, 'function')
  let prevented = false
  click({
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: {
      closest: () => ({ href: 'http://127.0.0.1:55555/textbook-reader/?book=b-test&page=12&block=b45' }),
    },
    preventDefault() { prevented = true },
    stopPropagation() {},
  })
  assert.equal(prevented, true)
  assert.equal(selected, 'textbook-reader')

  // Regression: collapsing the chat must stay recoverable. The reopen control
  // now lives in the reader toolbar (styled like the other toolbar icons), so
  // the main panel simply drops the chat pane and keeps the reader full width.
  const mainPanel = registered.find((item) => item.options.name === 'main').component
  const renderPanel = () => {
    hookCursor = 0
    return mainPanel({})
  }
  let tree = renderPanel()
  const chat = tree.children[2]
  assert.equal(typeof chat.tag, 'function')
  chat.props.onCollapse()
  tree = renderPanel()
  assert.equal(tree.children[2], null)

  assert.match(code, /tbr:chat-open/)
  assert.match(code, /tbr:chat-state/)
  assert.doesNotMatch(code, /tbr-chat-fab|tbr-chat-rail|tbr-chat-reopen/)

  // The chat header exposes the per-book conversation list.
  assert.match(code, /chat\/sessions/)
  assert.match(code, /chat\/activate/)
  assert.match(code, /tbr-history-row/)
  assert.match(code, /tbr-history-badge/)

  // PDF selections travel through the same reader context and can be cleared.
  assert.match(code, /tbr:ask/)
  assert.match(code, /tbr:clear-selection/)
  assert.match(code, /tbr-selection-chip/)
  assert.match(code, /SELECTION_PROMPT/)
  assert.match(code, /selection:/)

  // Render ChatPanel with a selection using the fake hooks: the chip and the
  // selection-specific quick action must be part of the returned tree.
  hookCursor = 0
  stateSlots.length = 0
  const chatTree = chat.tag({
    ...chat.props,
    context: {
      bookId: 'b-test',
      bookTitle: '测试教材',
      page: 3,
      selection: { text: '选中的原文', page: 3, blockIds: ['b-1'] },
    },
    onClearSelection: () => {},
  })
  const chip = findClass(chatTree, 'tbr-selection-chip')
  assert.ok(chip, 'selection chip should render')
  assert.match(textOf(chip), /选中的原文/)
  assert.match(textOf(chatTree), /解释选中/)
  assert.match(textOf(chatTree), /已带入选中原文/)

  // Tool calls collapse into one summary line by default: the raw result JSON
  // never reaches the transcript, and the list only appears after a click.
  stateSlots.length = 0
  hookCursor = 0
  stateSlots[2] = [
    {
      id: 'call-1',
      name: 'textbook_search',
      status: 'end',
      summary: JSON.stringify({ bookId: 'b-test', query: 'interaction', hits: [{ page: 26 }, { page: 28 }] }),
    },
    {
      id: 'call-2',
      name: 'textbook_list',
      status: 'end',
      summary: JSON.stringify({ books: [{ id: 'b-test', title: '测试教材', active: true }] }),
    },
  ]
  const flowTree = chat.tag({
    ...chat.props,
    context: { bookId: 'b-test', bookTitle: '测试教材', page: 3 },
    onClearSelection: () => {},
  })
  const flowNode = findNode(flowTree, (node) => typeof node.tag === 'function' && Array.isArray(node.props?.items))
  assert.ok(flowNode, 'activity timeline should be part of the chat tree')
  hookCursor = 0
  stateSlots.length = 0
  const flow = flowNode.tag(flowNode.props)
  const flowHead = findClass(flow, 'tbr-flow-head')
  assert.ok(flowHead, 'collapsed tool summary should render')
  assert.equal(flowHead.props['aria-expanded'], false)
  assert.match(textOf(flowHead), /2 次工具调用/)
  assert.match(textOf(flowHead), /检索教材/)
  assert.doesNotMatch(textOf(flowHead), /bookId|hits|\{"/)
  assert.equal(findClass(flow, 'tbr-flow-list'), null, 'detail rows stay hidden until expanded')
  assert.equal(findClass(flowTree, 'tbr-flow-list'), null, 'the collapsed chat tree contains no detail rows')

  // One settled call already reads as a single line, so it needs no toggle.
  stateSlots.length = 0
  hookCursor = 0
  stateSlots[2] = [
    {
      id: 'call-3',
      name: 'textbook_search',
      status: 'end',
      summary: JSON.stringify({ query: 'interaction', hits: [{ page: 28 }] }),
    },
  ]
  const singleTree = chat.tag({
    ...chat.props,
    context: { bookId: 'b-test', bookTitle: '测试教材', page: 3 },
    onClearSelection: () => {},
  })
  const singleNode = findNode(singleTree, (node) => typeof node.tag === 'function' && Array.isArray(node.props?.items))
  assert.ok(singleNode, 'activity timeline should be part of the chat tree')
  hookCursor = 0
  stateSlots.length = 0
  const singleFlow = singleNode.tag(singleNode.props)
  assert.equal(findClass(singleFlow, 'tbr-flow-head'), null)
  const singleStep = findClass(singleFlow, 'tbr-step')
  assert.ok(singleStep, 'single call renders as one line')
  assert.match(textOf(singleStep), /textbook_search/)
  assert.match(textOf(singleStep), /“interaction” · 命中 1 段 · p\.28/)

  // Tool calls persisted on an assistant message must replay after history is
  // loaded: the collapsed summary sits above the answer and no live activity
  // state is needed.
  stateSlots.length = 0
  hookCursor = 0
  stateSlots[0] = [
    { id: 'u-1', role: 'user', text: '这节讲什么' },
    {
      id: 'a-1',
      role: 'assistant',
      text: '这是回答 [p.2]。',
      citations: [{ page: 2 }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'textbook_search',
          status: 'end',
          summary: JSON.stringify({ query: 'interaction', hits: [{ page: 26 }, { page: 28 }] }),
        },
        {
          id: 'call-2',
          name: 'textbook_list',
          status: 'end',
          summary: JSON.stringify({ books: [{ id: 'b-test', title: '测试教材', active: true }] }),
        },
      ],
    },
  ]
  stateSlots[2] = []
  const replayTree = chat.tag({
    ...chat.props,
    context: { bookId: 'b-test', bookTitle: '测试教材', page: 3 },
    onClearSelection: () => {},
  })
  assert.match(textOf(replayTree), /这是回答/)
  const replayNode = findNode(
    replayTree,
    (node) => typeof node.tag === 'function' && Array.isArray(node.props?.items),
  )
  assert.ok(replayNode, 'persisted calls should render an activity timeline')
  assert.equal(replayNode.props.items.length, 2)
  hookCursor = 0
  stateSlots.length = 0
  const replayFlow = replayNode.tag(replayNode.props)
  const replayHead = findClass(replayFlow, 'tbr-flow-head')
  assert.ok(replayHead, 'persisted calls collapse into one summary line')
  assert.match(textOf(replayHead), /2 次工具调用/)
  assert.match(textOf(replayHead), /检索教材/)
  assert.doesNotMatch(textOf(replayHead), /bookId|hits|\{"/)

  for (const cleanup of cleanups) cleanup?.()
  assert.equal(documentListeners.has('click'), false)
})

function findNode(value, predicate) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object') return
    if (predicate(node)) {
      found = node
      return
    }
    walk(node.children)
  }
  walk(value)
  return found
}

function findClass(value, className) {
  let found = null
  const walk = (node) => {
    if (!node || found) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object') return
    const classes = String(node.props?.className ?? '').split(/\s+/)
    if (classes.includes(className)) {
      found = node
      return
    }
    walk(node.children)
  }
  walk(value)
  return found
}

function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (typeof value === 'object') return textOf(value.children)
  return ''
}
