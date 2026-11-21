/**
 * opencode-compaction-presets
 *
 * Per-model overrides of when OpenCode V2 triggers automatic compaction.
 *
 * OpenCode keeps `compaction.buffer` and `compaction.keep.tokens` global. This
 * plugin gives each model its own "reserve" by rewriting the model's effective
 * context window: OpenCode starts compaction at `context * (1 - buffer)`, so
 *
 *   effective context = (real context - reserve) / (1 - buffer)
 *
 * NOTE: leave `limit.context` out of the model entries in opencode.jsonc.
 * Configured values are merged after plugin transforms and would overwrite the
 * computed context. Put each model's real window in `baseContexts` instead.
 */

export type Preset = { reserve: number; note?: string }
export type Options = {
  bufferPercent?: number
  baseContexts?: Record<string, number>
  presets?: Record<string, Preset>
  assignments?: Record<string, string>
}
export type Assignments = Record<string, string>

export const STORAGE_KEY = "assignments"
export const COMMAND_NAME = "compact-preset"

/** Normalize raw plugin options into safe values. */
export function normalizeOptions(raw: unknown = {}): {
  buffer: number
  presets: Record<string, Preset>
  baseContexts: Record<string, number>
  assignments: Assignments
} {
  const options = (raw && typeof raw === "object" ? raw : {}) as Options
  const buffer = Math.min(0.99, Math.max(0.01, (Number(options.bufferPercent) || 15) / 100))
  const presets: Record<string, Preset> = {}

  for (const [name, value] of Object.entries(options.presets ?? {})) {
    if (!value || typeof value.reserve !== "number" || !Number.isFinite(value.reserve)) continue
    presets[name] = { reserve: Math.max(0, value.reserve), ...(value.note ? { note: value.note } : {}) }
  }

  const baseContexts: Record<string, number> = {}
  for (const [key, value] of Object.entries(options.baseContexts ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) baseContexts[key] = value
  }

  const assignments: Assignments = {}
  for (const [key, value] of Object.entries(options.assignments ?? {})) {
    if (typeof value === "string" && value) assignments[key] = value
  }

  return { buffer, presets, baseContexts, assignments }
}

/** Effective context that yields the requested reserve under the global buffer. */
export function effectiveContext(base: number, reserve: number, bufferPercent: number): number {
  const buffer = Math.min(0.99, Math.max(0.01, bufferPercent / 100))
  const target = (base - reserve) / (1 - buffer)
  return Math.max(1024, Math.round(Math.min(base, target)))
}

/** Where compaction starts, in tokens used, for a given effective context. */
export function compactionThreshold(effective: number, bufferPercent: number): number {
  const buffer = Math.min(0.99, Math.max(0.01, bufferPercent / 100))
  return Math.round(effective * (1 - buffer))
}

/** Human-readable summary used by the /compact-preset list command. */
export function describePresets(args: {
  presets: Record<string, Preset>
  assignments: Assignments
  baseContexts: Record<string, number>
  bufferPercent: number
}): string {
  const { presets, assignments, baseContexts, bufferPercent } = args
  const names = Object.keys(presets).sort()
  const lines = ["**Compaction presets**", ""]

  for (const name of names) {
    const preset = presets[name]
    lines.push(`- **${name}**: reserve ~${preset.reserve} tokens${preset.note ? ` — ${preset.note}` : ""}`)
  }

  lines.push("", "**Per-model assignments**")
  const entries = Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) lines.push("- _none_")

  for (const [key, name] of entries) {
    const preset = presets[name]
    const base = baseContexts[key]
    const effective = preset && base ? effectiveContext(base, preset.reserve, bufferPercent) : undefined
    const detail = effective
      ? ` → effective context **${effective}**, compacts at ~**${compactionThreshold(effective, bufferPercent)}** tokens used`
      : ""
    lines.push(`- \`${key}\` → ${preset ? name : `**${name} (unknown)**`}${detail}`)
  }

  lines.push(
    "",
    `Global buffer **${bufferPercent}%**. \`keep\` is global; set \`compaction.keep.tokens\` in opencode.jsonc.`,
    `Commands: \`/${COMMAND_NAME} list\`, \`/${COMMAND_NAME} set <name>\`, \`/${COMMAND_NAME} clear\`.`,
  )
  return lines.join("\n")
}

export default {
  id: "compaction-presets",

  async setup(ctx) {
    const { buffer, presets, baseContexts, assignments: configured } = normalizeOptions(ctx.options)
    const bufferPercent = Math.round(buffer * 100)

    // Assignments chosen with the command are stored and win over JSON defaults.
    const stored = await ctx.storage.get(STORAGE_KEY)
    const assignments: Assignments = { ...configured }
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      Object.assign(assignments, stored)
    }

    const presetNames = () => Object.keys(presets).sort()

    const currentModelKey = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      const model = session?.model
      if (!model?.providerID || !model?.id) return undefined
      return {
        key: `${model.providerID}/${model.id}`,
        ref: { providerID: model.providerID, id: model.id },
      }
    }

    const say = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text })

    const describe = () => describePresets({ presets, assignments, baseContexts, bufferPercent })

    await ctx.model.transform((editor) => {
      for (const [key, presetName] of Object.entries(assignments)) {
        const [providerID, modelID] = key.split("/")
        const preset = presets[presetName]
        const base = baseContexts[key]
        if (!providerID || !modelID || !preset || !base) continue
        editor.update(providerID, modelID, (draft) => {
          draft.limit.context = effectiveContext(base, preset.reserve, bufferPercent)
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description: "List or change the compaction preset for the current session's model",
        execute: async ({ sessionID, prompt }) => {
          const args = (prompt.text ?? "").trim().split(/\s+/).filter(Boolean)
          const action = args.shift()?.toLowerCase() ?? "list"

          if (action === "list" || action === "?") {
            await say(sessionID, describe())
            return
          }

          const current = await currentModelKey(sessionID)
          if (!current) {
            await say(sessionID, "Could not determine the current session model.")
            return
          }

          if (action === "clear") {
            delete assignments[current.key]
            await ctx.storage.set(STORAGE_KEY, assignments)
            await ctx.model.reload()
            await say(sessionID, `Cleared compaction override for \`${current.key}\`.`)
            return
          }

          if (action === "set") {
            const name = args[0]
            if (!name || !presets[name]) {
              await say(sessionID, `Unknown preset \`${name ?? ""}\`. Available: ${presetNames().join(", ") || "(none)"}`)
              return
            }
            assignments[current.key] = name
            await ctx.storage.set(STORAGE_KEY, assignments)
            await ctx.model.reload()
            try {
              await ctx.session.switchModel({ sessionID, model: current.ref })
            } catch {
              // Best effort: the next request resolves from the reloaded registry.
            }
            const list = await ctx.model.list()
            const model = list.find((m) => `${m.providerID}/${m.id}` === current.key)
            const effective = baseContexts[current.key]
              ? effectiveContext(baseContexts[current.key], presets[name].reserve, bufferPercent)
              : model?.limit?.context
            await say(
              sessionID,
              `Preset **${name}** applied to \`${current.key}\` — effective context **${effective ?? "?"}** tokens ` +
                `(compacts at ~**${compactionThreshold(Number(effective) || 0, bufferPercent)}** used, ` +
                `reserve ~${presets[name].reserve}, global buffer ${bufferPercent}%).`,
            )
            return
          }

          await say(sessionID, `Unknown action \`${action}\`. Use \`list\`, \`set <name>\`, or \`clear\`.`)
        },
      })
    })
  },
}
