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

  const react = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useEffect: () => {},
    useRef: () => ({ current: null }),
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

  for (const cleanup of cleanups) cleanup?.()
  assert.equal(documentListeners.has('click'), false)
})
