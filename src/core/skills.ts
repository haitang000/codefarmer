import os from 'node:os';
import path from 'node:path';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';

import { ToolError } from '../tools/errors.js';
import { isPathInside } from '../tools/workspace.js';
import type { SkillCatalog, SkillDescriptor, SkillRecord, SkillScope } from '../types.js';

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_CATALOG_CHARS = 8_000;

interface Candidate {
  directory: string;
  scope: SkillScope;
}

export interface DiscoverSkillsOptions {
  home?: string;
  codexHome?: string;
  systemSkillsDirectory?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"');
  }
  return trimmed;
}

function parseFrontmatter(content: string): { name: string; description: string; body: string } | undefined {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(content);
  if (match === null) return undefined;
  const header = match[1] ?? '';
  let name = '';
  let description = '';
  const lines = header.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const value = /^\s*(name|description)\s*:\s*(.*?)\s*$/u.exec(line);
    if (value === null) continue;
    const key = value[1];
    const raw = value[2] ?? '';
    if (raw === '|' || raw === '>') {
      const collected: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const continuation = lines[next] ?? '';
        if (/^\s{2,}/u.test(continuation) || continuation.trim() === '') {
          collected.push(continuation.trim());
          index = next;
          continue;
        }
        break;
      }
      if (key === 'description') description = collected.join(raw === '|' ? '\n' : ' ').trim();
    } else if (key === 'name') name = unquote(raw);
    else description = unquote(raw);
  }
  if (name.length === 0 || description.length === 0) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) return undefined;
  return { name, description, body: content.slice(match[0].length) };
}

async function candidateRoots(
  workspace: string,
  options: DiscoverSkillsOptions,
): Promise<Candidate[]> {
  const roots: Candidate[] = [];
  const seen = new Set<string>();
  const add = (directory: string, scope: SkillScope): void => {
    const resolved = path.resolve(directory);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ directory: resolved, scope });
  };

  const initialWorkspace = path.resolve(workspace);
  let repositoryRoot = initialWorkspace;
  let probe = initialWorkspace;
  for (;;) {
    try {
      await access(path.join(probe, '.git'));
      repositoryRoot = probe;
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  let current = initialWorkspace;
  for (;;) {
    add(path.join(current, '.agents', 'skills'), 'workspace');
    if (current === repositoryRoot) break;
    current = path.dirname(current);
  }
  const home = options.home ?? os.homedir();
  add(path.join(home, '.agents', 'skills'), 'user');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME;
  if (codexHome !== undefined && codexHome.trim().length > 0) add(path.join(codexHome, 'skills'), 'codex');
  add(path.join(home, '.codex', 'skills'), 'codex');
  if (options.systemSkillsDirectory !== undefined) {
    add(options.systemSkillsDirectory, 'system');
  } else if (process.platform === 'win32') {
    const programData = process.env.ProgramData;
    if (programData !== undefined) add(path.join(programData, 'codex', 'skills'), 'system');
  } else {
    add('/etc/codex/skills', 'system');
  }
  return roots;
}

async function loadDescriptor(candidate: Candidate, directoryName: string): Promise<SkillDescriptor | undefined> {
  const directory = path.join(candidate.directory, directoryName);
  const skillFile = path.join(directory, 'SKILL.md');
  try {
    const resolvedDirectory = await realpath(directory);
    const resolvedSkillFile = await realpath(skillFile);
    if (!isPathInside(resolvedDirectory, resolvedSkillFile)) return undefined;
    const info = await stat(resolvedSkillFile);
    if (!info.isFile() || info.size > MAX_SKILL_BYTES) return undefined;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolvedSkillFile));
    const parsed = parseFrontmatter(content);
    if (parsed === undefined) return undefined;
    return {
      ref: parsed.name,
      name: parsed.name,
      description: parsed.description,
      directory: resolvedDirectory,
      skillFile: resolvedSkillFile,
      scope: candidate.scope,
    };
  } catch {
    return undefined;
  }
}

export function formatSkillCatalog(catalog: SkillCatalog): string {
  if (catalog.skills.length === 0) return 'No skills were discovered.';
  const lines = ['Available skills (load full instructions with read_skill when relevant):'];
  let remaining = MAX_CATALOG_CHARS - (lines[0]?.length ?? 0);
  let included = 0;
  for (const skill of catalog.skills) {
    const line = `- ${skill.ref}: ${skill.description} [${skill.skillFile}]`;
    if (line.length + 1 > remaining) break;
    lines.push(line);
    remaining -= line.length + 1;
    included += 1;
  }
  if (included < catalog.skills.length) lines.push(`- ... ${String(catalog.skills.length - included)} more skills omitted from this list.`);
  return lines.join('\n');
}

