/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JS Reverse Engineering Tools
 *
 * This module provides tools for JavaScript debugging and reverse engineering:
 * - Script listing and source retrieval
 * - Source code search
 * - Breakpoint management
 * - Request initiator (call stack) analysis
 */

import * as prettier from 'prettier';

import type {CallFrame, DebuggerContext} from '../DebuggerContext.js';
import {zod} from '../third_party/index.js';
import {ToolError} from '../ToolError.js';
import {paginate} from '../utils/pagination.js';

import {ToolCategory} from './categories.js';
import type {Response} from './ToolDefinition.js';
import {
  createToolOutputSchema,
  defineTool,
  PAGINATION_OUTPUT_SCHEMA,
  paginationSchema,
} from './ToolDefinition.js';

function requireDebuggerEnabled(debugger_: DebuggerContext): void {
  if (!debugger_.isEnabled()) {
    throw new ToolError(
      'PRECONDITION_FAILED',
      'Debugger is not enabled. Select a page and retry.',
    );
  }
}

function throwToolFailure(
  code: 'CDP_ERROR' | 'IO_ERROR',
  prefix: string,
  error: unknown,
): never {
  if (error instanceof ToolError) {
    throw error;
  }
  throw new ToolError(
    code,
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    {cause: error, retryable: code === 'CDP_ERROR'},
  );
}

/**
 * After a step command, append a concise summary of where execution stopped.
 * Shows: function name, location, arguments, and a small code snippet.
 */
async function appendStepSummary(
  response: Response,
  debugger_: DebuggerContext,
  action: string,
  frame: CallFrame,
): Promise<void> {
  const line = frame.location.lineNumber + 1; // CDP is 0-based
  const col = frame.location.columnNumber + 1;
  const funcName = frame.functionName || '<anonymous>';
  const url = frame.url || `script:${frame.location.scriptId}`;
  const shortUrl = url.split('/').pop() || url;

  response.appendResponseLine(
    `${action} → ${shortUrl}:${line}:${col}, function ${funcName}`,
  );

  // Show function arguments via evaluateOnCallFrame
  try {
    const argsResult = await debugger_.evaluateOnCallFrame(
      frame.callFrameId,
      `(() => { try { return JSON.stringify(Array.from(arguments)).slice(0, 500); } catch(e) { return String(arguments.length) + ' args'; } })()`,
      {returnByValue: true},
    );
    if (argsResult.result.value && !argsResult.exceptionDetails) {
      response.appendResponseLine(`  args: ${argsResult.result.value}`);
    }
  } catch {
    // arguments not available (e.g. arrow function or global scope)
  }

  // Show a small code snippet around the exact column position
  try {
    const result = await debugger_.getScriptSource(frame.location.scriptId);
    const source = result.scriptSource;
    const lines = source.split('\n');
    const lineContent = lines[frame.location.lineNumber];
    if (lineContent) {
      const snippetLen = 200;
      const half = Math.floor(snippetLen / 2);
      const c = frame.location.columnNumber;
      const s = Math.max(0, c - half);
      const e = Math.min(lineContent.length, s + snippetLen);
      const prefix = s > 0 ? '...' : '';
      const suffix = e < lineContent.length ? '...' : '';
      response.appendResponseLine(
        `  > ${prefix}${lineContent.substring(s, e)}${suffix}`,
      );
    }
  } catch {
    // Source unavailable
  }
}

/**
 * List all loaded JavaScript scripts in the current page.
 */
