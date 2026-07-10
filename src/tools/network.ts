/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type NetworkExportPart,
  exportNetworkRequestPart,
} from '../formatters/networkFormatter.js';
import {zod} from '../third_party/index.js';
import {ToolError} from '../ToolError.js';

import {ToolCategory} from './categories.js';
import {
  createToolOutputSchema,
  defineTool,
  PAGINATION_OUTPUT_SCHEMA,
} from './ToolDefinition.js';

// Resource types as string literals (Playwright returns string from resourceType())
const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'other',
] as const;

// HTTP request methods for filtering (matched case-insensitively against
// request.method()).
const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const;

const NETWORK_EXPORT_PARTS = [
  'all',
  'responseHeaders',
  'responseBody',
  'requestBody',
  'queryParams',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List network requests for the currently selected page. Requests are held in a flat FIFO queue that is not cleared on navigation, so a request that already fired stays inspectable after the page moves on; the queue keeps the most recent 5000 requests. List and Set-Cookie flow modes both default to 20 items per page and use pageSize/pageIdx. Filters combine with AND; multiple values within one filter combine with OR. Pass reqid for bounded details, or reqid plus outputFile for exact export data.`,
  annotations: {
    category: ToolCategory.NETWORK,
    // Not read-only due to outputFile export support.
    readOnlyHint: false,
  },
  capabilities: ['network', 'devtools-ui'],
  outputSchema: createToolOutputSchema({
    requests: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    cookieFlow: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    request: zod.record(zod.string(), zod.unknown()).optional(),
    export: zod.record(zod.string(), zod.unknown()).optional(),
    reqid: zod.number().optional(),
    pagination: PAGINATION_OUTPUT_SCHEMA.optional(),
  }),
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of a specific network request to get full details for. If omitted, lists all requests.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of requests or Set-Cookie flow updates to return. Defaults to 20.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    methods: zod
      .array(zod.enum(HTTP_METHODS))
      .optional()
      .describe(
        'Filter requests by HTTP method (the request verb). Matched case-insensitively. Pass one or more of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS; multiple values are OR-ed (e.g. ["POST"] shows only POSTs, ["GET","POST"] shows both). Use this to hunt for submissions (POST/PUT/PATCH) versus reads (GET). This is the HTTP verb, distinct from resourceTypes which filters by resource category (xhr, document, ...). When omitted or empty, methods are not filtered.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types (xhr, fetch, document, script, ...). This is the resource category, NOT the HTTP verb — use methods for GET/POST filtering. When omitted or empty, returns all requests.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Filter requests by URL. Only requests containing this substring will be returned.',
      ),
    cookieName: zod
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Switch to Set-Cookie flow mode for an exact response cookie name. Returns matching responses oldest-first using the same pageSize/pageIdx pagination. Does not match request Cookie headers.',
      ),
    outputFile: zod
      .string()
      .optional()
      .describe(
        'When reqid is provided, save network data to this local file instead of returning only inline text. Use this for exact bytes, large bodies, long GET query payloads, binary responses, replay/signature inputs, or data that will be decoded with external tools. Absolute paths and paths relative to the current working directory are supported. The response reports the resolved absolute path; use that path with evaluate_script localFilePath when browser-side processing is needed. Subject to --allowedRoots when configured.',
      ),
    confirmOverwrite: zod
      .boolean()
      .default(false)
      .describe(
        'Must be true when outputFile already exists. New files do not require confirmation.',
      ),
    outputPart: zod
      .enum(NETWORK_EXPORT_PARTS)
      .default('all')
      .describe(
        'Which part to export when outputFile is provided. "responseHeaders" saves response headers as JSON while preserving repeated headers such as Set-Cookie, "responseBody" saves raw response bytes, "requestBody" saves captured request body bytes, "queryParams" saves parsed URL query parameters as JSON, and "all" saves a JSON bundle with metadata, headers, query params, and body content/metadata. Defaults to "all".',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.outputFile && request.params.reqid === undefined) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        'outputFile requires reqid. First call list_network_requests without outputFile to find the request id, then re-run with reqid and outputFile.',
      );
    }

    if (request.params.reqid !== undefined) {
      if (request.params.outputFile) {
        const networkRequest = context.getNetworkRequestById(
          request.params.reqid,
        );
        const outputPart = request.params.outputPart as NetworkExportPart;
        const exported = await exportNetworkRequestPart(
          networkRequest,
          outputPart,
        );
        const file = await context.saveFile(
          exported.data,
          request.params.outputFile,
          {confirmOverwrite: request.params.confirmOverwrite},
        );
        response.appendResponseLine(
          `${exported.summary} Saved ${outputPart} to ${file.filename}.`,
        );
        response.setStructuredContent({
          reqid: request.params.reqid,
          export: {
            outputPart,
            filename: file.filename,
            byteLength: exported.data.length,
          },
        });
        return;
      }

      response.attachNetworkRequest(request.params.reqid);
      return;
    }
    const data = await context.getDevToolsData();
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
      methods: request.params.methods,
      resourceTypes: request.params.resourceTypes,
      urlFilter: request.params.urlFilter,
      cookieName: request.params.cookieName,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});

export const clearNetworkRequests = defineTool({
  name: 'clear_network_requests',
  description: `Clear all collected network requests for the currently selected page after confirm=true. This drops the in-memory request queue, releases the cached response-body byte budget, and clears initiator maps. It does not touch browser cookies, HTTP cache, storage, console, or WebSocket messages. reqids are not reused.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  schema: {
    confirm: zod
      .boolean()
      .default(false)
      .describe(
        'Must be true to confirm deletion of the selected page network history and cached bodies.',
      ),
  },
  handler: async (request, response, context) => {
    if (!request.params.confirm) {
      throw new ToolError(
        'CONFIRMATION_REQUIRED',
        'clear_network_requests requires confirm=true because the captured request history cannot be restored.',
      );
    }
    const {requestCount, reclaimedBytes} = context.clearNetworkRequests();
    response.appendResponseLine(
      `Cleared ${requestCount} network request${
        requestCount === 1 ? '' : 's'
      } for the selected page.`,
    );
    response.appendResponseLine(
      `Released ${reclaimedBytes} bytes of cached response bodies.`,
    );
    response.appendResponseLine('Request initiator data cleared.');
    response.appendResponseLine(
      'reqids are not reused — newly collected requests continue from the previous high-water mark.',
    );
    response.setStructuredContent({requestCount, reclaimedBytes});
  },
});
