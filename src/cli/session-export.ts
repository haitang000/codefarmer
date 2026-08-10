import type { SessionMessage, SessionRecord, SessionToolCall, TokenUsage } from '../types.js';

export type SessionExportFormat = 'markdown' | 'json';

const ROLE_LABELS: Record<SessionMessage['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '上下文摘要',
};

/** Wrap content in a fenced code block whose fence is longer than any backtick run inside. */
function fence(content: string): string {
  const runs = content.match(/`+/gu) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}text\n${content}\n${marker}`;
}

function usageLine(usage: TokenUsage): string {
  const parts = [
    `输入 ${String(usage.inputTokens)}`,
    `输出 ${String(usage.outputTokens)}`,
    `总计 ${String(usage.totalTokens)}`,
  ];
  if (usage.reasoningTokens !== undefined) parts.push(`推理 ${String(usage.reasoningTokens)}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`缓存输入 ${String(usage.cachedInputTokens)}`);
  return parts.join(' / ');
}

function renderToolCall(call: SessionToolCall): string {
  const lines = [
    `### ${call.toolName} (\`${call.callId}\`)`,
    '',
    `- 状态: ${call.success ? '成功' : '失败'}`,
    ...(call.approved === undefined ? [] : [`- 批准: ${call.approved ? '是' : '否'}`]),
    ...(call.truncated === undefined ? [] : [`- 输出截断: ${call.truncated ? '是' : '否'}`]),
    `- 开始时间: ${call.startedAt}`,
    ...(call.completedAt === undefined ? [] : [`- 完成时间: ${call.completedAt}`]),
    '',
    '参数:',
    '',
    fence(JSON.stringify(call.arguments, null, 2)),
  ];
  if (call.outputSummary !== undefined) {
    lines.push('', '输出摘要:', '', fence(call.outputSummary));
  }
  return lines.join('\n');
}

function renderMarkdown(session: SessionRecord): string {
  const lines = [
    `# CodeFarmer 会话 ${session.id}`,
    '',
    `- 状态: ${session.status}`,
    ...(session.title === undefined ? [] : [`- 标题: ${session.title}`]),
    `- 提供方: ${session.provider}`,
    `- 模型: ${session.model}`,
    ...(session.baseURL === undefined ? [] : [`- Base URL: ${session.baseURL}`]),
    `- 工作区: ${session.workspace}`,
    `- 创建时间: ${session.createdAt}`,
    `- 更新时间: ${session.updatedAt}`,
    ...(session.usage === undefined ? [] : [`- 令牌用量: ${usageLine(session.usage)}`]),
    ...(session.error === undefined
      ? []
      : [`- 错误: [${session.error.code}] ${session.error.message}`]),
    ...(session.previousResponseId === undefined
      ? []
      : [`- 响应 ID: \`${session.previousResponseId}\``]),
  ];
  lines.push('', '## 消息');
  if (session.messages.length === 0) {
    lines.push('', '（无消息）');
  } else {
    for (const message of session.messages) {
      lines.push(
        '',
        `### ${ROLE_LABELS[message.role]} (${message.createdAt})`,
        '',
        fence(message.content),
        ...(message.responseId === undefined ? [] : ['', `响应 ID: \`${message.responseId}\``]),
      );
    }
  }
  lines.push('', '## 工具调用');
  if (session.toolCalls.length === 0) {
    lines.push('', '（无工具调用）');
  } else {
    for (const call of session.toolCalls) lines.push('', renderToolCall(call));
  }
  return `${lines.join('\n')}\n`;
}

export function renderSessionExport(
  session: SessionRecord,
  format: SessionExportFormat,
): string {
  if (format === 'json') return `${JSON.stringify(session, null, 2)}\n`;
  return renderMarkdown(session);
}
