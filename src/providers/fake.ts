import type { AgentProvider, ProviderEvent, ProviderRequest } from '../types.js';

export class ScriptedProvider implements AgentProvider {
  public readonly name: string = 'fake';
  private index = 0;

  public constructor(private readonly turns: ProviderEvent[][]) {}

  public async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    void request;
    await Promise.resolve();
    const events = this.turns[this.index] ?? [];
    this.index += 1;
    for (const event of events) yield event;
  }
}
