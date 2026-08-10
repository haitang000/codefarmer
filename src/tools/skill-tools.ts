import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { successfulResult, requiredString, truncateUtf8 } from './output.js';
import type { ResolvedToolContext } from './types.js';
import { ToolError } from './errors.js';

export const readSkillDefinition: ToolDefinition = {
  name: 'read_skill',
  description: 'Read the complete instructions from a discovered Codex SKILL.md file.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: { skill: { type: 'string', description: 'Skill reference from the available skills list.' } },
    required: ['skill'],
    additionalProperties: false,
  },
};

export const readSkillResourceDefinition: ToolDefinition = {
  name: 'read_skill_resource',
  description: 'Read a UTF-8 text resource inside a discovered skill directory.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Skill reference from the available skills list.' },
      path: { type: 'string', description: 'Skill-relative resource path.' },
    },
    required: ['skill', 'path'],
    additionalProperties: false,
  },
};

function catalog(context: ResolvedToolContext): NonNullable<ResolvedToolContext['skillCatalog']> {
  if (context.skillCatalog === undefined) throw new ToolError('SKILLS_UNAVAILABLE', 'No skill catalog is available.');
  return context.skillCatalog;
}

export async function readSkill(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const skill = requiredString(arguments_.skill, 'skill');
  const record = await catalog(context).read(skill);
  const output = truncateUtf8(record.instructions, context.maxOutputBytes);
  return successfulResult(callId, 'read_skill', output.text, {
    truncated: output.truncated,
    data: { ref: record.ref, name: record.name, path: record.skillFile } as JsonObject,
  });
}

export async function readSkillResource(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const skill = requiredString(arguments_.skill, 'skill');
  const resourcePath = requiredString(arguments_.path, 'path');
  const resource = await catalog(context).readResource(skill, resourcePath);
  const output = truncateUtf8(resource.content, context.maxOutputBytes);
  return successfulResult(callId, 'read_skill_resource', output.text, {
    truncated: output.truncated,
    data: { ref: skill, path: resource.path } as JsonObject,
  });
}
