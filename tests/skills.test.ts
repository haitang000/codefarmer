import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverSkills, formatSkillCatalog } from '../src/core/skills.js';
import { createToolRegistry } from '../src/tools/registry.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codefarmer-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(root: string, directory: string, name: string, description: string): Promise<string> {
  const skillDirectory = path.join(root, '.agents', 'skills', directory);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    path.join(skillDirectory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFollow this workflow.\n`,
  );
  return skillDirectory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Codex skills', () => {
  it('discovers workspace skills from the current directory and its parents', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'packages', 'app');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(root, '.git'));
    await writeSkill(root, 'root-skill', 'root-skill', 'A parent workflow.');
    await writeSkill(workspace, 'app-skill', 'app-skill', 'An app workflow.');

    const catalog = await discoverSkills(workspace, { home: path.join(root, 'home') });

    expect(catalog.skills.map((skill) => skill.ref)).toEqual(['app-skill', 'root-skill']);
    expect(await catalog.read('app-skill')).toMatchObject({ name: 'app-skill' });
    expect(formatSkillCatalog(catalog)).toContain('root-skill');
  });

  it('keeps duplicate names addressable through scoped references', async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, 'child');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(root, '.git'));
    await writeSkill(root, 'parent', 'review', 'Review from the parent.');
    await writeSkill(workspace, 'child', 'review', 'Review from the child.');

    const catalog = await discoverSkills(workspace, { home: path.join(root, 'home') });

    expect(catalog.skills.map((skill) => skill.ref)).toEqual(['review@workspace-1', 'review@workspace-2']);
    await expect(catalog.read('review')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });

  it('exposes skills through read-only tools and blocks escaping resource paths', async () => {
    const workspace = await temporaryDirectory();
    const skillDirectory = await writeSkill(workspace, 'docs', 'docs', 'Read documentation.');
    await mkdir(path.join(skillDirectory, 'references'));
    await writeFile(path.join(skillDirectory, 'references', 'guide.txt'), 'Guide content\n');
    await writeFile(path.join(workspace, 'outside.txt'), 'outside\n');
    const catalog = await discoverSkills(workspace, { home: path.join(workspace, 'home') });
    const registry = await createToolRegistry({ workspace, skillCatalog: catalog, maxOutputBytes: 4096 });

    const skill = await registry.execute({ callId: 'skill', name: 'read_skill', arguments: '{"skill":"docs"}' });
    const resource = await registry.execute({ callId: 'resource', name: 'read_skill_resource', arguments: '{"skill":"docs","path":"references/guide.txt"}' });
    const escaped = await registry.execute({ callId: 'escape', name: 'read_skill_resource', arguments: '{"skill":"docs","path":"../../../outside.txt"}' });

    expect(skill.success).toBe(true);
    expect(skill.output).toContain('Follow this workflow.');
    expect(resource).toMatchObject({ success: true, output: 'Guide content\n' });
    expect(escaped.error?.code).toBe('PATH_OUTSIDE_SKILL');
    expect(registry.readOnlyDefinitions.map((definition) => definition.name)).toContain('read_skill');
  });

  it('skips skills without required frontmatter metadata', async () => {
    const workspace = await temporaryDirectory();
    const directory = path.join(workspace, '.agents', 'skills', 'invalid');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), '# no metadata\n');

    expect((await discoverSkills(workspace, { home: path.join(workspace, 'home') })).skills).toEqual([]);
  });
});
