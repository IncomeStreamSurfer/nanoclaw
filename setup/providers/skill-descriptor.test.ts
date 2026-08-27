import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getInstallableProviderDescriptor, listInstallableProviderDescriptors } from './skill-descriptor.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('provider skill descriptors', () => {
  it('derives the Codex setup offer and image policy from add-codex frontmatter', () => {
    expect(getInstallableProviderDescriptor('CODEX')).toEqual({
      value: 'codex',
      label: 'Codex',
      hint: 'OpenAI — ChatGPT subscription or API key',
      installSkill: 'add-codex',
      image: 'local-required',
      offered: true,
      skillDir: path.join('.claude', 'skills', 'add-codex'),
    });
    expect(listInstallableProviderDescriptors().map((entry) => entry.value)).toEqual(['codex']);
  });

  it('rejects incomplete provider metadata instead of offering a partial install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: add-broken\ndescription: broken\nmetadata:\n  nanoclaw-provider: broken\n---\n',
    );
    expect(() => listInstallableProviderDescriptors(root)).toThrow(/missing nanoclaw-provider-label/);
  });

  it('ignores malformed frontmatter that does not claim to describe a provider', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'unrelated');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: unrelated\ndescription: [broken\n');

    expect(listInstallableProviderDescriptors(root)).toEqual([]);
  });

  it('still rejects malformed frontmatter that claims to describe a provider', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-descriptor-'));
    roots.push(root);
    const dir = path.join(root, '.claude', 'skills', 'add-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nmetadata:\n  nanoclaw-provider: broken\n');

    expect(() => listInstallableProviderDescriptors(root)).toThrow(/frontmatter is missing the closing/);
  });
});
