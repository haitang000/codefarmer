import type { ApprovalPolicy } from '../types.js';

export type ApprovalKind = 'patch' | 'command';

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  detail: string;
  readOnly?: boolean;
  requireConfirmation?: boolean;
}

export interface ApprovalController {
  readonly policy: ApprovalPolicy;
  request(request: ApprovalRequest): Promise<boolean>;
}

export class PolicyApprovalController implements ApprovalController {
  public constructor(
    public readonly policy: ApprovalPolicy,
    private readonly prompt: (request: ApprovalRequest) => boolean | Promise<boolean>,
    private readonly interactive = process.stdin.isTTY,
  ) {}

  public async request(request: ApprovalRequest): Promise<boolean> {
    if (request.readOnly) return true;
    if (this.policy === 'read-only') return false;
    if (this.policy === 'auto' && request.requireConfirmation !== true) return true;
    if (!this.interactive) return false;
    return this.prompt(request);
  }
}
