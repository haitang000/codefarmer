import type { JsonObject, ToolDefinition, ToolResult } from '../types.js';
import { ToolError } from './errors.js';
import { requiredString, successfulResult } from './output.js';
import type { ResolvedToolContext } from './types.js';

export type { AskUserAnswer, AskUserRequest } from './types.js';

export const MAX_ASK_OPTIONS = 8;
export const MAX_ASK_QUESTION_CHARS = 300;
export const MAX_ASK_OPTION_CHARS = 120;

export const askUserDefinition: ToolDefinition = {
  name: 'ask_user',
  description:
    'Ask the user a multiple-choice question and wait for their selection. Use it when a decision is required before continuing. Not available in non-interactive runs.',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ASK_QUESTION_CHARS,
        description: 'The question to show the user.',
      },
      options: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: MAX_ASK_OPTION_CHARS },
        minItems: 2,
        maxItems: MAX_ASK_OPTIONS,
        description: 'Two to eight choices. The user picks exactly one.',
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
};

function parseOptions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ToolError('INVALID_ARGUMENT', 'options must be an array of strings.');
  }
  if (value.length < 2 || value.length > MAX_ASK_OPTIONS) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `options must contain between 2 and ${String(MAX_ASK_OPTIONS)} choices.`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `options[${String(index)}] must be a non-empty string.`,
      );
    }
    if (entry.length > MAX_ASK_OPTION_CHARS) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `options[${String(index)}] exceeds ${String(MAX_ASK_OPTION_CHARS)} characters.`,
      );
    }
    return entry.trim();
  });
}

export async function askUser(
  callId: string,
  arguments_: Record<string, unknown>,
  context: ResolvedToolContext,
): Promise<ToolResult> {
  const question = requiredString(arguments_.question, 'question');
  if (question.length > MAX_ASK_QUESTION_CHARS) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `question exceeds ${String(MAX_ASK_QUESTION_CHARS)} characters.`,
    );
  }
  const options = parseOptions(arguments_.options);
  const ask = context.askUser;
  if (ask === undefined) {
    throw new ToolError(
      'ASK_UNAVAILABLE',
      'ask_user requires an interactive session. State your assumption and continue, or ask in the final reply.',
    );
  }

  const answer = await ask({ question, options });
  if (answer.cancelled || answer.selected === undefined) {
    return successfulResult(callId, 'ask_user', 'User cancelled the question.', {
      data: { cancelled: true, question } satisfies JsonObject,
    });
  }
  return successfulResult(callId, 'ask_user', `User selected: ${answer.selected}`, {
    data: {
      cancelled: false,
      question,
      selected: answer.selected,
      ...(answer.index === undefined ? {} : { index: answer.index }),
    } satisfies JsonObject,
  });
}
