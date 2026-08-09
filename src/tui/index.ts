import React from 'react';
import { render } from 'ink';

import type { GlobalOptions } from '../cli/runtime.js';
import { TuiApp } from './App.js';
import { createTuiRuntimeFactory, TuiInteractionBridge } from './runtime.js';

export { TuiApp, type TuiAppProps } from './App.js';
export { createTuiRuntimeFactory, TuiInteractionBridge } from './runtime.js';
export { parseTuiCommand, TUI_HELP } from './types.js';
export type {
  ApprovalView,
  ToolView,
  ToolViewStatus,
  TranscriptEntry,
  TranscriptEntryKind,
  TuiCommand,
  TuiToolEvent,
} from './types.js';

export async function runTui(
  globalOptions: GlobalOptions,
  sessionId?: string,
  plan?: boolean,
): Promise<void> {
  const bridge = new TuiInteractionBridge();
  const runtimeFactory = createTuiRuntimeFactory(globalOptions, bridge);
  const initialRuntime = await runtimeFactory(sessionId);
  const instance = render(
    React.createElement(TuiApp, {
      initialRuntime,
      runtimeFactory,
      bridge,
      ...(plan === true ? { initialPlanMode: true } : {}),
    }),
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
      patchConsole: true,
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
    instance.cleanup();
  }
}
