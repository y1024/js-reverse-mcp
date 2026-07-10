/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  analyzeWebSocketFramesV2,
  formatGroupMessages,
  formatRecentMessages,
  formatTrafficSummary,
  formatWebSocketFrameDetail,
} from '../formatters/websocketFormatter.js';
import {zod} from '../third_party/index.js';
import {ToolError} from '../ToolError.js';
import {paginate} from '../utils/pagination.js';

import {ToolCategory} from './categories.js';
import {
  createToolOutputSchema,
  defineTool,
  PAGINATION_OUTPUT_SCHEMA,
} from './ToolDefinition.js';

const DIRECTION_OPTIONS: readonly ['sent', 'received'] = ['sent', 'received'];

export const getWebSocketMessages = defineTool({
  name: 'get_websocket_messages',
  description: `Lists WebSocket connections or gets messages for a specific connection. Without wsid, lists all connections. With wsid, gets messages. Set analyze=true to group messages by pattern. Use groupId to filter by group. Use frameIndex to get a single message's detail by the stable frame index shown in message tables and analysis samples.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  capabilities: ['websocket'],
  outputSchema: createToolOutputSchema({
    connections: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    frames: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    frame: zod.record(zod.string(), zod.unknown()).optional(),
    groups: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    frameIndices: zod.array(zod.number().int()).optional(),
    wsid: zod.number().optional(),
    url: zod.string().optional(),
    version: zod.number().int().optional(),
    groupId: zod.string().optional(),
    totalFrames: zod.number().int().optional(),
    sentCount: zod.number().int().optional(),
    receivedCount: zod.number().int().optional(),
    pagination: PAGINATION_OUTPUT_SCHEMA.optional(),
  }),
  schema: {
    wsid: zod
      .number()
      .optional()
      .describe(
        'The wsid of the WebSocket connection. If omitted, lists all connections.',
      ),
    analyze: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Set to true to analyze and group messages by pattern/fingerprint. Returns statistics and sample indices for each message type.',
      ),
    frameIndex: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Get a single retained message by its stable frame index. Indices are monotonic and may start above 0 after old frames are evicted; use the Idx values shown by message tables or analyze=true.',
      ),
    direction: zod
      .enum(DIRECTION_OPTIONS)
      .optional()
      .describe('Filter by direction: "sent" or "received".'),
    groupId: zod
      .string()
      .optional()
      .describe(
        'Filter by group ID (A, B, C, ...). Run with analyze=true first to get group IDs; if analyze used a direction filter, pass the same direction here.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe(
        'Messages per page (for messages mode) or connections per page (for list mode). Defaults to 10.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Page number (0-based).'),
    show_content: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to append payload previews (up to 10,000 characters each) for the current page of messages. Default false (summary only).',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter connections by URL (only for listing connections without wsid).',
      ),
    includePreservedConnections: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved connections over the last 3 navigations (only for listing connections without wsid).',
      ),
  },
  handler: async (request, response, context) => {
    // Mode: List connections (no wsid)
    if (request.params.wsid === undefined) {
      response.setIncludeWebSocketConnections(true, {
        pageSize: request.params.pageSize,
        pageIdx: request.params.pageIdx,
        urlFilter: request.params.urlFilter,
        includePreservedConnections: request.params.includePreservedConnections,
      });
      return;
    }

    const ws = context.getWebSocketById(request.params.wsid);

    // Mode: Single frame detail
    if (request.params.frameIndex !== undefined) {
      const frameIndex = request.params.frameIndex;
      const frame = ws.frames.find(item => item.index === frameIndex);
      if (!frame) {
        const retainedRange =
          ws.frames.length > 0
            ? `${ws.frames[0].index}-${ws.frames[ws.frames.length - 1].index}`
            : 'none';
        throw new ToolError(
          'NOT_FOUND',
          `Frame index ${frameIndex} is not retained. Retained stable frame range: ${retainedRange} (${ws.frames.length} frames).`,
        );
      }
      const lines = formatWebSocketFrameDetail(frame, frameIndex);
      for (const line of lines) {
        response.appendResponseLine(line);
      }
      response.setStructuredContent({
        wsid: request.params.wsid,
        frame: {
          index: frame.index,
          direction: frame.direction,
          timestamp: frame.timestamp,
          opcode: frame.opcode,
          payloadBytes: frame.payloadBytes,
          payloadData: frame.payloadData.slice(0, 10_000),
          truncated: frame.payloadData.length > 10_000,
        },
      });
      return;
    }

    const getFilteredFrames = () => {
      const selectedFrames = ws.frames.filter(
        frame =>
          !request.params.direction ||
          frame.direction === request.params.direction,
      );
      return {
        frames: selectedFrames,
        frameIndices: selectedFrames.map(frame => frame.index),
      };
    };

    // Mode: Analyze / group by pattern
    if (request.params.analyze) {
      const {frames, frameIndices} = getFilteredFrames();

      const summary = analyzeWebSocketFramesV2(
        frames,
        request.params.wsid,
        ws.connection.url,
        frameIndices,
      );
      if (!request.params.direction) {
        context.cacheTrafficSummary(request.params.wsid, ws.version, summary);
      }

      const groupPage = paginate(summary.groups, {
        pageSize: request.params.pageSize,
        pageIdx: request.params.pageIdx,
      });
      if (groupPage.invalidPage) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `pageIdx ${request.params.pageIdx} is outside 0-${groupPage.totalPages - 1}.`,
        );
      }
      const lines = formatTrafficSummary({
        ...summary,
        groups: [...groupPage.items],
      });
      for (const line of lines) {
        response.appendResponseLine(line);
      }
      response.appendResponseLine(
        `Showing groups ${groupPage.startIndex + 1}-${groupPage.endIndex} of ${summary.groups.length}.`,
      );

      response.appendResponseLine(``);
      response.appendResponseLine(`### Usage`);
      response.appendResponseLine(
        `- View group: \`get_websocket_messages(wsid=${request.params.wsid}, groupId="A")\``,
      );
      response.appendResponseLine(
        `- View single: \`get_websocket_messages(wsid=${request.params.wsid}, frameIndex=${ws.frames[0]?.index ?? 0})\``,
      );
      response.setStructuredContent({
        wsid: summary.wsid,
        url: summary.url,
        version: ws.version,
        totalFrames: summary.totalFrames,
        sentCount: summary.sentCount,
        receivedCount: summary.receivedCount,
        groups: groupPage.items,
        pagination: {
          pageIdx: groupPage.currentPage,
          pageSize: request.params.pageSize ?? 10,
          totalItems: summary.groups.length,
          totalPages: groupPage.totalPages,
          hasNextPage: groupPage.hasNextPage,
          hasPreviousPage: groupPage.hasPreviousPage,
        },
      });
      return;
    }

    const {frames, frameIndices} = getFilteredFrames();

    const pageSize = request.params.pageSize ?? 10;
    const pageIdx = request.params.pageIdx ?? 0;

    // Mode: With groupId - show group-specific messages
    if (request.params.groupId) {
      const groupId = request.params.groupId.toUpperCase();

      // Direction-filtered group IDs are only stable for the same direction,
      // so compute them from the filtered frame list instead of reusing the
      // unfiltered cache.
      let summary = request.params.direction
        ? undefined
        : context.getCachedTrafficSummary(request.params.wsid, ws.version);

      // If not cached, analyze and cache
      if (!summary) {
        summary = analyzeWebSocketFramesV2(
          frames,
          request.params.wsid,
          ws.connection.url,
          frameIndices,
        );
        if (!request.params.direction) {
          context.cacheTrafficSummary(request.params.wsid, ws.version, summary);
        }
      }

      const indices = summary.groupToIndices.get(groupId);
      if (!indices || indices.length === 0) {
        throw new ToolError(
          'NOT_FOUND',
          `WebSocket group ${groupId} was not found. Available groups: ${summary.groups.map(group => group.id).join(', ') || 'none'}.`,
        );
      }

      // Apply direction filter to indices
      let filteredIndices = indices;
      if (request.params.direction) {
        const framesByIndex = new Map(
          ws.frames.map(frame => [frame.index, frame]),
        );
        filteredIndices = indices.filter(idx => {
          const frame = framesByIndex.get(idx);
          return frame && frame.direction === request.params.direction;
        });
      }

      const framePage = paginate(filteredIndices, {
        pageSize,
        pageIdx,
      });
      if (framePage.invalidPage) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `pageIdx ${pageIdx} is outside 0-${framePage.totalPages - 1}.`,
        );
      }
      const lines = formatGroupMessages(ws.frames, filteredIndices, groupId, {
        pageSize,
        pageIdx,
      });
      for (const line of lines) {
        response.appendResponseLine(line);
      }
      if (request.params.show_content) {
        const framesByIndex = new Map(
          ws.frames.map(frame => [frame.index, frame]),
        );
        for (const index of filteredIndices.slice(
          pageIdx * pageSize,
          (pageIdx + 1) * pageSize,
        )) {
          const frame = framesByIndex.get(index);
          if (frame) {
            for (const line of formatWebSocketFrameDetail(frame, index)) {
              response.appendResponseLine(line);
            }
          }
        }
      }
      response.setStructuredContent({
        wsid: request.params.wsid,
        version: ws.version,
        groupId,
        frameIndices: framePage.items,
        pagination: {
          pageIdx: framePage.currentPage,
          pageSize,
          totalItems: filteredIndices.length,
          totalPages: framePage.totalPages,
          hasNextPage: framePage.hasNextPage,
          hasPreviousPage: framePage.hasPreviousPage,
        },
      });
      return;
    }

    // Mode: Default - show recent messages
    response.appendResponseLine(
      `## Recent Messages (wsid=${request.params.wsid})`,
    );

    const framePage = paginate(frames, {pageSize, pageIdx});
    if (framePage.invalidPage) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pageIdx ${pageIdx} is outside 0-${framePage.totalPages - 1}.`,
      );
    }

    const lines = formatRecentMessages(frames, {
      pageSize,
      pageIdx,
      frameIndices,
    });
    for (const line of lines) {
      response.appendResponseLine(line);
    }
    if (request.params.show_content) {
      const pageFrames = frames.slice(
        pageIdx * pageSize,
        (pageIdx + 1) * pageSize,
      );
      for (const frame of pageFrames) {
        for (const line of formatWebSocketFrameDetail(frame, frame.index)) {
          response.appendResponseLine(line);
        }
      }
    }
    const pageFrames = framePage.items;
    response.setStructuredContent({
      wsid: request.params.wsid,
      version: ws.version,
      frames: pageFrames.map(frame => ({
        index: frame.index,
        direction: frame.direction,
        timestamp: frame.timestamp,
        opcode: frame.opcode,
        payloadBytes: frame.payloadBytes,
        ...(request.params.show_content
          ? {
              payloadData: frame.payloadData.slice(0, 10_000),
              truncated: frame.payloadData.length > 10_000,
            }
          : {}),
      })),
      pagination: {
        pageIdx: framePage.currentPage,
        pageSize,
        totalItems: frames.length,
        totalPages: framePage.totalPages,
        hasNextPage: framePage.hasNextPage,
        hasPreviousPage: framePage.hasPreviousPage,
      },
    });
  },
});
