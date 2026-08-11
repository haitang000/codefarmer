import type { ApprovalPolicy } from '../types.js';

export type ApprovalKind = 'patch' | 'command';
export type ApprovalScope = 'once' | 'session' | 'workspace';

export interface ApprovalDecision {
  approved: boolean;
  scope?: ApprovalScope;
}

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  detail: string;
  readOnly?: boolean;
  requireConfirmation?: boolean;
  permissionKey?: string;
}

export interface ApprovalController {
  readonly policy: ApprovalPolicy;
  request(request: ApprovalRequest): Promise<boolean>;
  decide?(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class PolicyApprovalController implements ApprovalController {
  public constructor(
    public readonly policy: ApprovalPolicy,
    private readonly prompt:
      | ((request: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>)
      | undefined,
    private readonly interactive = process.stdin.isTTY,
  ) {}

  public async request(request: ApprovalRequest): Promise<boolean> {
    return (await this.decide(request)).approved;
  }

  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (request.readOnly) return { approved: true, scope: 'once' };
    if (this.policy === 'read-only') return { approved: false, scope: 'once' };
    if (this.policy === 'auto' && request.requireConfirmation !== true) {
      return { approved: true, scope: 'session' };
    }
    if (!this.interactive || this.prompt === undefined) return { approved: false, scope: 'once' };
    const decision = await this.prompt(request);
    return typeof decision === 'boolean' ? { approved: decision, scope: 'once' } : decision;
  }
}
