/**
 * @intellidev/shared — the canonical contracts.
 *
 * Consumed as TypeScript source by both the control plane and the adapter, so
 * there is never a "did you rebuild shared?" failure mode. See docs/architecture.md.
 */

export * from './ids.js'
export * from './events.js'
export * from './stages.js'
export * from './stage-prompts.js'
export * from './manifest.js'
export * from './tools.js'
export * from './env.js'
export * from './redact.js'
export * from './run.js'