export const listScripts = defineTool({
  name: 'list_scripts',
  description:
    'Lists loaded JavaScript scripts, including inline and eval scripts. Returns 20 per page by default with script ID, URL/kind, and source map information. Script IDs are valid only for the current page load.',
  annotations: {
    title: 'List Scripts',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['debugger'],
  outputSchema: createToolOutputSchema({
    scripts: zod
      .array(
        zod.object({
          scriptId: zod.string(),
          url: zod.string().nullable(),
          kind: zod.enum(['external', 'inline_or_eval']),
          sourceMapURL: zod.string().nullable(),
          hash: zod.string(),
        }),
      )
      .optional(),
    pagination: PAGINATION_OUTPUT_SCHEMA.optional(),
  }),
  schema: {
    filter: zod
      .string()
      .optional()
      .describe(
        'Optional filter string to match against script URLs (case-insensitive partial match).',
      ),
    ...paginationSchema,
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    let scripts = debugger_.getScripts();

    // Apply filter if provided
    if (request.params.filter) {
      scripts = debugger_.getScriptsByUrlPattern(request.params.filter);
    }

    const paginated = paginate(scripts, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
    });
    if (paginated.invalidPage) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pageIdx ${request.params.pageIdx} is outside 0-${paginated.totalPages - 1}.`,
      );
    }
    const displayScripts = paginated.items;
    const pagination = {
      pageIdx: paginated.currentPage,
      pageSize: request.params.pageSize ?? 20,
      totalItems: scripts.length,
      totalPages: paginated.totalPages,
      hasNextPage: paginated.hasNextPage,
      hasPreviousPage: paginated.hasPreviousPage,
    };

    if (displayScripts.length === 0) {
      response.appendResponseLine('No scripts found.');
      response.setStructuredContent({scripts: [], pagination});
      return;
    }

    response.appendResponseLine(
      `Found ${scripts.length} script(s), showing ${paginated.startIndex + 1}-${paginated.endIndex}:\n`,
    );

    for (const script of displayScripts) {
      response.appendResponseLine(`- ID: ${script.scriptId}`);
      let displayUrl = script.url || '(inline/eval)';
      if (displayUrl.startsWith('data:') && displayUrl.length > 100) {
        displayUrl = displayUrl.substring(0, 100) + '... (truncated)';
      } else if (displayUrl.length > 200) {
        displayUrl = displayUrl.substring(0, 200) + '... (truncated)';
      }
      response.appendResponseLine(`  URL: ${displayUrl}`);
      if (script.sourceMapURL) {
        response.appendResponseLine(`  SourceMap: ${script.sourceMapURL}`);
      }
      response.appendResponseLine('');
    }
    if (paginated.hasNextPage) {
      response.appendResponseLine(
        `Next page: pageIdx=${paginated.currentPage + 1}`,
      );
    }
    response.setStructuredContent({
      scripts: displayScripts.map(script => ({
        scriptId: script.scriptId,
        url: script.url || null,
        kind: script.url ? 'external' : 'inline_or_eval',
        sourceMapURL: script.sourceMapURL ?? null,
        hash: script.hash,
      })),
      pagination,
    });
  },
});

/**
 * Get the source code of a script.
 */
export const getScriptSource = defineTool({
  name: 'get_script_source',
  description:
    'Gets a small snippet of a JavaScript script source by URL (recommended) or script ID. Supports line range (for normal files) or character offset (for minified single-line files). Prefer using url over scriptId — URLs remain stable across page navigations while script IDs become invalid after reload. This tool is designed for reading small code regions (e.g. around breakpoints or search results); specify startLine/endLine or offset/length for predictable inline output. If no range is provided, small sources are returned inline and large sources return a preview with guidance. To read an entire script file, especially a minified one, use save_script_source instead. WASM scripts cannot be shown inline; use save_script_source with a .wasm file path.',
  annotations: {
    title: 'Get Script Source',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['debugger'],
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'Script URL (preferred). Stable across page navigations. Exact match first, then substring match.',
      ),
    scriptId: zod
      .string()
      .optional()
      .describe(
        'Script ID (from list_scripts). Becomes invalid after page navigation — prefer url instead.',
      ),
    startLine: zod
      .number()
      .int()
      .optional()
      .describe('Start line number (1-based). Use for multi-line files.'),
    endLine: zod
      .number()
      .int()
      .optional()
      .describe('End line number (1-based). Use for multi-line files.'),
    offset: zod
      .number()
      .int()
      .optional()
      .describe(
        'Character offset to start from (0-based). Use for minified single-line files.',
      ),
    length: zod
      .number()
      .int()
      .optional()
      .default(1000)
      .describe(
        'Number of characters to return when using offset (default: 1000).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {url, startLine, endLine, offset, length} = request.params;
    let {scriptId} = request.params;

    if (!url && !scriptId) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        'Either url or scriptId must be provided.',
      );
    }

    try {
      let source: string;
      let bytecode: string | undefined;
      if (url) {
        const result = await debugger_.getScriptSourceByUrl(url);
        source = result.source;
        bytecode = result.bytecode;
        scriptId = result.script.scriptId;
        response.appendResponseLine(
          `Resolved URL to script ${scriptId} (${result.script.url}).\n`,
        );
      } else {
        const result = await debugger_.getScriptSource(scriptId!);
        source = result.scriptSource;
        bytecode = result.bytecode;
      }

      if (!source && !bytecode) {
        throw new ToolError(
          'NOT_FOUND',
          `No source found for script ${scriptId}.`,
        );
      }

      if (bytecode) {
        const binaryData = Buffer.from(bytecode, 'base64');
        response.appendResponseLine(
          `Script ${scriptId} is a WebAssembly binary file (${binaryData.length} bytes). Please use save_script_source to download it as a .wasm file.`,
        );
        response.setStructuredContent({
          scriptId,
          sourceType: 'wasm',
          byteLength: binaryData.length,
        });
        return;
      }

      // Character offset mode (for minified files)
      if (offset !== undefined) {
        const start = Math.max(0, offset);
        const end = Math.min(source.length, start + length);
        const extract = source.substring(start, end);

        const prefix = start > 0 ? '...' : '';
        const suffix = end < source.length ? '...' : '';

        response.appendResponseLine(
          `Source for script ${scriptId} (chars ${start}-${end} of ${source.length}):\n`,
        );
        response.appendResponseLine('```javascript');
        response.appendResponseLine(`${prefix}${extract}${suffix}`);
        response.appendResponseLine('```');
        response.setStructuredContent({
          scriptId,
          sourceType: 'javascript',
          startOffset: start,
          endOffset: end,
          totalChars: source.length,
          source: extract,
        });
        return;
      }

      // Line range mode (for normal files)
      if (startLine !== undefined || endLine !== undefined) {
        const lines = source.split('\n');
        const start = (startLine ?? 1) - 1; // Convert to 0-based
        const end = endLine ?? lines.length;
        const selectedLines = lines.slice(start, end);
        const content = selectedLines.join('\n');

        // If the selected range is too large, it's likely minified — suggest offset mode
        if (content.length > 1000) {
          const lineOffset = lines
            .slice(0, start)
            .reduce((sum, l) => sum + l.length + 1, 0);
          response.appendResponseLine(
            `Selected lines ${start + 1}-${Math.min(end, lines.length)} of script ${scriptId} are too large (${content.length} chars). This file is likely minified.`,
          );
          response.appendResponseLine(
            `Recommended: use save_script_source to download the full file — it auto-formats minified code so you can read it normally afterwards.`,
          );
          response.appendResponseLine(
            `Or use offset/length params for a partial read. The character offset for line ${start + 1} is ${lineOffset}.`,
          );
          response.appendResponseLine(`First 1000 characters:\n`);
          response.appendResponseLine('```javascript');
          response.appendResponseLine(content.substring(0, 1000) + '...');
          response.appendResponseLine('```');
          return;
        }

        response.appendResponseLine(
          `Source for script ${scriptId} (lines ${start + 1}-${Math.min(end, lines.length)}):\n`,
        );
        response.appendResponseLine('```javascript');
        for (let i = 0; i < selectedLines.length; i++) {
          response.appendResponseLine(`${start + i + 1}: ${selectedLines[i]}`);
        }
        response.appendResponseLine('```');
        response.setStructuredContent({
          scriptId,
          sourceType: 'javascript',
          startLine: start + 1,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
          source: selectedLines.join('\n'),
        });
        return;
      }

      // Full source - but warn if it's too large
      if (source.length > 1000) {
        response.appendResponseLine(
          `Script ${scriptId} is large (${source.length} chars). To view the whole file, use save_script_source (auto-formats minified code). To read a portion inline, use offset/length or startLine/endLine.`,
        );
        response.appendResponseLine(`First 1000 characters:\n`);
        response.appendResponseLine('```javascript');
        response.appendResponseLine(source.substring(0, 1000) + '...');
        response.appendResponseLine('```');
      } else {
        response.appendResponseLine(`Source for script ${scriptId}:\n`);
        response.appendResponseLine('```javascript');
        response.appendResponseLine(source);
        response.appendResponseLine('```');
      }
      response.setStructuredContent({
        scriptId,
        sourceType: 'javascript',
        totalChars: source.length,
        source:
          source.length > 1000 ? `${source.substring(0, 1000)}...` : source,
        truncated: source.length > 1000,
      });
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Failed to get script source', error);
    }
  },
});

