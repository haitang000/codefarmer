import { confirm, isCancel, select } from '@clack/prompts';
import chalk from 'chalk';

import type { ApprovalRequest } from '../core/approval.js';
import type { AskUserAnswer, AskUserRequest } from '../tools/types.js';
import type { ProviderEvent } from '../types.js';

/** Adds conventional terminal colors to a unified Git diff. */
export function colorizeDiff(diff: string): string {
  return diff
    .split(/\r?\n/u)
    .map((line) => {
      if (
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++')
      ) {
        return chalk.bold.cyan(line);
      }
      if (line.startsWith('@@')) return chalk.magenta(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      if (line.startsWith('\\ No newline')) return chalk.yellow(line);
      return line;
    })
    .join('\n');
}

export async function promptForAskUser(request: AskUserRequest): Promise<AskUserAnswer> {
  process.stderr.write(`\n${chalk.bold(request.question)}\n`);
  const answer = await select({
    message: request.question,
    options: request.options.map((option, index) => ({
      value: String(index),
      label: option,
    })),
  });
  if (isCancel(answer)) return { cancelled: true };
  const index = Number(answer);
  const selected = request.options[index];
  if (selected === undefined) return { cancelled: true };
  return { cancelled: false, selected, index };
}

export async function promptForApproval(request: ApprovalRequest): Promise<boolean> {
  process.stderr.write(`\n${chalk.bold.yellow(request.title)}\n${request.detail}\n`);
  const answer = await confirm({ message: '允许执行此操作？', initialValue: false });
  return !isCancel(answer) && answer;
}

export function createEventRenderer(options: {
  json: boolean;
  stream: boolean;
}): (event: ProviderEvent) => void {
  let renderedDelta = false;
  return (event) => {
    if (options.json) return;
    if (event.type === 'text_delta' && options.stream) {
      process.stdout.write(event.delta);
      renderedDelta = true;
      return;
    }
    if (event.type === 'tool_call') {
      if (renderedDelta) process.stdout.write('\n');
      process.stderr.write(chalk.dim(`→ ${event.call.name}\n`));
      renderedDelta = false;
      return;
    }
    if (event.type === 'error') {
      process.stderr.write(chalk.red(`[${event.error.code}] ${event.error.message}\n`));
    }
  };
}

export function printResultMessage(message: string, streamed: boolean): void {
  if (streamed) {
    if (!message.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  process.stdout.write(`${message}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
