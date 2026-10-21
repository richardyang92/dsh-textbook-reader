import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TUTOR_PRESET_ID,
  registerTutorPreset,
  tutorPresetDefinition,
} from '../dist/chat/tutor-preset.js'

test('tutor preset: persona + delegation rows, and registration disposal', async () => {
  const definition = tutorPresetDefinition()
  assert.equal(definition.id, TUTOR_PRESET_ID)
  assert.equal(definition.id, 'textbook-tutor')
  assert.equal(definition.plugins.length, 2)
  const persona = definition.plugins[0]
  assert.equal(persona.name, '@deepseek-ai/dsh-persona')
  assert.match(persona.config.prefix, /textbook_\*/)
  const delegation = definition.plugins[1]
  assert.equal(delegation.name, 'cordis:group')
  assert.ok(delegation.config.some((row) => row.name === '@deepseek-ai/dsh-tool-subagent-control'))

  let captured
  let released = false
  const release = () => {
    released = true
  }
  const ctx = {
    get(name) {
      return name === 'agentPresets'
        ? {
            register(next) {
              captured = next
              return Promise.resolve(release)
            },
          }
        : undefined
    },
    logger: { warn() {} },
  }
  const dispose = registerTutorPreset(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(captured.id, 'textbook-tutor')
  dispose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(released, true)
})
