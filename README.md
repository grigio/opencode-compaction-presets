# opencode-compaction-presets

Per-model overrides of **when** [OpenCode](https://opencode.ai) V2 triggers automatic
compaction, configured from `opencode.json(c)`. Think of it as Pi agent's
`compaction.modelOverrides`, but for OpenCode.

## Why

OpenCode V2 only exposes **global** compaction settings:

```jsonc
"compaction": {
  "buffer": "15%",          // room kept free before auto-compaction
  "keep": { "tokens": 8192 } // recent context retained after compaction
}
```

There is no per-model `buffer` or `keep`. This plugin supplies a per-model
**reserve** by changing the model's effective context window:

```text
compaction starts at: context × (1 − buffer)
effective context   = (real context − reserve) / (1 − buffer)
```

`keep` cannot be overridden per model — OpenCode has no hook for it — so it stays
a single global value. The plugin only controls the trigger point.

## Install

Clone the repository, then reference the directory from your global or project
`opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-compaction-presets",
      "options": {
        "bufferPercent": 15,
        "presets": {
          "standard": { "reserve": 4000, "note": "balanced" },
          "lean":     { "reserve": 8000, "note": "compact earlier" },
          "roomy":    { "reserve": 2000, "note": "compact later" }
        },
        "baseContexts": {
          "local/coder": 32768
        },
        "assignments": {
          "local/coder": "standard"
        }
      }
    }
  ]
}
```

OpenCode reloads config changes automatically; no restart is needed.

> **Important:** leave `limit.context` out of the model entries you assign.
> Configured values are merged *after* plugin transforms and would overwrite the
> computed context. Supply each model's real window through `baseContexts`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `bufferPercent` | number | `15` | The global `compaction.buffer` percentage. Must match `opencode.jsonc`, since the math inverts it. |
| `presets` | object | `{}` | Named presets. Each has `reserve` (tokens kept free when compaction starts) and an optional `note`. |
| `baseContexts` | object | `{}` | Map of `"provider/model"` to the model's real context window in tokens. |
| `assignments` | object | `{}` | Map of `"provider/model"` to a preset name. |

Invalid or incomplete entries are ignored; the model is left untouched.

## Commands

| Command | What it does |
| --- | --- |
| `/compact-preset list` | Show presets, assignments, effective contexts and the computed compaction point. |
| `/compact-preset set <name>` | Apply a preset to the current session's model. Persists in plugin storage and overrides the JSON assignment. |
| `/compact-preset clear` | Remove the stored override and fall back to the JSON assignment. |

The `list` output includes the trigger point, e.g. `compacts at ~27200 tokens used`.

## How it works

The plugin registers a model transform. For every assigned model it computes the
effective context from the real window, the preset reserve and the global buffer,
then writes that value into `model.limit.context`. OpenCode's own compaction logic
then does the rest — including background summaries and overflow recovery.

Command-selected presets are saved with `ctx.storage` and merged over the JSON
assignments at setup, so they survive restarts but can be cleared with
`/compact-preset clear`.

## Development

```sh
npm test
```

Tests use Node's built-in test runner and TypeScript type stripping (Node 22+).

## Limitations

- `keep.tokens` is global in OpenCode V2; it cannot be set per model.
- The configured `limit.context` wins over plugin transforms — see the note above.
- A reserve larger than the global buffer share cannot be represented without
  shrinking the effective window; the plugin clamps to the real window.

## License

MIT
