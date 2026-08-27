/**
 * Integration test for the opencode provider's HOST-side reach-in: the self-registration
 * import in the src/providers/index.ts barrel. Importing the barrel runs opencode.ts's
 * top-level registerProviderContainerConfig('opencode', …); without that import line the
 * host never wires the provider's per-session mounts / env passthrough.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./opencode.js directly, then asserts the registry actually contains the provider.
 * Importing the provider module directly (as opencode.factory.test.ts does) self-registers
 * it and would stay GREEN even if the barrel line were deleted — that is a unit test,
 * not a registration guard. This test goes red if the barrel import is deleted/drifts,
 * or the barrel fails to evaluate.
 *
 * A provider is a MULTI-POINT integration: this guards the HOST barrel; the CONTAINER
 * barrel is guarded by the sibling bun test; the SDK/CLI dependency + Dockerfile install
 * are guarded by the build/container legs (see the skill's validate step).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-opencode-materialization-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-opencode-materialization-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-opencode-materialization-test/groups',
}));

import { buildMounts } from '../container-runner.js';
import type { ContainerConfig } from '../container-config.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { initGroupFilesystem } from '../group-init.js';
import type { AgentGroup, Session } from '../types.js';
import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

function group(): AgentGroup {
  return {
    id: 'ag-opencode',
    name: 'OpenCode',
    folder: 'opencode-group',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('opencode provider host registration', () => {
  it('registers opencode host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('opencode');
  });

  it('preserves legacy mount behavior and hands only the mount to new core', async () => {
    const provider = getProviderContainerConfig('opencode')!;
    const base = {
      sessionDir: TEST_ROOT,
      agentGroupId: 'group-1',
      groupDir: path.join(TEST_ROOT, 'group'),
      selectedSkills: [],
      hostEnv: {},
    };

    const legacy = await provider(base);
    expect(legacy.mounts).toEqual([
      { hostPath: path.join(TEST_ROOT, 'opencode-xdg'), containerPath: '/opencode-xdg', readonly: false },
    ]);
    expect(fs.existsSync(path.join(TEST_ROOT, 'opencode-xdg'))).toBe(true);

    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    const declaredContext = { ...base, coreOwnsProviderSurfaces: true as const };
    const declared = await provider(declaredContext);
    expect(declared.mounts).toEqual([]);
    expect(declared.env).toMatchObject({ XDG_DATA_HOME: '/opencode-xdg' });
    expect(fs.existsSync(path.join(TEST_ROOT, 'opencode-xdg'))).toBe(false);
  });

  it('materializes the OpenCode surface access contract', async () => {
    const ag = group();
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionDir = path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id, 'opencode');
    await initGroupFilesystem(ag, { provider: 'opencode' });

    const contribution = await getProviderContainerConfig('opencode')!({
      sessionDir,
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv: {},
    });
    const config: ContainerConfig = {
      provider: 'opencode',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(
      ag,
      { id: 'session-1', agent_group_id: ag.id } as Session,
      config,
      'opencode',
      contribution,
    );

    expect(
      mounts
        .filter((mount) =>
          ['/workspace/agent/CLAUDE.md', '/home/node/.claude', '/opencode-xdg'].includes(mount.containerPath),
        )
        .map(({ containerPath, hostPath, readonly }) => ({ containerPath, hostPath, readonly })),
    ).toEqual([
      { containerPath: '/workspace/agent/CLAUDE.md', hostPath: path.join(groupDir, 'CLAUDE.md'), readonly: true },
      {
        containerPath: '/home/node/.claude',
        hostPath: path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared'),
        readonly: false,
      },
      { containerPath: '/opencode-xdg', hostPath: path.join(sessionDir, 'opencode-xdg'), readonly: false },
    ]);
    expect(contribution.env).toMatchObject({
      XDG_DATA_HOME: '/opencode-xdg',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
  });
});
