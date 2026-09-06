---
title: "Configuration"
description: "Tune Lore with the local config while keeping the stable defaults intact."
section: "Understand Lore"
order: 4
---

Lore reads JSON configuration from `~/.config/lore/lore.json` (or `$XDG_CONFIG_HOME/lore/lore.json`; `XDG_CONFIG_HOME` must be absolute). `LORE_HOME` overrides the Lore directory, `LORE_CONFIG` overrides the config file path without relocating the database, and `LORE_COPILOT_HOME` changes the Copilot input home. When no Lore home is configured and the new home does not exist, legacy files under `~/.copilot` remain supported. New keys are additive, and a minimal config is valid:

```json
{ "enabled": true }
```

## Important paths

The default path settings are:

| Key | Default |
| --- | --- |
| `paths.copilotHome` | `~/.copilot` (Copilot inputs only) |
| `paths.rawStorePath` | `~/.copilot/session-store.db` |
| `paths.derivedStorePath` | `~/.config/lore/lore.db` |
| `paths.backupDir` | `~/.config/lore/backups` |
| `paths.instructionsPath` | `~/.copilot/copilot-instructions.md` |

Keep the raw store and derived store separate. Lore reads the raw store and writes derived memory to `lore.db`.

## Migrating an existing installation

Lore keeps using legacy files under `~/.copilot` only when no Lore home is configured and the new home does not exist. Creating the new home selects it, so existing users must migrate before creating it. Stop Lore sessions, then run `npm run migrate-home -- --from <old> --to <new>` (the defaults are the legacy and new homes). The command never overwrites the destination, leaves the source untouched, and preserves custom configured paths. If you choose a custom destination, set `LORE_HOME` to it in each harness. Update or unset any `LORE_CONFIG` override that still points to the old config.

## Core controls

`enabled` must be `true` for Lore to initialise. `budgets` limits the amount of procedural, semantic, episode, commitment, and working-profile context assembled for a prompt. `limits` bounds searches, prompt context, cross-repository results, and metric windows.

The runtime defaults are intentionally conservative: local inference, maintenance, embeddings, and trace recording are off. Some rollout-gated surfaces are enabled by default but remain experimental. The checked-in `lore.example.json` enables archive import, maintenance, and several experimental features, but leaves local inference disabled. Merge only the features you intend to enable.

## Deferred extraction

The default configuration can enqueue extraction at session end and process it at session start. `deferredExtraction.processCurrentRepositoryOnly` keeps automatic work focused. `useLocalInference` requires both this setting and `localInference.enabled`.

## Maintenance scheduler

`maintenanceScheduler.enabled` controls the scheduler. `autoRunOnSessionStart` allows bounded due work to run in the background. The scheduler can run validation, replay, backlog review, trace compaction, index upkeep, deferred extraction, and memory hygiene according to the enabled task map.

Memory hygiene defaults to `mode: "off"`. Use `"shadow"` to record candidates without changing memories. `"apply"` can supersede only rows with deterministic completion evidence; each change has an `auto-hygiene:<run-id>` marker and can be rolled back by the maintenance tool.

## Rollout flags

Rollout flags gate evolving surfaces such as `memoryDomains`, `refreshableObservations`, `traceRecorder`, `evolutionLedger`, `loreDoctor`, and `hybridRetrieval`. Check the [support matrix](/guides/tools/) before enabling a flag in a long-lived setup.

## Validate changes

After changing repository defaults or schema, maintainers should run:

```sh
npm run validate-schema
```

For your personal JSON file, use an editor configured with `schemas/lore.schema.json`. Lore merges known user settings with defaults; it is not a full validator for every unknown key.

## A cautious starting point

```json
{
  "enabled": true,
  "deferredExtraction": {
    "enabled": true,
    "autoEnqueueOnSessionEnd": true,
    "autoProcessOnSessionStart": true
  },
  "maintenanceScheduler": {
    "enabled": false
  }
}
```

Turn on experimental features one at a time so a change in behavior is easy to understand.
