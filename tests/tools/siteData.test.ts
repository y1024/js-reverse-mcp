/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {clearSiteData} from '../../src/tools/siteData.js';

test('clear_site_data fails fast while execution is paused', async () => {
  await assert.rejects(
    () =>
      clearSiteData.handler(
        {params: {confirm: true, clearBrowserCache: false}},
        {} as never,
        {
          debuggerContext: {
            isEnabled: () => true,
            isPaused: () => true,
          },
        } as never,
      ),
    /clear_site_data needs page JavaScript/,
  );
});

async function runClearSiteData(clearBrowserCache: boolean) {
  const commands: string[] = [];
  const lines: string[] = [];
  const frame = {
    url: () => 'https://example.test/frame',
    evaluate: async () => undefined,
  };
  const browserContext = {
    cookies: async () => [],
    clearCookies: async () => undefined,
    newCDPSession: async () => ({
      send: async (method: string) => {
        commands.push(method);
      },
      detach: async () => undefined,
    }),
  };
  const page = {
    url: () => 'https://example.test/',
    frames: () => [frame],
    context: () => browserContext,
  };

  await clearSiteData.handler(
    {params: {confirm: true, clearBrowserCache}},
    {
      appendResponseLine: (line: string) => lines.push(line),
      setStructuredContent: () => undefined,
    } as never,
    {
      debuggerContext: {
        isEnabled: () => false,
        isPaused: () => false,
      },
      getSelectedPage: () => page,
    } as never,
  );
  return {commands, lines};
}

test('clear_site_data preserves global browser cache by default', async () => {
  const {commands, lines} = await runClearSiteData(false);
  assert.equal(commands.includes('Network.clearBrowserCache'), false);
  assert.ok(commands.includes('Storage.clearDataForOrigin'));
  assert.match(lines.join('\n'), /browser-wide cache preserved/);
});

test('clear_site_data only clears global browser cache when explicitly requested', async () => {
  const {commands, lines} = await runClearSiteData(true);
  assert.ok(commands.includes('Network.clearBrowserCache'));
  assert.match(lines.join('\n'), /yes \(browser-wide\)/);
});
