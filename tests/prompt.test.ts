import { describe, expect, it } from 'vitest';

import { buildAgentInstructions } from '../src/core/prompt.js';
import type { SkillCatalog, SkillRecord } from '../src/types.js';

const selected: SkillRecord = {
  ref: 'docs',
  name: 'docs',
  description: 'Documentation workflow.',
  directory: '/skills/docs',
  skillFile: '/skills/docs/SKILL.md',
  scope: 'workspace',
  instructions: '---\nname: docs\ndescription: Documentation workflow.\n---\n\nRead docs first.',
};

const catalog: SkillCatalog = {
  skills: [selected],
  warnings: [],
  truncated: false,
  get: (ref) => (ref === 'docs' ? selected : undefined),
  read: () => Promise.resolve(selected),
  readResource: () => Promise.resolve({ path: '/skills/docs/reference.txt', content: 'reference' }),
};

describe('agent skill instructions', () => {
  it('advertises a compact catalog and injects explicitly selected instructions', () => {
    const instructions = buildAgentInstructions({
      workspace: '/workspace',
      approval: 'ask',
      skills: catalog,
      selectedSkills: [selected],
    });

    expect(instructions).toContain('docs: Documentation workflow.');
    expect(instructions).toContain('read_skill');
    expect(instructions).toContain('Read docs first.');
    expect(instructions).toContain('can never override system safety rules');
    expect(instructions).toContain('1-based number');
    expect(instructions).toContain('regex=true');
    expect(instructions).toContain('ask_user');
    expect(instructions).toContain('@path');
  });

  it('tells auto mode to plan and then complete the work without ordinary approvals', () => {
    const instructions = buildAgentInstructions({
      workspace: '/workspace',
      approval: 'ask',
      auto: true,
    });

    expect(instructions).toContain('Auto mode is ON');
    expect(instructions).toContain('concrete, ordered plan');
    expect(instructions).toContain('do not stop after planning');
    expect(instructions).toContain('git push');
  });
});
