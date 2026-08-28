import type { Migration } from './index.js';

/**
 * Per-agent-group `tone` and `speed` on `container_configs`.
 *
 * NULL = today's behavior for every existing row — deliberately no backfill.
 * Both are core-owned inference properties (like `model` and `effort`) that
 * providers map onto their native knobs: Codex maps `tone` onto its thread
 * `personality` preset and `speed` onto its `service_tier`; Claude maps
 * `speed: "fast"` onto the SDK's `fastMode` setting. A provider with no
 * native equivalent ignores the property.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-tone-speed',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN tone TEXT;`);
    await db.exec(`ALTER TABLE container_configs ADD COLUMN speed TEXT;`);
  },
};
