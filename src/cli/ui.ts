import { confirm, isCancel } from '@clack/prompts';
import chalk from 'chalk';

import type { ApprovalRequest } from '../core/approval.js';
import type { ProviderEvent } from '../types.js';

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
