/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {evaluateScript} from '../../src/tools/script.js';

function createResponse(lines: string[]) {
  return {
    appendResponseLine(value: string) {
      lines.push(value);
    },
    setStructuredContent() {
      return undefined;
    },
  };
}

test('evaluate_script mainWorld directly targets the selected frame main world', async () => {
  const lines: string[] = [];
  let expression = '';
  let isolatedContext: boolean | undefined;
  const debugger_ = {
    isEnabled: () => true,
    isPaused: () => false,
    terminateExecution: async () => undefined,
  };
  const frame = {
    evaluate: async (
      value: string,
      _arg: unknown,
      useIsolatedContext: boolean,
    ) => {
      expression = value;
      isolatedContext = useIsolatedContext;
      return JSON.stringify({type: 'json', data: '42'});
    },
  };

  await evaluateScript.handler(
    {
      params: {
        confirm: true,
        function: '() => window.pageDefinedValue',
        mainWorld: true,
        confirmOverwrite: false,
      },
    },
    createResponse(lines) as never,
    {
      debuggerContext: debugger_,
      getSelectedFrame: () => frame,
    } as never,
  );

  assert.match(expression, /window\.pageDefinedValue/);
  assert.equal(isolatedContext, false);
  assert.match(lines.join('\n'), /returned:[\s\S]*42/);
});

test('evaluate_script unwraps settled async values in a paused call frame', async () => {
  const lines: string[] = [];
  let evaluatedExpression = '';
  const debugger_ = {
    isEnabled: () => true,
    isPaused: () => true,
    getPausedState: () => ({
      isPaused: true,
      callFrames: [{callFrameId: 'call-frame-1'}],
    }),
    evaluateSettledPromiseOnCallFrame: async (
      callFrameId: string,
      expression: string,
    ) => {
      assert.equal(callFrameId, 'call-frame-1');
      evaluatedExpression = expression;
      return {
        result: {
          type: 'string',
          value: 43,
        },
        settledPromise: true,
      };
    },
  };

  await evaluateScript.handler(
    {
      params: {
        confirm: true,
        function: 'async () => await Promise.resolve(43)',
        mainWorld: false,
        confirmOverwrite: false,
      },
    },
    createResponse(lines) as never,
    {debuggerContext: debugger_} as never,
  );

  assert.doesNotMatch(evaluatedExpression, /const result = await/);
  assert.match(evaluatedExpression, /result instanceof Promise/);
  assert.match(lines.join('\n'), /43/);
});

test('evaluate_script terminates active Runtime work when cancelled', async () => {
  const controller = new AbortController();
  const evaluation = Promise.withResolvers<string>();
  let terminateCalls = 0;
  const call = evaluateScript.handler(
    {
      params: {
        confirm: true,
        function: 'async () => 1',
        mainWorld: true,
        confirmOverwrite: false,
      },
      signal: controller.signal,
    },
    createResponse([]) as never,
    {
      debuggerContext: {
        isEnabled: () => true,
        isPaused: () => false,
        terminateExecution: async () => {
          terminateCalls++;
        },
      },
      getSelectedFrame: () => ({
        evaluate: () => evaluation.promise,
      }),
    } as never,
  );

  controller.abort(new Error('cancelled'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(terminateCalls, 1);
  evaluation.resolve(JSON.stringify({type: 'json', data: '1'}));
  await call;
});
