/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';
import path from 'node:path';

import type {DebuggerContext} from '../DebuggerContext.js';
import {openLocalFileReadAllowed} from '../LocalFileAccess.js';
import {zod} from '../third_party/index.js';
import type {JSHandle} from '../third_party/index.js';
import {ToolError} from '../ToolError.js';

import {ToolCategory} from './categories.js';
import {createToolOutputSchema, defineTool} from './ToolDefinition.js';

// Default script evaluation timeout in milliseconds (30 seconds)
const DEFAULT_SCRIPT_TIMEOUT = 30000;
const INLINE_EVAL_RESULT_LIMIT = 8192;
const MAX_LOCAL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PAUSED_LOCAL_FILE_BYTES = 512 * 1024;

interface LocalFileInput {
  path: string;
  name: string;
  size: number;
  base64: string;
  text?: string;
}

async function loadLocalFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<LocalFileInput> {
  signal?.throwIfAborted();
  if (filePath.startsWith('file://')) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'localFilePath must be an absolute path, not a file:// URL.',
    );
  }

  if (filePath.startsWith('~')) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'localFilePath must be an absolute path; ~ is not expanded.',
    );
  }

  if (!path.isAbsolute(filePath)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'localFilePath must be an absolute path.',
    );
  }

  if (/[{}[\]*?]/.test(filePath)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      'localFilePath must point to one file; globs are not supported.',
    );
  }

  let opened: Awaited<ReturnType<typeof openLocalFileReadAllowed>>;
  try {
    opened = await openLocalFileReadAllowed(filePath);
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError(
      'IO_ERROR',
      `Could not resolve localFilePath: ${error instanceof Error ? error.message : String(error)}`,
      {cause: error},
    );
  }
  const {handle, resolvedPath, stat} = opened;
  let data: Buffer;
  try {
    signal?.throwIfAborted();

    if (stat.size > MAX_LOCAL_FILE_BYTES) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `localFilePath is too large (${stat.size} bytes). Maximum supported size is ${MAX_LOCAL_FILE_BYTES} bytes.`,
      );
    }

    const buffer = Buffer.allocUnsafe(MAX_LOCAL_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const {bytesRead} = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > MAX_LOCAL_FILE_BYTES) {
      throw new ToolError(
        'INVALID_ARGUMENT',
        `localFilePath exceeds the maximum supported size of ${MAX_LOCAL_FILE_BYTES} bytes.`,
      );
    }
    data = buffer.subarray(0, offset);
  } catch (error) {
    if (
      error instanceof ToolError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new ToolError('IO_ERROR', 'Could not read localFilePath.', {
      cause: error,
    });
  } finally {
    await handle.close();
  }
  const localFile: LocalFileInput = {
    path: resolvedPath,
    name: path.basename(resolvedPath),
    size: data.length,
    base64: data.toString('base64'),
  };

  if (isUtf8(data)) {
    localFile.text = data.toString('utf8');
  }

  return localFile;
}

async function runCancellableEvaluation<T>(
  signal: AbortSignal | undefined,
  debugger_: DebuggerContext,
  operation: () => Promise<T>,
): Promise<T> {
  const terminate = () => {
    void debugger_.terminateExecution().catch(() => undefined);
  };
  signal?.throwIfAborted();
  signal?.addEventListener('abort', terminate, {once: true});
  try {
    return await operation();
  } finally {
    signal?.removeEventListener('abort', terminate);
  }
}