/**
 * Save full script source to a local file.
 */
export const saveScriptSource = defineTool({
  name: 'save_script_source',
  description:
    'Saves the full source code of a JavaScript script to a local file. PREFERRED over get_script_source whenever you need the whole file or want to search/read a minified script. This tool auto-formats (beautifies) minified .js/.mjs/.ts output via prettier so the saved file is human-readable. Use this for any non-trivial source inspection; only fall back to get_script_source for tiny known regions (e.g. ±20 lines around a breakpoint). Typical workflow: call save_script_source, then inspect the saved local file with your available file-reading or search tools. NOTE: because the saved file may be beautified, its line numbers may not match the original script. If you later need to set a breakpoint, use the original URL/scriptId with set_breakpoint_on_text rather than line numbers from the saved file.',
  annotations: {
    title: 'Save Script Source',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  capabilities: ['debugger'],
  schema: {
    url: zod
      .string()
      .optional()
      .describe(
        'Script URL (preferred). Stable across page navigations. Exact match first, then substring match.',
      ),
    scriptId: zod
      .string()
      .optional()
      .describe(
        'Script ID (from list_scripts). Becomes invalid after page navigation — prefer url instead.',
      ),
    filePath: zod
      .string()
      .describe(
        'Local file path to save the script source to. Absolute paths and paths relative to the current working directory are supported. Use a .js/.mjs/.cjs/.jsx/.ts/.tsx extension to enable auto-format (prettier beautify); other extensions save raw source verbatim. For WASM scripts, use a .wasm extension. Subject to --allowedRoots when configured.',
      ),
    confirmOverwrite: zod
      .boolean()
      .default(false)
      .describe(
        'Must be true when filePath already exists. New files do not require confirmation.',
      ),
    format: zod
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Auto-format JavaScript/TypeScript output with prettier (beautifies minified code). Defaults to true. Set to false to save the raw original source verbatim.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {url, scriptId, filePath, format} = request.params;

    if (!url && !scriptId) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        'Either url or scriptId must be provided.',
      );
    }

    try {
      let source: string;
      let bytecode: string | undefined;
      let resolvedId = scriptId;
      if (url) {
        const result = await debugger_.getScriptSourceByUrl(url);
        source = result.source;
        bytecode = result.bytecode;
        resolvedId = result.script.scriptId;
        response.appendResponseLine(
          `Resolved URL to script ${resolvedId} (${result.script.url}).`,
        );
      } else {
        const result = await debugger_.getScriptSource(scriptId!);
        source = result.scriptSource;
        bytecode = result.bytecode;
      }

      if (!source && !bytecode) {
        throw new ToolError(
          'NOT_FOUND',
          `No source found for script ${resolvedId}.`,
        );
      }

      if (bytecode) {
        const binaryData = Buffer.from(bytecode, 'base64');
        const result = await context.saveFile(binaryData, filePath, {
          confirmOverwrite: request.params.confirmOverwrite,
        });
        response.appendResponseLine(
          `Saved WASM script source to ${result.filename} (${binaryData.length} bytes).`,
        );
        response.setStructuredContent({
          scriptId: resolvedId,
          filename: result.filename,
          byteLength: binaryData.length,
          sourceType: 'wasm',
        });
      } else {
        let output = source;
        let formatNote = '';
        const ext = filePath.toLowerCase().match(/\.(m?[jt]sx?)$/)?.[1];
        if (format && ext) {
          const parser = ext.startsWith('t') ? 'typescript' : 'babel';
          try {
            output = await prettier.format(source, {
              parser,
              printWidth: 120,
            });
            formatNote = ' (formatted)';
          } catch (err) {
            formatNote = ` (format skipped: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
          }
        }
        const data = new TextEncoder().encode(output);
        const result = await context.saveFile(data, filePath, {
          confirmOverwrite: request.params.confirmOverwrite,
        });
        response.appendResponseLine(
          `Saved script source to ${result.filename} (${output.length} chars${formatNote}).`,
        );
        response.setStructuredContent({
          scriptId: resolvedId,
          filename: result.filename,
          charLength: output.length,
          formatted: formatNote === ' (formatted)',
        });
      }
    } catch (error) {
      throwToolFailure('IO_ERROR', 'Failed to save script source', error);
    }
  },
});

/**
 * Search for a string in all loaded scripts.
 */
export const searchInSources = defineTool({
  name: 'search_in_sources',
  description:
    'Searches all loaded JavaScript sources, including inline/eval and compressed bundles by default. Returns matching lines with script ID, URL/kind, and line number. Use get_script_source for surrounding context.',
  annotations: {
    title: 'Search in Sources',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['debugger'],
  outputSchema: createToolOutputSchema({
    query: zod.string().optional(),
    totalMatches: zod.number().int().optional(),
    skippedMinified: zod.number().int().optional(),
    matches: zod
      .array(
        zod.object({
          scriptId: zod.string(),
          url: zod.string().nullable(),
          kind: zod.enum(['external', 'inline_or_eval']),
          lineNumber: zod.number().int(),
          lineContent: zod.string(),
        }),
      )
      .optional(),
  }),
  schema: {
    query: zod.string().describe('The search query (string or regex pattern).'),
    caseSensitive: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether the search should be case-sensitive.'),
    isRegex: zod
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to treat the query as a regular expression.'),
    maxResults: zod
      .number()
      .int()
      .optional()
      .default(30)
      .describe('Maximum number of results to return (default: 30).'),
    maxLineLength: zod
      .number()
      .int()
      .optional()
      .default(150)
      .describe(
        'Maximum characters per matched line preview (default: 150). Increase if you need more context around the match.',
      ),
    excludeMinified: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Skip minified files (files with very long lines). Default: false so compressed bundles are searched automatically.',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Only search scripts whose URL contains this string (case-insensitive).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {
      query,
      caseSensitive,
      isRegex,
      maxResults,
      maxLineLength,
      excludeMinified,
      urlFilter,
    } = request.params;

    try {
      const result = await debugger_.searchInScripts(query, {
        caseSensitive,
        isRegex,
      });

      if (result.matches.length === 0) {
        response.appendResponseLine(`No matches found for "${query}".`);
        response.setStructuredContent({query, totalMatches: 0, matches: []});
        return;
      }

      // Filter matches
      let filteredMatches = result.matches;

      // Apply URL filter
      if (urlFilter) {
        const lowerFilter = urlFilter.toLowerCase();
        filteredMatches = filteredMatches.filter(
          m => m.url && m.url.toLowerCase().includes(lowerFilter),
        );
      }

      // Filter out minified files (lines > 10000 chars)
      const minifiedThreshold = 10000;
      let skippedMinified = 0;
      if (excludeMinified) {
        const beforeCount = filteredMatches.length;
        filteredMatches = filteredMatches.filter(m => {
          if (m.lineContent.length > minifiedThreshold) {
            return false;
          }
          return true;
        });
        skippedMinified = beforeCount - filteredMatches.length;
      }

      if (filteredMatches.length === 0) {
        response.appendResponseLine(`No matches found for "${query}".`);
        if (skippedMinified > 0) {
          response.appendResponseLine(
            `(${skippedMinified} matches in minified files were skipped. Set excludeMinified=false to include them.)`,
          );
        }
        response.setStructuredContent({
          query,
          totalMatches: 0,
          skippedMinified,
          matches: [],
        });
        return;
      }

      const displayMatches = filteredMatches.slice(0, maxResults);
      const totalMatches = filteredMatches.length;
      const structuredMatches: Array<{
        scriptId: string;
        url: string | null;
        kind: 'external' | 'inline_or_eval';
        lineNumber: number;
        lineContent: string;
      }> = [];

      response.appendResponseLine(
        `Found ${totalMatches} match(es) for "${query}"${totalMatches > maxResults ? ` (showing first ${maxResults})` : ''}:`,
      );
      if (skippedMinified > 0) {
        response.appendResponseLine(
          `(${skippedMinified} matches in minified files skipped)`,
        );
      }
      response.appendResponseLine('');

      for (const match of displayMatches) {
        const lineNum = match.lineNumber + 1;
        const scriptId = match.scriptId;
        const url = match.url || '(inline)';

        // Truncate line content, centering around the match if possible
        let preview = match.lineContent.trim();
        const effectiveMaxLen = maxLineLength > 0 ? maxLineLength : 500;
        if (preview.length > effectiveMaxLen) {
          // Try to find the query position to center the preview
          const lowerContent = caseSensitive ? preview : preview.toLowerCase();
          const lowerQuery = caseSensitive ? query : query.toLowerCase();
          const matchPos = isRegex ? 0 : lowerContent.indexOf(lowerQuery);

          if (matchPos >= 0) {
            // Center around match position
            const halfLen = Math.floor(effectiveMaxLen / 2);
            let start = Math.max(0, matchPos - halfLen);
            let end = start + effectiveMaxLen;

            if (end > preview.length) {
              end = preview.length;
              start = Math.max(0, end - effectiveMaxLen);
            }

            const prefix = start > 0 ? '...' : '';
            const suffix = end < preview.length ? '...' : '';
            preview = prefix + preview.substring(start, end) + suffix;
          } else {
            // Fallback: truncate from start
            preview = preview.substring(0, effectiveMaxLen) + '...';
          }
        }

        response.appendResponseLine(`[${scriptId}] ${url}:${lineNum}`);
        response.appendResponseLine(`  ${preview}`);
        response.appendResponseLine('');
        structuredMatches.push({
          scriptId,
          url: match.url || null,
          kind: match.url ? 'external' : 'inline_or_eval',
          lineNumber: lineNum,
          lineContent: preview,
        });
      }

      response.appendResponseLine('---');
      response.appendResponseLine(
        'Tip: Use get_script_source(url=..., startLine, endLine) to view full context around a match. Using url is preferred over scriptId as it stays valid across page navigations.',
      );
      response.setStructuredContent({
        query,
        totalMatches,
        skippedMinified,
        matches: structuredMatches,
      });
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Source search failed', error);
    }
  },
});

/**
 * Remove breakpoint(s). Supports removing a single code breakpoint by ID,
 * a single XHR breakpoint by URL, or all breakpoints at once.
 */
export const removeBreakpoint = defineTool({
  name: 'remove_breakpoint',
  description:
    'Removes breakpoints using an explicit action. Use remove_code with breakpointId, remove_xhr with url, or remove_all with confirm=true.',
  annotations: {
    title: 'Remove Breakpoint',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
  capabilities: ['debugger'],
  schema: {
    action: zod
      .enum(['remove_code', 'remove_xhr', 'remove_all'])
      .describe('Explicit breakpoint removal action.'),
    breakpointId: zod
      .string()
      .optional()
      .describe(
        'The breakpoint ID to remove (from list_breakpoints or set_breakpoint_on_text).',
      ),
    url: zod
      .string()
      .optional()
      .describe('The XHR breakpoint URL pattern to remove.'),
    confirm: zod
      .boolean()
      .default(false)
      .describe('Must be true for any breakpoint removal action.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {action, breakpointId, url, confirm} = request.params;

    if (!confirm) {
      throw new ToolError(
        'CONFIRMATION_REQUIRED',
        'remove_breakpoint requires confirm=true.',
      );
    }

    try {
      if (action === 'remove_code') {
        if (!breakpointId) {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'action=remove_code requires breakpointId.',
          );
        }
        // Remove a single code breakpoint by ID
        await debugger_.removeBreakpoint(breakpointId);
        response.appendResponseLine(`Breakpoint ${breakpointId} removed.`);
        response.setStructuredContent({
          action,
          removed: {kind: 'code', breakpointId},
        });
      } else if (action === 'remove_xhr') {
        if (!url) {
          throw new ToolError(
            'INVALID_ARGUMENT',
            'action=remove_xhr requires url.',
          );
        }
        // Remove a single XHR breakpoint by URL
        await debugger_.removeXHRBreakpoint(url);
        response.appendResponseLine(`XHR breakpoint for "${url}" removed.`);
        response.setStructuredContent({
          action,
          removed: {kind: 'xhr', url},
        });
      } else {
        // Remove all breakpoints (code + XHR)
        const codeCount = debugger_.getBreakpoints().length;
        const xhrCount = debugger_.getXHRBreakpoints().length;
        if (codeCount === 0 && xhrCount === 0) {
          response.appendResponseLine('No active breakpoints to remove.');
          response.setStructuredContent({
            action,
            removed: {codeCount: 0, xhrCount: 0},
          });
          return;
        }
        const result = await debugger_.removeAllBreakpoints();
        if (result.failedCode.length || result.failedXHR.length) {
          throw new ToolError(
            'CDP_ERROR',
            `Breakpoint removal was partial: removed ${result.removedCode} code and ${result.removedXHR} XHR; failed ${result.failedCode.length} code and ${result.failedXHR.length} XHR. List breakpoints to inspect what remains.`,
            {retryable: true},
          );
        }
        const parts: string[] = [];
        if (result.removedCode > 0) parts.push(`${result.removedCode} code`);
        if (result.removedXHR > 0) parts.push(`${result.removedXHR} XHR`);
        response.appendResponseLine(
          `Removed ${parts.join(' + ')} breakpoint(s).`,
        );
        response.setStructuredContent({
          action,
          removed: {
            codeCount: result.removedCode,
            xhrCount: result.removedXHR,
          },
        });
      }

      if (debugger_.isPaused()) {
        response.appendResponseLine(
          'Execution is still paused. Use pause_or_resume(action="resume") when you are ready to continue.',
        );
      }
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Breakpoint removal failed', error);
    }
  },
});

/**
 * List all active breakpoints.
 */
export const listBreakpoints = defineTool({
  name: 'list_breakpoints',
  description:
    'Lists active code and XHR/Fetch breakpoints, 20 per page by default. Breakpoints are tracked by this MCP session and restored after navigation when possible.',
  annotations: {
    title: 'List Breakpoints',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['debugger'],
  outputSchema: createToolOutputSchema({
    breakpoints: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    pagination: PAGINATION_OUTPUT_SCHEMA.optional(),
  }),
  schema: paginationSchema,
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const breakpoints = debugger_.getBreakpoints();
    const xhrBreakpoints = debugger_.getXHRBreakpoints();
    const entries = [
      ...breakpoints.map(breakpoint => ({
        kind: 'code' as const,
        breakpoint,
      })),
      ...xhrBreakpoints.map(url => ({kind: 'xhr' as const, url})),
    ];

    const paginated = paginate(entries, {
      pageSize: request.params.pageSize,
      pageIdx: request.params.pageIdx,
    });
    if (paginated.invalidPage) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `pageIdx ${request.params.pageIdx} is outside 0-${paginated.totalPages - 1}.`,
      );
    }
    const pagination = {
      pageIdx: paginated.currentPage,
      pageSize: request.params.pageSize ?? 20,
      totalItems: entries.length,
      totalPages: paginated.totalPages,
      hasNextPage: paginated.hasNextPage,
      hasPreviousPage: paginated.hasPreviousPage,
    };

    if (breakpoints.length === 0 && xhrBreakpoints.length === 0) {
      response.appendResponseLine('No active breakpoints.');
      response.setStructuredContent({breakpoints: [], pagination});
      return;
    }

    response.appendResponseLine(
      `Active breakpoints (${breakpoints.length} code, ${xhrBreakpoints.length} XHR/Fetch):\n`,
    );

    response.appendResponseLine(
      `Showing ${paginated.startIndex + 1}-${paginated.endIndex} of ${entries.length}.`,
    );
    for (const entry of paginated.items) {
      if (entry.kind === 'code') {
        const bp = entry.breakpoint;
        response.appendResponseLine(`- ID: ${bp.breakpointId}`);
        response.appendResponseLine(`  URL: ${bp.url}`);
        response.appendResponseLine(
          `  Line: ${bp.lineNumber + 1}, Column: ${bp.columnNumber}`,
        );
        if (bp.condition) {
          response.appendResponseLine(`  Condition: ${bp.condition}`);
        }
        if (bp.locations.length > 0) {
          response.appendResponseLine(`  Locations: ${bp.locations.length}`);
        }
        response.appendResponseLine('');
      } else {
        response.appendResponseLine(`- XHR URL contains: ${entry.url}`);
      }
    }
    if (paginated.hasNextPage) {
      response.appendResponseLine(
        `Next page: pageIdx=${paginated.currentPage + 1}`,
      );
    }
    response.setStructuredContent({
      breakpoints: paginated.items.map(entry =>
        entry.kind === 'code'
          ? {
              kind: 'code',
              breakpointId: entry.breakpoint.breakpointId,
              url: entry.breakpoint.url,
              lineNumber: entry.breakpoint.lineNumber + 1,
              columnNumber: entry.breakpoint.columnNumber,
              condition: entry.breakpoint.condition ?? null,
            }
          : {kind: 'xhr', url: entry.url},
      ),
      pagination,
    });
  },
});

/**
 * Get the call stack (initiator) for a network request.
 */
export const getRequestInitiator = defineTool({
  name: 'get_request_initiator',
  description:
    'Gets the JavaScript call stack that initiated a network request. This helps trace which code triggered an API call.',
  annotations: {
    title: 'Get Request Initiator',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['network'],
  schema: {
    requestId: zod
      .number()
      .int()
      .describe(
        'The request ID (from list_network_requests) to get the initiator for.',
      ),
  },
  handler: async (request, response, context) => {
    const {requestId} = request.params;

    try {
      let httpRequest: ReturnType<typeof context.getNetworkRequestById>;
      try {
        httpRequest = context.getNetworkRequestById(requestId);
      } catch (error) {
        throw new ToolError(
          'NOT_FOUND',
          `Network request ${requestId} is no longer retained. List network requests and use a current reqid.`,
          {cause: error},
        );
      }
      const initiator = context.getRequestInitiator(httpRequest);

      if (!initiator) {
        response.appendResponseLine(
          `No initiator information found for request ${requestId}.`,
        );
        response.appendResponseLine(
          'This might be a navigation request or the initiator was not captured.',
        );
        response.setStructuredContent({requestId, initiator: null});
        return;
      }

      response.appendResponseLine(
        `Request initiator for ${httpRequest.url()}:\n`,
      );
      response.appendResponseLine(`Type: ${initiator.type}`);

      if (initiator.url) {
        response.appendResponseLine(`URL: ${initiator.url}`);
      }
      if (initiator.lineNumber !== undefined) {
        response.appendResponseLine(`Line: ${initiator.lineNumber + 1}`);
      }
      if (initiator.columnNumber !== undefined) {
        response.appendResponseLine(`Column: ${initiator.columnNumber}`);
      }

      if (initiator.stack && initiator.stack.callFrames.length > 0) {
        response.appendResponseLine('\nCall Stack:');
        for (let i = 0; i < initiator.stack.callFrames.length; i++) {
          const frame = initiator.stack.callFrames[i];
          const functionName = frame.functionName || '(anonymous)';
          const location = frame.url
            ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
            : `script ${frame.scriptId}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
          response.appendResponseLine(
            `  ${i + 1}. ${functionName} @ ${location}`,
          );
        }

        // Include parent stack if available (for async calls)
        if (
          initiator.stack.parent &&
          initiator.stack.parent.callFrames.length > 0
        ) {
          response.appendResponseLine('\nAsync Parent Stack:');
          for (let i = 0; i < initiator.stack.parent.callFrames.length; i++) {
            const frame = initiator.stack.parent.callFrames[i];
            const functionName = frame.functionName || '(anonymous)';
            const location = frame.url
              ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
              : `script ${frame.scriptId}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
            response.appendResponseLine(
              `  ${i + 1}. ${functionName} @ ${location}`,
            );
          }
        }
      }
      response.setStructuredContent({
        requestId,
        requestUrl: httpRequest.url(),
        initiator,
      });
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Failed to get request initiator', error);
    }
  },
});

/**
 * Get the current paused state and debug information.
 */
export const getPausedInfo = defineTool({
  name: 'get_paused_info',
  description:
    'Gets information about the current paused state including call stack, current location, and scope variables. Use this after a breakpoint is hit to understand the execution context.',
  annotations: {
    title: 'Get Paused Info',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: true,
  },
  capabilities: ['debugger'],
  outputSchema: createToolOutputSchema({
    paused: zod.boolean().optional(),
    reason: zod.string().nullable().optional(),
    hitBreakpoints: zod.array(zod.string()).optional(),
    callFrames: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
  }),
  schema: {
    includeScopes: zod
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to include scope variables (default: true).'),
    maxScopeDepth: zod
      .number()
      .int()
      .optional()
      .default(2)
      .describe(
        'Maximum scope depth to traverse (default: 2). ' +
          '1 = local scope only (function args & local vars), ' +
          '2 = local + closure scopes, ' +
          '3+ = all non-global scopes.',
      ),
    frameIndex: zod
      .number()
      .int()
      .optional()
      .default(0)
      .describe(
        'Which call frame to inspect scope variables for (0 = top frame). ' +
          'Use the call stack indices to pick a frame.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const pausedState = debugger_.getPausedState();

    if (!pausedState.isPaused) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        'Execution is not paused. Set a breakpoint and trigger it first.',
      );
    }

    response.appendResponseLine('🔴 Execution Paused\n');

    if (pausedState.reason) {
      response.appendResponseLine(`Reason: ${pausedState.reason}`);
    }

    if (pausedState.hitBreakpoints && pausedState.hitBreakpoints.length > 0) {
      response.appendResponseLine(
        `Hit breakpoints: ${pausedState.hitBreakpoints.join(', ')}`,
      );
    }

    response.appendResponseLine('\n📍 Call Stack:');

    for (let i = 0; i < pausedState.callFrames.length; i++) {
      const frame = pausedState.callFrames[i];
      const script = debugger_.getScriptById(frame.location.scriptId);
      const url =
        script?.url || frame.url || `script:${frame.location.scriptId}`;
      const location = `${url}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1}`;
      response.appendResponseLine(
        `  ${i}. ${frame.functionName} @ ${location}`,
      );
    }

    // Include scope variables if requested
    if (request.params.includeScopes && pausedState.callFrames.length > 0) {
      const frameIndex = request.params.frameIndex;
      if (frameIndex < 0 || frameIndex >= pausedState.callFrames.length) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `frameIndex ${frameIndex} is out of range (0-${pausedState.callFrames.length - 1}).`,
        );
      } else {
        const selectedFrame = pausedState.callFrames[frameIndex];
        response.appendResponseLine(
          `\n🔍 Scope Variables (frame ${frameIndex}: ${selectedFrame.functionName || '<anonymous>'}):`,
        );

        const maxDepth = request.params.maxScopeDepth;
        // Scope priority: local(1) > closure(2) > block/catch/with/etc(3+)
        // Always skip global scope
        const scopePriority: Record<string, number> = {
          local: 1,
          closure: 2,
        };
        let scopeCount = 0;

        for (const scope of selectedFrame.scopeChain) {
          if (scope.type === 'global') {
            continue;
          }

          const priority = scopePriority[scope.type] ?? 3;
          if (priority > maxDepth) {
            continue;
          }
          scopeCount++;

          const scopeName = scope.name || scope.type;
          response.appendResponseLine(`\n  [${scopeName}]:`);

          if (scope.object.objectId) {
            try {
              const variables = await debugger_.getScopeVariables(
                scope.object.objectId,
              );

              if (variables.length === 0) {
                response.appendResponseLine('    (empty)');
              } else {
                for (const variable of variables.slice(0, 20)) {
                  let valueStr =
                    typeof variable.value === 'string'
                      ? `"${variable.value}"`
                      : JSON.stringify(variable.value);
                  if (valueStr && valueStr.length > 200) {
                    valueStr = valueStr.slice(0, 200) + '...(truncated)';
                  }
                  response.appendResponseLine(
                    `    ${variable.name}: ${valueStr}`,
                  );
                }
                if (variables.length > 20) {
                  response.appendResponseLine(
                    `    ... and ${variables.length - 20} more`,
                  );
                }
              }
            } catch {
              response.appendResponseLine('    (unable to retrieve variables)');
            }
          }
        }

        if (scopeCount === 0) {
          response.appendResponseLine(
            '    (no matching scopes — try increasing maxScopeDepth)',
          );
        }
      }
    }

    response.appendResponseLine(
      '\n💡 Use pause_or_resume(action="resume") to resume, or step with direction="over" | "into" | "out" to continue one step.',
    );
    response.setStructuredContent({
      paused: true,
      reason: pausedState.reason ?? null,
      hitBreakpoints: pausedState.hitBreakpoints ?? [],
      callFrames: pausedState.callFrames.map((frame, index) => ({
        frameIndex: index,
        callFrameId: frame.callFrameId,
        functionName: frame.functionName,
        url: frame.url,
        location: frame.location,
      })),
    });
  },
});

/**
 * Resume execution after a breakpoint.
 */
export const pauseOrResume = defineTool({
  name: 'pause_or_resume',
  description:
    'Explicitly pauses or resumes JavaScript execution. Pass action="pause" or action="resume"; the tool never toggles implicitly.',
  annotations: {
    title: 'Pause / Resume',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  capabilities: ['debugger'],
  schema: {
    action: zod
      .enum(['pause', 'resume'])
      .describe('Explicit execution action: pause or resume.'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    try {
      if (request.params.action === 'resume') {
        if (!debugger_.isPaused()) {
          throw new ToolError(
            'CONFLICT',
            'Execution is already running; action=resume is not applicable.',
          );
        }
        await debugger_.resume();
        response.appendResponseLine('▶️ Execution resumed.');
        response.setStructuredContent({action: 'resume', state: 'running'});
      } else {
        if (debugger_.isPaused()) {
          throw new ToolError(
            'CONFLICT',
            'Execution is already paused; action=pause is not applicable.',
          );
        }
        await debugger_.pause();
        response.appendResponseLine(
          '⏸️ Pause requested. Waiting for execution to pause...',
        );
        response.setStructuredContent({
          action: 'pause',
          state: 'pause_requested',
        });
      }
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Execution action failed', error);
    }
  },
});

/**
 * Step execution: over, into, or out.
 */
export const step = defineTool({
  name: 'step',
  description:
    'Steps JavaScript execution. Use direction "over" to skip function calls, "into" to enter function bodies, "out" to exit the current function. Returns the new location with source context.',
  annotations: {
    title: 'Step',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  capabilities: ['debugger'],
  schema: {
    direction: zod
      .enum(['over', 'into', 'out'])
      .describe(
        'Step direction: "over" (next statement), "into" (enter function), "out" (exit function).',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    if (!debugger_.isPaused()) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        'Execution is not paused. Cannot step.',
      );
    }

    const {direction} = request.params;
    const labels = {
      over: '⏭️ Stepped over',
      into: '⬇️ Stepped into',
      out: '⬆️ Stepped out',
    } as const;

    try {
      const frame =
        direction === 'over'
          ? await debugger_.stepOver()
          : direction === 'into'
            ? await debugger_.stepInto()
            : await debugger_.stepOut();
      await appendStepSummary(response, debugger_, labels[direction], frame);
      response.setStructuredContent({
        direction,
        callFrame: {
          callFrameId: frame.callFrameId,
          functionName: frame.functionName,
          url: frame.url,
          location: frame.location,
        },
      });
    } catch (error) {
      throwToolFailure('CDP_ERROR', `Failed to step ${direction}`, error);
    }
  },
});

/**
 * Set a breakpoint on specific code text (function name, statement, etc.)
 * Combines search + locate + set breakpoint in one step.
 */
export const setBreakpointOnText = defineTool({
  name: 'set_breakpoint_on_text',
  description:
    'Sets a breakpoint on specific code (function name, statement, etc.) by searching loaded scripts and automatically determining a position. Optionally pass condition to reduce noisy hits after the code location is already precise; prefer text/urlFilter/occurrence for locating the breakpoint, and use condition only as a simple synchronous guard. Works with both normal and minified URL-backed scripts. Inline/eval scripts without a URL can be found but cannot receive this persistent URL breakpoint. Breakpoints persist across page navigations when the URL can be matched again.',
  annotations: {
    title: 'Set Breakpoint on Text',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  capabilities: ['debugger'],
  schema: {
    text: zod
      .string()
      .describe(
        'The code text to find and set breakpoint on (e.g., "function myFunc", "fetchData(", "apiCall").',
      ),
    urlFilter: zod
      .string()
      .optional()
      .describe(
        'Only search in scripts whose URL contains this string (case-insensitive).',
      ),
    occurrence: zod
      .number()
      .int()
      .positive()
      .optional()
      .default(1)
      .describe('Which occurrence to break on (1 = first, 2 = second, etc.).'),
    condition: zod
      .string()
      .optional()
      .describe(
        'Optional synchronous JavaScript condition evaluated in the breakpoint call frame. Use only as a simple guard after choosing a precise code location; avoid complex logic, async work, or side effects. The breakpoint pauses only when this expression evaluates to true.',
      ),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {text, urlFilter, occurrence, condition} = request.params;

    try {
      // Step 1: Search for the text in all scripts
      const searchResult = await debugger_.searchInScripts(text, {
        caseSensitive: true,
        isRegex: false,
      });

      if (searchResult.matches.length === 0) {
        throw new ToolError(
          'NOT_FOUND',
          `"${text}" was not found in any loaded script.`,
        );
      }

      // Apply URL filter if specified
      let matches = searchResult.matches;
      if (urlFilter) {
        const lowerFilter = urlFilter.toLowerCase();
        matches = matches.filter(
          m => m.url && m.url.toLowerCase().includes(lowerFilter),
        );
        if (matches.length === 0) {
          throw new ToolError(
            'NOT_FOUND',
            `"${text}" was not found in scripts matching "${urlFilter}".`,
          );
        }
      }

      // Get the specified occurrence
      if (occurrence > matches.length) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `Only ${matches.length} occurrence(s) found, but occurrence ${occurrence} was requested.`,
        );
      }

      const match = matches[occurrence - 1];
      const script = debugger_.getScriptById(match.scriptId);
      const url = script?.url || match.url;

      if (!url) {
        throw new ToolError(
          'PRECONDITION_FAILED',
          'Cannot set breakpoint: script has no URL (inline script).',
        );
      }

      // Step 2: Get exact column position by searching in the script source
      const result = await debugger_.getScriptSource(match.scriptId);
      const source = result.scriptSource;
      let columnNumber = 0;

      // For minified files, find exact column
      const lines = source.split('\n');
      if (match.lineNumber < lines.length) {
        const lineContent = lines[match.lineNumber];
        const colPos = lineContent.indexOf(text);
        if (colPos >= 0) {
          columnNumber = colPos;
        }
      }

      // Step 3: Set the breakpoint
      const breakpointInfo = await debugger_.setBreakpoint(
        url,
        match.lineNumber,
        columnNumber,
        condition,
      );

      response.appendResponseLine(`✅ Breakpoint set successfully!`);
      response.appendResponseLine(`- ID: ${breakpointInfo.breakpointId}`);
      response.appendResponseLine(`- URL: ${url}`);
      response.appendResponseLine(
        `- Line: ${match.lineNumber + 1}, Column: ${columnNumber}`,
      );
      if (condition) {
        response.appendResponseLine(`- Condition: ${condition}`);
      }

      // Show context
      const contextStart = Math.max(0, columnNumber - 50);
      const contextEnd = Math.min(
        lines[match.lineNumber].length,
        columnNumber + text.length + 50,
      );
      const preview = lines[match.lineNumber].substring(
        contextStart,
        contextEnd,
      );
      const prefix = contextStart > 0 ? '...' : '';
      const suffix = contextEnd < lines[match.lineNumber].length ? '...' : '';

      response.appendResponseLine('');
      response.appendResponseLine('Context:');
      response.appendResponseLine('```javascript');
      response.appendResponseLine(`${prefix}${preview}${suffix}`);
      response.appendResponseLine('```');
      response.setStructuredContent({
        breakpointId: breakpointInfo.breakpointId,
        url,
        lineNumber: match.lineNumber + 1,
        columnNumber,
        condition: condition ?? null,
      });
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Failed to set breakpoint', error);
    }
  },
});

/**
 * Set XHR/Fetch breakpoint.
 */
export const breakOnXhr = defineTool({
  name: 'break_on_xhr',
  description:
    'Sets a breakpoint that triggers when an XHR/Fetch request URL contains the specified string.',
  annotations: {
    title: 'Break on XHR',
    category: ToolCategory.REVERSE_ENGINEERING,
    readOnlyHint: false,
  },
  capabilities: ['debugger'],
  schema: {
    url: zod.string().describe('URL pattern to break on (partial match).'),
  },
  handler: async (request, response, context) => {
    const debugger_ = context.debuggerContext;

    requireDebuggerEnabled(debugger_);

    const {url} = request.params;
    const client = debugger_.getClient();

    if (!client) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        'Debugger client not available.',
      );
    }

    try {
      await debugger_.setXHRBreakpoint(url);
      response.appendResponseLine(
        `✅ XHR breakpoint set for URLs containing: "${url}"`,
      );
      response.appendResponseLine(
        'Debugger will pause when a matching XHR/Fetch request is made.',
      );
      response.setStructuredContent({kind: 'xhr', urlPattern: url});
    } catch (error) {
      throwToolFailure('CDP_ERROR', 'Failed to set XHR breakpoint', error);
    }
  },
});
