import test from "node:test"
import assert from "node:assert/strict"

import { compactionThreshold, describePresets, effectiveContext, normalizeOptions } from "../src/index.ts"

test("effectiveContext realizes the requested reserve", () => {
  // Generic example: 32k window, 15% global buffer, reserve 4000 tokens.
  const effective = effectiveContext(32000, 4000, 15)
  assert.equal(effective, 32941 > 32000 ? 32000 : effective) // clamped to the real window
  const threshold = compactionThreshold(effective, 15)
  assert.equal(threshold, Math.round(32000 * 0.85))
  assert.equal(32000 - threshold, 4800) // at least the requested reserve

  // A larger reserve shrinks the effective window further.
  const lean = effectiveContext(32000, 8000, 15)
  assert.ok(lean < effective)
  assert.equal(32000 - compactionThreshold(lean, 15), 8000)
})

test("effectiveContext never exceeds the real window or a sane minimum", () => {
  assert.equal(effectiveContext(32000, 0, 15), 32000)
  assert.equal(effectiveContext(1000, 900, 15), 1024)
})

test("normalizeOptions clamps the buffer and drops invalid entries", () => {
  const normalized = normalizeOptions({
    bufferPercent: 250,
    presets: {
      good: { reserve: 4000, note: "ok" },
      bad: { reserve: Number.NaN },
    },
    baseContexts: { "demo/model": 32000, "demo/bad": 0 },
    assignments: { "demo/model": "good", "demo/empty": "" },
  })

  assert.equal(normalized.buffer, 0.99)
  assert.deepEqual(Object.keys(normalized.presets), ["good"])
  assert.deepEqual(normalized.baseContexts, { "demo/model": 32000 })
  assert.deepEqual(normalized.assignments, { "demo/model": "good" })
})

test("normalizeOptions tolerates missing or malformed options", () => {
  const normalized = normalizeOptions(null)
  assert.equal(normalized.buffer, 0.15)
  assert.deepEqual(normalized.presets, {})
  assert.deepEqual(normalized.assignments, {})
})

test("describePresets reports the computed compaction point", () => {
  const text = describePresets({
    presets: { standard: { reserve: 4000 } },
    assignments: { "demo/model": "standard" },
    baseContexts: { "demo/model": 32000 },
    bufferPercent: 15,
  })

  assert.match(text, /compacts at ~\*\*27200\*\* tokens used/)
  assert.match(text, /effective context/)
  assert.match(text, /keep.*global/)
})