export const evaluateScript = defineTool({
  name: 'evaluate_script',
  description: `Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable. Inline JSON results are bounded; use outputFile for exact large results. When execution is paused at a breakpoint, automatically evaluates in the paused call frame context. Use localFilePath when the function needs one local data file, commonly a network body or JSON exported by another tool. The MCP server reads the file and passes it as localFile; browser JavaScript does not read local paths. Local-file access can expose host data and is restricted by --allowedRoots when configured.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  capabilities: ['debugger'],
  timeoutMs: DEFAULT_SCRIPT_TIMEOUT,
  outputSchema: createToolOutputSchema({
    resultType: zod.string().optional(),
    value: zod.unknown().optional(),
    filename: zod.string().optional(),
    byteLength: zod.number().int().optional(),
    charLength: zod.number().int().optional(),
    truncated: zod.boolean().optional(),
  }),
  schema: {
    confirm: zod
      .boolean()
      .default(false)
      .describe(
        'Must be true because arbitrary page JavaScript can modify browser state, send network requests, or trigger external side effects.',
      ),
    function: zod.string().describe(
      `A JavaScript function declaration to be executed by the tool in the currently selected page.
Example without arguments: \`() => {
  return document.title
}\` or \`async () => {
  return await fetch("example.com")
}\`.
If localFilePath is provided, the function receives one argument: \`async ({ localFile }) => { ... }\`. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes. To keep data for later calls, assign it explicitly in JavaScript, for example \`window.__mcpPayload = JSON.parse(localFile.text)\` with mainWorld=true.
`,
    ),
    mainWorld: zod
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Execute the function in the page main world instead of the default isolated context. ' +
          'Use this when you need to access page-defined globals (e.g. window.bdms, window.app). ' +
          'Async functions are supported, and returned values must be JSON-serializable unless outputFile is used for binary data.',
      ),
    frameIndex: zod
      .number()
      .int()
      .optional()
      .describe(
        'When paused at a breakpoint, which call frame to evaluate in (0 = top frame). ' +
          'If omitted, uses the top frame. Use get_paused_info to see available frames.',
      ),
    outputFile: zod
      .string()
      .optional()
      .describe(
        'If provided, saves the evaluation result to this local file path instead of returning it in the chat. JSON-serializable results are saved as JSON text; ArrayBuffer and Uint8Array results are saved as raw bytes. Useful for dumping large data or binary memory regions. The response reports the resolved absolute path. Subject to --allowedRoots when configured.',
      ),
    confirmOverwrite: zod
      .boolean()
      .default(false)
      .describe(
        'Must be true when outputFile already exists. New files do not require confirmation.',
      ),
    localFilePath: zod
      .string()
      .optional()
      .describe(
        'Absolute path to one local file to pass to the evaluated function as localFile. Relative paths, file:// URLs, globs, ~, and directories are rejected. If provided, write the function as async ({ localFile }) => { ... }. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes. Subject to --allowedRoots when configured.',
      ),
  },
  handler: async (request, response, context) => {
    if (!request.params.confirm) {
      throw new ToolError(
        'CONFIRMATION_REQUIRED',
        'evaluate_script requires confirm=true because the supplied function can cause page and external side effects.',
      );
    }
    const {
      function: fnString,
      mainWorld,
      frameIndex,
      outputFile,
      localFilePath,
    } = request.params;
    const localFile = localFilePath
      ? await loadLocalFile(localFilePath, request.signal)
      : undefined;

    if (localFile) {
      response.appendResponseLine(
        `Loaded local file ${localFile.path} (${localFile.size} bytes).`,
      );
    }

    const callExpression = localFile
      ? `(${fnString})(${JSON.stringify({localFile})})`
      : `(${fnString})()`;

    const wrapResultAsync = () => `async () => {
      try {
        const result = await ${callExpression};
        if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
          const buffer = result.buffer || result;
          const bytes = new Uint8Array(buffer, result.byteOffset || 0, result.byteLength || result.length);
          if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined') {
            const blob = new Blob([bytes]);
            return await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(JSON.stringify({ type: 'base64', data: reader.result.split(',')[1] }));
              reader.readAsDataURL(blob);
            });
          } else {
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
            }
            return JSON.stringify({ type: 'base64', data: btoa(binary) });
          }
        }
        return JSON.stringify({ type: 'json', data: JSON.stringify(result) });
      } catch (e) {
        return JSON.stringify({ type: 'error', data: e.message || String(e) });
      }
    }`;

    const wrapPausedResult = () => `() => {
      try {
        const result = ${callExpression};
        if (result instanceof Promise) {
          return result;
        }
        if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
          const buffer = result.buffer || result;
          const bytes = new Uint8Array(buffer, result.byteOffset || 0, result.byteLength || result.length);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
          }
          return JSON.stringify({ type: 'base64', data: btoa(binary) });
        }
        return JSON.stringify({ type: 'json', data: JSON.stringify(result) });
      } catch (e) {
        return JSON.stringify({ type: 'error', data: e.message || String(e) });
      }
    }`;

    const handleEvalResult = async (rawString: string) => {
      let parsed: {type: string; data: string};
      try {
        parsed = JSON.parse(rawString);
      } catch {
        parsed = {type: 'json', data: rawString};
      }

      if (parsed.type === 'error') {
        throw new ToolError(
          'CDP_ERROR',
          `Script evaluation error: ${parsed.data}`,
        );
      }

      if (outputFile) {
        if (parsed.type === 'base64') {
          const binaryData = Buffer.from(parsed.data, 'base64');
          const res = await context.saveFile(binaryData, outputFile, {
            confirmOverwrite: request.params.confirmOverwrite,
          });
          response.appendResponseLine(
            `Saved binary memory dump to ${res.filename} (${binaryData.length} bytes).`,
          );
          response.setStructuredContent({
            resultType: 'binary_file',
            filename: res.filename,
            byteLength: binaryData.length,
          });
        } else {
          const textData = new TextEncoder().encode(
            parsed.data === undefined ? 'undefined' : parsed.data,
          );
          const res = await context.saveFile(textData, outputFile, {
            confirmOverwrite: request.params.confirmOverwrite,
          });
          response.appendResponseLine(
            `Saved JSON result to ${res.filename} (${textData.length} bytes).`,
          );
          response.setStructuredContent({
            resultType: 'json_file',
            filename: res.filename,
            byteLength: textData.length,
          });
        }
        return;
      }

      response.appendResponseLine('Script ran on page and returned:');
      if (parsed.type === 'base64') {
        const byteLength = Buffer.from(parsed.data, 'base64').length;
        response.appendResponseLine(
          `[Binary Data: ${byteLength} bytes. Use outputFile to save to disk.]`,
        );
        response.setStructuredContent({resultType: 'binary', byteLength});
      } else {
        const data = parsed.data ?? 'undefined';
        const truncated = data.length > INLINE_EVAL_RESULT_LIMIT;
        if (truncated) {
          response.appendResponseLine(
            `Result is ${data.length} chars; inline output is truncated to ${INLINE_EVAL_RESULT_LIMIT} chars. Re-run with outputFile to save the exact result.`,
          );
        }
        response.appendResponseLine('```json');
        response.appendResponseLine(
          truncated
            ? `${data.slice(0, INLINE_EVAL_RESULT_LIMIT)}... <truncated ${data.length - INLINE_EVAL_RESULT_LIMIT} chars>`
            : data,
        );
        response.appendResponseLine('```');
        let value: unknown = data;
        try {
          value = JSON.parse(data);
        } catch {
          // Keep non-JSON values as their serialized string.
        }
        response.setStructuredContent({
          resultType: 'json',
          value: truncated
            ? `${data.slice(0, INLINE_EVAL_RESULT_LIMIT)}...`
            : value,
          truncated,
          charLength: data.length,
        });
      }
    };

    const debugger_ = context.debuggerContext;
    if (debugger_.isEnabled() && debugger_.isPaused()) {
      if (localFile && localFile.size > MAX_PAUSED_LOCAL_FILE_BYTES) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `localFilePath is too large for paused call-frame evaluation (${localFile.size} bytes). Maximum supported paused size is ${MAX_PAUSED_LOCAL_FILE_BYTES} bytes.`,
        );
      }

      const pausedState = debugger_.getPausedState();
      const frameIdx = frameIndex ?? 0;
      if (frameIdx < 0 || frameIdx >= pausedState.callFrames.length) {
        throw new Error(
          `frameIndex ${frameIdx} is out of range (0-${pausedState.callFrames.length - 1})`,
        );
      }
      const callFrameId = pausedState.callFrames[frameIdx]?.callFrameId;
      if (callFrameId) {
        const result = await debugger_.evaluateSettledPromiseOnCallFrame(
          callFrameId,
          `(${wrapPausedResult()})()`,
        );

        if (result.exceptionDetails) {
          const errMsg =
            result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text;
          throw new ToolError(
            'CDP_ERROR',
            `Script evaluation error: ${errMsg}`,
          );
        }

        if (
          result.settledPromise &&
          (result.result.subtype === 'arraybuffer' ||
            result.result.subtype === 'typedarray')
        ) {
          throw new ToolError(
            'PRECONDITION_FAILED',
            'Paused async binary results cannot be serialized safely. Resume execution or return JSON-serializable data.',
          );
        }
        const settledValue =
          result.settledPromise && result.result.objectId
            ? await debugger_.materializeRemoteObject(result.result)
            : result.result.value;
        const rawResult = result.settledPromise
          ? JSON.stringify({
              type: 'json',
              data: JSON.stringify(settledValue),
            })
          : (settledValue as string);
        await handleEvalResult(rawResult);
        return;
      }
    }

    if (mainWorld) {
      const frame = context.getSelectedFrame();
      const result = await runCancellableEvaluation(
        request.signal,
        debugger_,
        async () => {
          // Patchright defaults evaluate() to its utility world. Its third
          // parameter selects the frame's main world directly. This preserves
          // the selected iframe execution context and avoids the CSP-blocked
          // inline <script> bridge previously used here.
          return await frame.evaluate(
            `(${wrapResultAsync()})()`,
            undefined,
            false,
          );
        },
      );

      await handleEvalResult(result as string);
      return;
    }

    let fnHandle: JSHandle<unknown> | undefined;
    try {
      const frame = context.getSelectedFrame();
      fnHandle = await runCancellableEvaluation(request.signal, debugger_, () =>
        frame.evaluateHandle(`(${wrapResultAsync()})`),
      );
      await context.waitForEventsAfterAction(async () => {
        const result = await runCancellableEvaluation(
          request.signal,
          debugger_,
          () =>
            frame.evaluate(async fn => {
              // @ts-expect-error no types.
              return await fn();
            }, fnHandle),
        );
        await handleEvalResult(result as string);
      });
    } finally {
      if (fnHandle) {
        await fnHandle.dispose();
      }
    }
  },
});
