/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {CdpSessionProvider} from '../src/CdpSessionProvider.js';
import type {
  BrowserContext,
  CDPSession,
  Page,
} from '../src/third_party/index.js';
import {WebSocketCollector} from '../src/WebSocketCollector.js';

function createFixture(
  limits: {maxFrames: number; maxBytes: number},
  options: {
    send?: (method: string, params?: unknown) => Promise<unknown>;
  } = {},
) {
  const cdpHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pageHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const contextHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let sessionCalls = 0;
  const session = {
    on(event: string, listener: (payload: unknown) => void) {
      let listeners = cdpHandlers.get(event);
      if (!listeners) {
        listeners = new Set();
        cdpHandlers.set(event, listeners);
      }
      listeners.add(listener);
      return session;
    },
    off(event: string, listener: (payload: unknown) => void) {
      cdpHandlers.get(event)?.delete(listener);
      return session;
    },
    send: options.send ?? (async () => ({})),
    emit(event: string, payload: unknown) {
      for (const listener of cdpHandlers.get(event) ?? []) {
        listener(payload);
      }
    },
  };
  const mainFrame = {};
  const page = {
    on(event: string, listener: (payload: unknown) => void) {
      let listeners = pageHandlers.get(event);
      if (!listeners) {
        listeners = new Set();
        pageHandlers.set(event, listeners);
      }
      listeners.add(listener);
      return page;
    },
    mainFrame: () => mainFrame,
    off(event: string, listener: (payload: unknown) => void) {
      pageHandlers.get(event)?.delete(listener);
      return page;
    },
  } as unknown as Page;
  const collector = new WebSocketCollector(
    {
      pages: () => [page],
      on(event: string, listener: (payload: unknown) => void) {
        let listeners = contextHandlers.get(event);
        if (!listeners) {
          listeners = new Set();
          contextHandlers.set(event, listeners);
        }
        listeners.add(listener);
      },
      off(event: string, listener: (payload: unknown) => void) {
        contextHandlers.get(event)?.delete(listener);
      },
    } as unknown as BrowserContext,
    {
      getSession: async () => {
        sessionCalls++;
        return session as unknown as CDPSession;
      },
    } as unknown as CdpSessionProvider,
    limits,
  );
  return {
    cdpHandlers,
    collector,
    contextHandlers,
    getSessionCalls: () => sessionCalls,
    page,
    session,
  };
}

function createConnection(session: {
  emit(event: string, payload: unknown): void;
}): void {
  session.emit('Network.webSocketCreated', {
    requestId: 'ws-1',
    url: 'wss://example.test/socket',
  });
}

function emitFrame(
  session: {emit(event: string, payload: unknown): void},
  payloadData: string,
  opcode = 1,
): void {
  session.emit('Network.webSocketFrameReceived', {
    requestId: 'ws-1',
    timestamp: 1,
    response: {opcode, payloadData},
  });
}

test('WebSocket frames use stable indices and a count-bounded generation', async () => {
  const {collector, page, session} = createFixture({
    maxFrames: 3,
    maxBytes: 100,
  });
  await collector.addPage(page);
  createConnection(session);

  emitFrame(session, 'one');
  emitFrame(session, 'two');
  emitFrame(session, 'three');
  emitFrame(session, 'four');

  const ws = collector.getData(page)[0];
  assert.deepEqual(
    ws.frames.map(frame => frame.index),
    [1, 2, 3],
  );
  assert.equal(ws.frames.length, 3);
  assert.equal(ws.version, 5, 'four additions plus one eviction');
});

test('WebSocket byte budget uses decoded binary bytes and evicts globally', async () => {
  const {collector, page, session} = createFixture({
    maxFrames: 10,
    maxBytes: 5,
  });
  await collector.addPage(page);
  createConnection(session);

  emitFrame(session, 'AQIDBA==', 2); // 4 decoded bytes, not 8 base64 chars.
  let ws = collector.getData(page)[0];
  assert.equal(ws.frames[0].payloadBytes, 4);
  emitFrame(session, 'xy'); // pushes the page total to 6, evicting frame 0.

  ws = collector.getData(page)[0];
  assert.deepEqual(
    ws.frames.map(frame => frame.index),
    [1],
  );
  assert.equal(ws.frames[0].payloadBytes, 2);
});

test('WebSocket collector disposal detaches CDP and page lifecycle listeners', async () => {
  const {collector, page, session} = createFixture({
    maxFrames: 10,
    maxBytes: 100,
  });
  await collector.addPage(page);
  createConnection(session);
  assert.equal(collector.getData(page).length, 1);

  collector.dispose();
  session.emit('Network.webSocketCreated', {
    requestId: 'ws-after-dispose',
    url: 'wss://example.test/after',
  });
  assert.equal(collector.getData(page).length, 0);
});

test('WebSocket initialization deduplicates and waits for Network.enable', async () => {
  const enabled = Promise.withResolvers<void>();
  let enableCalls = 0;
  const {collector, getSessionCalls} = createFixture(
    {maxFrames: 10, maxBytes: 100},
    {
      send: async method => {
        if (method === 'Network.enable') {
          enableCalls++;
          await enabled.promise;
        }
      },
    },
  );

  let settled = false;
  const first = collector.init();
  const second = collector.init().finally(() => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(getSessionCalls(), 1);
  assert.equal(enableCalls, 1);
  assert.equal(settled, false);
  enabled.resolve();
  await Promise.all([first, second]);
  assert.equal(settled, true);
});

test('concurrent WebSocket addPage calls share one pending setup', async () => {
  const enabled = Promise.withResolvers<void>();
  const {collector, getSessionCalls, page} = createFixture(
    {maxFrames: 10, maxBytes: 100},
    {
      send: async method => {
        if (method === 'Network.enable') {
          await enabled.promise;
        }
      },
    },
  );

  let settled = false;
  const fromPageEvent = collector.addPage(page);
  const fromExplicitPath = collector.addPage(page).finally(() => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(getSessionCalls(), 1);
  assert.equal(settled, false);

  enabled.resolve();
  await Promise.all([fromPageEvent, fromExplicitPath]);
  assert.equal(settled, true);
});

test('WebSocket setup failure rolls back listeners and can be retried', async () => {
  let enableCalls = 0;
  const {cdpHandlers, collector} = createFixture(
    {maxFrames: 10, maxBytes: 100},
    {
      send: async method => {
        if (method === 'Network.enable' && ++enableCalls === 1) {
          throw new Error('transient Network.enable failure');
        }
      },
    },
  );

  await assert.rejects(collector.init(), /transient Network.enable failure/);
  assert.equal(cdpHandlers.get('Network.webSocketCreated')?.size ?? 0, 0);

  await collector.init();
  assert.equal(enableCalls, 2);
  assert.equal(cdpHandlers.get('Network.webSocketCreated')?.size, 1);
});

test('disposing during WebSocket setup removes listeners after setup drains', async () => {
  const enabled = Promise.withResolvers<void>();
  const {cdpHandlers, collector, page} = createFixture(
    {maxFrames: 10, maxBytes: 100},
    {
      send: async method => {
        if (method === 'Network.enable') {
          await enabled.promise;
        }
      },
    },
  );

  const setup = collector.addPage(page);
  await new Promise(resolve => setTimeout(resolve, 0));
  collector.dispose();
  enabled.resolve();
  await setup;

  assert.equal(cdpHandlers.get('Network.webSocketCreated')?.size ?? 0, 0);
  assert.equal(collector.getData(page).length, 0);
});