export async function discoverSkills(
  workspace: string,
  options: DiscoverSkillsOptions = {},
): Promise<SkillCatalog> {
  const descriptors: SkillDescriptor[] = [];
  const warnings: string[] = [];
  for (const candidate of await candidateRoots(workspace, options)) {
    let entries;
    try {
      entries = await readdir(candidate.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const descriptor = await loadDescriptor(candidate, entry.name);
      if (descriptor !== undefined) descriptors.push(descriptor);
    }
  }
  const counts = new Map<string, number>();
  descriptors.forEach((skill) => counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1));
  const seenNames = new Map<string, number>();
  const skills = descriptors.map((skill) => {
    if ((counts.get(skill.name) ?? 0) <= 1) return skill;
    const index = (seenNames.get(skill.name) ?? 0) + 1;
    seenNames.set(skill.name, index);
    const ref = `${skill.name}@${skill.scope}-${String(index)}`;
    return { ...skill, ref };
  });
  for (const [name, count] of counts) if (count > 1) warnings.push(`Multiple skills named ${name}; use their scoped references.`);
  const byRef = new Map(skills.map((skill) => [skill.ref, skill]));
  const byName = new Map<string, SkillDescriptor>();
  for (const skill of skills) if ((counts.get(skill.name) ?? 0) === 1) byName.set(skill.name, skill);
  const resolve = (ref: string): SkillDescriptor | undefined => byRef.get(ref) ?? byName.get(ref);
  const read = async (ref: string): Promise<SkillRecord> => {
    const descriptor = resolve(ref);
    if (descriptor === undefined) throw new ToolError('SKILL_NOT_FOUND', `Unknown skill: ${ref}`);
    let skillFile: string;
    try {
      skillFile = await realpath(descriptor.skillFile);
    } catch (error) {
      throw new ToolError('PATH_NOT_FOUND', `Skill file does not exist: ${ref}`, { cause: error as Error });
    }
    if (!isPathInside(descriptor.directory, skillFile)) {
      throw new ToolError('PATH_OUTSIDE_SKILL', `Skill file escapes its directory: ${ref}`);
    }
    const info = await stat(skillFile);
    if (info.size > MAX_SKILL_BYTES) throw new ToolError('FILE_TOO_LARGE', `Skill exceeds the ${String(MAX_SKILL_BYTES)} byte limit: ${ref}`);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(skillFile));
    } catch (error) {
      throw new ToolError('INVALID_UTF8', `Skill is not valid UTF-8 text: ${ref}`, { cause: error as Error });
    }
    return { ...descriptor, skillFile, instructions: content };
  };
  const readResource = async (ref: string, relativePath: string): Promise<{ path: string; content: string }> => {
    const descriptor = resolve(ref);
    if (descriptor === undefined) throw new ToolError('SKILL_NOT_FOUND', `Unknown skill: ${ref}`);
    if (relativePath.length === 0 || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new ToolError('PATH_OUTSIDE_SKILL', 'Skill resources must use a relative path.');
    }
    const candidate = path.resolve(descriptor.directory, relativePath);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      throw new ToolError('PATH_NOT_FOUND', `Skill resource does not exist: ${relativePath}`, { cause: error as Error });
    }
    if (!isPathInside(descriptor.directory, resolved)) throw new ToolError('PATH_OUTSIDE_SKILL', 'Skill resource escapes its skill directory.');
    const info = await stat(resolved);
    if (!info.isFile()) throw new ToolError('PATH_NOT_FILE', `Skill resource is not a file: ${relativePath}`);
    if (info.size > MAX_SKILL_BYTES) throw new ToolError('FILE_TOO_LARGE', `Skill resource exceeds the ${String(MAX_SKILL_BYTES)} byte limit: ${relativePath}`);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolved));
    } catch (error) {
      throw new ToolError('INVALID_UTF8', `Skill resource is not valid UTF-8 text: ${relativePath}`, { cause: error as Error });
    }
    return { path: resolved, content };
  };
  const catalog: SkillCatalog = {
    skills,
    warnings,
    truncated: formatSkillCatalog({ skills, warnings, truncated: false, get: resolve, read, readResource }).length >= MAX_CATALOG_CHARS,
    get: resolve,
    read,
    readResource,
  };
  return catalog;
}

export async function readSkillFile(catalog: SkillCatalog, ref: string): Promise<SkillRecord> {
  return catalog.read(ref);
}

export async function skillDirectoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}
