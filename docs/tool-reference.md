<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

**Total: 24 tools.**

Every tool declares an MCP output schema. Successful calls and errors raised by
tool handlers or runtime operations return `structuredContent` with a stable
envelope: `ok`, `tool`, `summary`, optional machine-readable `data`, and an
`error` object (`code`, `message`, `retryable`) on failure. Protocol-level
input validation errors use the standard MCP/JSON-RPC error response. Text
content is kept for human-readable compatibility.

- **[Navigation automation](#navigation-automation)** (4 tools)
  - [`click_element`](#click_element)
  - [`navigate_page`](#navigate_page)
  - [`new_page`](#new_page)
  - [`select_page`](#select_page)
- **[Browser state](#browser-state)** (1 tool)
  - [`clear_site_data`](#clear_site_data)
- **[Network](#network)** (3 tools)
  - [`clear_network_requests`](#clear_network_requests)
  - [`get_websocket_messages`](#get_websocket_messages)
  - [`list_network_requests`](#list_network_requests)
- **[Debugging](#debugging)** (4 tools)
  - [`evaluate_script`](#evaluate_script)
  - [`list_console_messages`](#list_console_messages)
  - [`select_frame`](#select_frame)
  - [`take_screenshot`](#take_screenshot)
- **[JS Reverse Engineering](#js-reverse-engineering)** (12 tools)
  - [`break_on_xhr`](#break_on_xhr)
  - [`get_paused_info`](#get_paused_info)
  - [`get_request_initiator`](#get_request_initiator)
  - [`get_script_source`](#get_script_source)
  - [`list_breakpoints`](#list_breakpoints)
  - [`list_scripts`](#list_scripts)
  - [`pause_or_resume`](#pause_or_resume)
  - [`remove_breakpoint`](#remove_breakpoint)
  - [`save_script_source`](#save_script_source)
  - [`search_in_sources`](#search_in_sources)
  - [`set_breakpoint_on_text`](#set_breakpoint_on_text)
  - [`step`](#step)

## Navigation automation

### `click_element`

**Description:** Clicks one visible element after confirm=true using a CSS selector. The selector must resolve to exactly one element unless index is explicit. Returns resolved element metadata so the action is auditable.

**Parameters:**

- **button** (enum: "left", "middle", "right") _(optional)_: Mouse button. Defaults to left.
- **confirm** (boolean) _(optional)_: Must be true because a click can cause external side effects.
- **index** (integer) _(optional)_: Explicit zero-based match index. Required when the selector matches more than one element.
- **modifiers** (array) _(optional)_: Optional keyboard modifiers held during the click.
- **selector** (string) **(required)**: CSS selector evaluated in the currently selected frame.
- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.

---

### `navigate_page`

**Description:** Navigates the currently selected page to a URL, or performs back/forward/reload navigation. This tool only navigates; it does not clear cookies, storage, cache, or site data. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds. After navigation, stale script IDs are cleared and fresh ones are captured automatically when the debugger is enabled. Tracked code URL breakpoints and XHR/Fetch breakpoints are restored across navigation when possible.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **type** (enum: "url", "back", "forward", "reload") _(optional)_: Navigate the page by URL, back or forward in history, or reload.
- **url** (string) _(optional)_: Target URL (only type=url)

---

### `new_page`

**Description:** Opens a browser page and navigates to the specified URL. If an existing about:blank startup tab is still available, it is reused instead of opening an extra tab. Waits for DOMContentLoaded event (not full page load). Default timeout is 10 seconds.

**Parameters:**

- **timeout** (integer) _(optional)_: Maximum wait time in milliseconds. If set to 0, the default timeout will be used.
- **url** (string) **(required)**: URL to load in the opened browser page.

---

### `select_page`

**Description:** Lists open pages, 20 per page by default. Pass pageIdx to select a page; use listPageIdx only to paginate the listing.

**Parameters:**

- **listPageIdx** (integer) _(optional)_: Page of the page-list to return (0-based). Defaults to 0.
- **pageIdx** (number) _(optional)_: The index of the page to select. If omitted, lists all pages without changing selection.
- **pageSize** (integer) _(optional)_: Maximum pages to list per response. Defaults to 20.

---

## Browser state

### `clear_site_data`

**Description:** Clear browser state after confirm=true to create a clean replay environment for the selected page. This clears cookies affecting its HTTP(S) frames, persistent storage for those origins, and frame sessionStorage. It does not reload. Browser HTTP cache is global and preserved by default; opt in with clearBrowserCache only when that wider effect is intended.

**Parameters:**

- **clearBrowserCache** (boolean) _(optional)_: Also clear the browser-wide HTTP cache. This affects every page and origin in the browser, not only the selected site.
- **confirm** (boolean) _(optional)_: Must be true to confirm deletion of cookies and origin storage for the selected page frames.

---

## Network

### `clear_network_requests`

**Description:** Clear all collected network requests for the currently selected page after confirm=true. This drops the in-memory request queue, releases the cached response-body byte budget, and clears initiator maps. It does not touch browser cookies, HTTP cache, storage, console, or WebSocket messages. reqids are not reused.

**Parameters:**

- **confirm** (boolean) _(optional)_: Must be true to confirm deletion of the selected page network history and cached bodies.

---

### `get_websocket_messages`

**Description:** Lists WebSocket connections or gets messages for a specific connection. Without wsid, lists all connections. With wsid, gets messages. Set analyze=true to group messages by pattern. Use groupId to filter by group. Use frameIndex to get a single message's detail by the stable frame index shown in message tables and analysis samples.

**Parameters:**

- **analyze** (boolean) _(optional)_: Set to true to analyze and group messages by pattern/fingerprint. Returns statistics and sample indices for each message type.
- **direction** (enum: "sent", "received") _(optional)_: Filter by direction: "sent" or "received".
- **frameIndex** (integer) _(optional)_: Get a single retained message by its stable frame index. Indices are monotonic and may start above 0 after old frames are evicted; use the Idx values shown by message tables or analyze=true.
- **groupId** (string) _(optional)_: Filter by group ID (A, B, C, ...). Run with analyze=true first to get group IDs; if analyze used a direction filter, pass the same direction here.
- **includePreservedConnections** (boolean) _(optional)_: Set to true to return the preserved connections over the last 3 navigations (only for listing connections without wsid).
- **pageIdx** (integer) _(optional)_: Page number (0-based).
- **pageSize** (integer) _(optional)_: Messages per page (for messages mode) or connections per page (for list mode). Defaults to 10.
- **show_content** (boolean) _(optional)_: Set to true to append payload previews (up to 10,000 characters each) for the current page of messages. Default false (summary only).
- **urlFilter** (string) _(optional)_: Filter connections by URL (only for listing connections without wsid).
- **wsid** (number) _(optional)_: The wsid of the WebSocket connection. If omitted, lists all connections.

---

### `list_network_requests`

**Description:** List network requests for the currently selected page. Requests are held in a flat FIFO queue that is not cleared on navigation, so a request that already fired stays inspectable after the page moves on; the queue keeps the most recent 5000 requests. List and Set-Cookie flow modes both default to 20 items per page and use pageSize/pageIdx. Filters combine with AND; multiple values within one filter combine with OR. Pass reqid for bounded details, or reqid plus outputFile for exact export data.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Must be true when outputFile already exists. New files do not require confirmation.
- **cookieName** (string) _(optional)_: Switch to Set-Cookie flow mode for an exact response cookie name. Returns matching responses oldest-first using the same pageSize/pageIdx pagination. Does not match request Cookie headers.
- **methods** (array) _(optional)_: Filter requests by HTTP method (the request verb). Matched case-insensitively. Pass one or more of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS; multiple values are OR-ed (e.g. ["POST"] shows only POSTs, ["GET","POST"] shows both). Use this to hunt for submissions (POST/PUT/PATCH) versus reads (GET). This is the HTTP verb, distinct from resourceTypes which filters by resource category (xhr, document, ...). When omitted or empty, methods are not filtered.
- **outputFile** (string) _(optional)_: When reqid is provided, save network data to this local file instead of returning only inline text. Use this for exact bytes, large bodies, long GET query payloads, binary responses, replay/signature inputs, or data that will be decoded with external tools. Absolute paths and paths relative to the current working directory are supported. The response reports the resolved absolute path; use that path with [`evaluate_script`](#evaluate_script) localFilePath when browser-side processing is needed. Subject to --allowedRoots when configured.
- **outputPart** (enum: "all", "responseHeaders", "responseBody", "requestBody", "queryParams") _(optional)_: Which part to export when outputFile is provided. "responseHeaders" saves response headers as JSON while preserving repeated headers such as Set-Cookie, "responseBody" saves raw response bytes, "requestBody" saves captured request body bytes, "queryParams" saves parsed URL query parameters as JSON, and "all" saves a JSON bundle with metadata, headers, query params, and body content/metadata. Defaults to "all".
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of requests or Set-Cookie flow updates to return. Defaults to 20.
- **reqid** (number) _(optional)_: The reqid of a specific network request to get full details for. If omitted, lists all requests.
- **resourceTypes** (array) _(optional)_: Filter requests to only return requests of the specified resource types (xhr, fetch, document, script, ...). This is the resource category, NOT the HTTP verb — use methods for GET/POST filtering. When omitted or empty, returns all requests.
- **urlFilter** (string) _(optional)_: Filter requests by URL. Only requests containing this substring will be returned.

---

## Debugging

### `evaluate_script`

**Description:** Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable. Inline JSON results are bounded; use outputFile for exact large results. When execution is paused at a breakpoint, automatically evaluates in the paused call frame context. Use localFilePath when the function needs one local data file, commonly a network body or JSON exported by another tool. The MCP server reads the file and passes it as localFile; browser JavaScript does not read local paths. Local-file access can expose host data and is restricted by --allowedRoots when configured.

**Parameters:**

- **confirm** (boolean) _(optional)_: Must be true because arbitrary page JavaScript can modify browser state, send network requests, or trigger external side effects.
- **confirmOverwrite** (boolean) _(optional)_: Must be true when outputFile already exists. New files do not require confirmation.
- **frameIndex** (integer) _(optional)_: When paused at a breakpoint, which call frame to evaluate in (0 = top frame). If omitted, uses the top frame. Use [`get_paused_info`](#get_paused_info) to see available frames.
- **function** (string) **(required)**: A JavaScript function declaration to be executed by the tool in the currently selected page.
  Example without arguments: `() => {
  return document.title
}` or `async () => {
  return await fetch("example.com")
}`.
  If localFilePath is provided, the function receives one argument: `async ({ localFile }) => { ... }`. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes. To keep data for later calls, assign it explicitly in JavaScript, for example `window.__mcpPayload = JSON.parse(localFile.text)` with mainWorld=true.

- **localFilePath** (string) _(optional)_: Absolute path to one local file to pass to the evaluated function as localFile. Relative paths, file:// URLs, globs, ~, and directories are rejected. If provided, write the function as async ({ localFile }) => { ... }. Use localFile.text when present for UTF-8 text/JSON and localFile.base64 for exact bytes. Subject to --allowedRoots when configured.
- **mainWorld** (boolean) _(optional)_: Execute the function in the page main world instead of the default isolated context. Use this when you need to access page-defined globals (e.g. window.bdms, window.app). Async functions are supported, and returned values must be JSON-serializable unless outputFile is used for binary data.
- **outputFile** (string) _(optional)_: If provided, saves the evaluation result to this local file path instead of returning it in the chat. JSON-serializable results are saved as JSON text; ArrayBuffer and Uint8Array results are saved as raw bytes. Useful for dumping large data or binary memory regions. The response reports the resolved absolute path. Subject to --allowedRoots when configured.

---

### `list_console_messages`

**Description:** List console messages for the selected page, 20 per page by default. Pass msgid to get one message by stable ID.

**Parameters:**

- **includePreservedMessages** (boolean) _(optional)_: Set to true to return the preserved messages over the last 3 navigations.
- **msgid** (number) _(optional)_: The msgid of a console message on the page from the listed console messages
- **pageIdx** (integer) _(optional)_: Page number to return (0-based). When omitted, returns the first page.
- **pageSize** (integer) _(optional)_: Maximum number of messages to return. Defaults to 20.
- **types** (array) _(optional)_: Filter messages to only return messages of the specified console message types. When omitted or empty, returns all messages.

---

### `select_frame`

**Description:** Lists frames (including iframes), 20 per page by default. Pass frameIdx to switch [`evaluate_script`](#evaluate_script) context; use listPageIdx only to paginate the listing.

**Parameters:**

- **frameIdx** (integer) _(optional)_: The frame index to select. 0 = main frame. If omitted, lists all frames without changing selection.
- **listPageIdx** (integer) _(optional)_: Page of the frame-list to return (0-based). Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum frames to list per response. Defaults to 20.

---

### `take_screenshot`

**Description:** Take a screenshot of the currently selected page. By default captures the visible viewport; set fullPage=true to capture the full page.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Must be true when filePath already exists. New files do not require confirmation.
- **filePath** (string) _(optional)_: The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response. Subject to --allowedRoots when configured.
- **format** (enum: "png", "jpeg") _(optional)_: Type of format to save the screenshot as. Default is "png"
- **fullPage** (boolean) _(optional)_: If set to true, captures the full page instead of the currently visible viewport.
- **quality** (number) _(optional)_: Compression quality for JPEG format (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.

---

## JS Reverse Engineering

### `break_on_xhr`

**Description:** Sets a breakpoint that triggers when an XHR/Fetch request URL contains the specified string.

**Parameters:**

- **url** (string) **(required)**: URL pattern to break on (partial match).

---

### `get_paused_info`

**Description:** Gets information about the current paused state including call stack, current location, and scope variables. Use this after a breakpoint is hit to understand the execution context.

**Parameters:**

- **frameIndex** (integer) _(optional)_: Which call frame to inspect scope variables for (0 = top frame). Use the call stack indices to pick a frame.
- **includeScopes** (boolean) _(optional)_: Whether to include scope variables (default: true).
- **maxScopeDepth** (integer) _(optional)_: Maximum scope depth to traverse (default: 2). 1 = local scope only (function args &amp; local vars), 2 = local + closure scopes, 3+ = all non-global scopes.

---

### `get_request_initiator`

**Description:** Gets the JavaScript call stack that initiated a network request. This helps trace which code triggered an API call.

**Parameters:**

- **requestId** (integer) **(required)**: The request ID (from [`list_network_requests`](#list_network_requests)) to get the initiator for.

---

### `get_script_source`

**Description:** Gets a small snippet of a JavaScript script source by URL (recommended) or script ID. Supports line range (for normal files) or character offset (for minified single-line files). Prefer using url over scriptId — URLs remain stable across page navigations while script IDs become invalid after reload. This tool is designed for reading small code regions (e.g. around breakpoints or search results); specify startLine/endLine or offset/length for predictable inline output. If no range is provided, small sources are returned inline and large sources return a preview with guidance. To read an entire script file, especially a minified one, use [`save_script_source`](#save_script_source) instead. WASM scripts cannot be shown inline; use [`save_script_source`](#save_script_source) with a .wasm file path.

**Parameters:**

- **endLine** (integer) _(optional)_: End line number (1-based). Use for multi-line files.
- **length** (integer) _(optional)_: Number of characters to return when using offset (default: 1000).
- **offset** (integer) _(optional)_: Character offset to start from (0-based). Use for minified single-line files.
- **scriptId** (string) _(optional)_: Script ID (from [`list_scripts`](#list_scripts)). Becomes invalid after page navigation — prefer url instead.
- **startLine** (integer) _(optional)_: Start line number (1-based). Use for multi-line files.
- **url** (string) _(optional)_: Script URL (preferred). Stable across page navigations. Exact match first, then substring match.

---

### `list_breakpoints`

**Description:** Lists active code and XHR/Fetch breakpoints, 20 per page by default. Breakpoints are tracked by this MCP session and restored after navigation when possible.

**Parameters:**

- **pageIdx** (integer) _(optional)_: Page number (0-based). Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum items per page. Defaults to 20.

---

### `list_scripts`

**Description:** Lists loaded JavaScript scripts, including inline and eval scripts. Returns 20 per page by default with script ID, URL/kind, and source map information. Script IDs are valid only for the current page load.

**Parameters:**

- **filter** (string) _(optional)_: Optional filter string to match against script URLs (case-insensitive partial match).
- **pageIdx** (integer) _(optional)_: Page number (0-based). Defaults to 0.
- **pageSize** (integer) _(optional)_: Maximum items per page. Defaults to 20.

---

### `pause_or_resume`

**Description:** Explicitly pauses or resumes JavaScript execution. Pass action="pause" or action="resume"; the tool never toggles implicitly.

**Parameters:**

- **action** (enum: "pause", "resume") **(required)**: Explicit execution action: pause or resume.

---

### `remove_breakpoint`

**Description:** Removes breakpoints using an explicit action. Use remove_code with breakpointId, remove_xhr with url, or remove_all with confirm=true.

**Parameters:**

- **action** (enum: "remove_code", "remove_xhr", "remove_all") **(required)**: Explicit breakpoint removal action.
- **breakpointId** (string) _(optional)_: The breakpoint ID to remove (from [`list_breakpoints`](#list_breakpoints) or [`set_breakpoint_on_text`](#set_breakpoint_on_text)).
- **confirm** (boolean) _(optional)_: Must be true for any breakpoint removal action.
- **url** (string) _(optional)_: The XHR breakpoint URL pattern to remove.

---

### `save_script_source`

**Description:** Saves the full source code of a JavaScript script to a local file. PREFERRED over [`get_script_source`](#get_script_source) whenever you need the whole file or want to search/read a minified script. This tool auto-formats (beautifies) minified .js/.mjs/.ts output via prettier so the saved file is human-readable. Use this for any non-trivial source inspection; only fall back to [`get_script_source`](#get_script_source) for tiny known regions (e.g. ±20 lines around a breakpoint). Typical workflow: call [`save_script_source`](#save_script_source), then inspect the saved local file with your available file-reading or search tools. NOTE: because the saved file may be beautified, its line numbers may not match the original script. If you later need to set a breakpoint, use the original URL/scriptId with [`set_breakpoint_on_text`](#set_breakpoint_on_text) rather than line numbers from the saved file.

**Parameters:**

- **confirmOverwrite** (boolean) _(optional)_: Must be true when filePath already exists. New files do not require confirmation.
- **filePath** (string) **(required)**: Local file path to save the script source to. Absolute paths and paths relative to the current working directory are supported. Use a .js/.mjs/.cjs/.jsx/.ts/.tsx extension to enable auto-format (prettier beautify); other extensions save raw source verbatim. For WASM scripts, use a .wasm extension. Subject to --allowedRoots when configured.
- **format** (boolean) _(optional)_: Auto-format JavaScript/TypeScript output with prettier (beautifies minified code). Defaults to true. Set to false to save the raw original source verbatim.
- **scriptId** (string) _(optional)_: Script ID (from [`list_scripts`](#list_scripts)). Becomes invalid after page navigation — prefer url instead.
- **url** (string) _(optional)_: Script URL (preferred). Stable across page navigations. Exact match first, then substring match.

---

### `search_in_sources`

**Description:** Searches all loaded JavaScript sources, including inline/eval and compressed bundles by default. Returns matching lines with script ID, URL/kind, and line number. Use [`get_script_source`](#get_script_source) for surrounding context.

**Parameters:**

- **caseSensitive** (boolean) _(optional)_: Whether the search should be case-sensitive.
- **excludeMinified** (boolean) _(optional)_: Skip minified files (files with very long lines). Default: false so compressed bundles are searched automatically.
- **isRegex** (boolean) _(optional)_: Whether to treat the query as a regular expression.
- **maxLineLength** (integer) _(optional)_: Maximum characters per matched line preview (default: 150). Increase if you need more context around the match.
- **maxResults** (integer) _(optional)_: Maximum number of results to return (default: 30).
- **query** (string) **(required)**: The search query (string or regex pattern).
- **urlFilter** (string) _(optional)_: Only search scripts whose URL contains this string (case-insensitive).

---

### `set_breakpoint_on_text`

**Description:** Sets a breakpoint on specific code (function name, statement, etc.) by searching loaded scripts and automatically determining a position. Optionally pass condition to reduce noisy hits after the code location is already precise; prefer text/urlFilter/occurrence for locating the breakpoint, and use condition only as a simple synchronous guard. Works with both normal and minified URL-backed scripts. Inline/eval scripts without a URL can be found but cannot receive this persistent URL breakpoint. Breakpoints persist across page navigations when the URL can be matched again.

**Parameters:**

- **condition** (string) _(optional)_: Optional synchronous JavaScript condition evaluated in the breakpoint call frame. Use only as a simple guard after choosing a precise code location; avoid complex logic, async work, or side effects. The breakpoint pauses only when this expression evaluates to true.
- **occurrence** (integer) _(optional)_: Which occurrence to break on (1 = first, 2 = second, etc.).
- **text** (string) **(required)**: The code text to find and set breakpoint on (e.g., "function myFunc", "fetchData(", "apiCall").
- **urlFilter** (string) _(optional)_: Only search in scripts whose URL contains this string (case-insensitive).

---

### `step`

**Description:** Steps JavaScript execution. Use direction "over" to skip function calls, "into" to enter function bodies, "out" to exit the current function. Returns the new location with source context.

**Parameters:**

- **direction** (enum: "over", "into", "out") **(required)**: [`Step`](#step) direction: "over" (next statement), "into" (enter function), "out" (exit function).

---

## CLI Configuration

- **`--browserUrl`, `-u`**
  Connect to a running Chrome instance via CDP HTTP endpoint (e.g., http://127.0.0.1:9222). The MCP will probe the endpoint to find the WebSocket debugger URL.
  - **Type:** string

- **`--isolated`**
  Create a temporary user-data-dir that is auto-cleaned when the browser closes. Use this for runs where you do NOT want cookies/localStorage to persist into your default profile.
  - **Type:** boolean
  - **Default:** `false`

- **`--logFile`**
  Path to a 0600 regular file for js-reverse-mcp debug logs. Use DEBUG=mcp:_ for verbose MCP logs; never use DEBUG=_ because browser protocol logs can contain page data, cookies, scripts, and credentials.
  - **Type:** string

- **`--allowedRoots`**
  Optional directories that local-file tools may read from or write to. Repeat the flag for multiple roots. Roots are resolved at startup and symlink escapes are rejected. While configured, file:, view-source:file:, and filesystem:file: browser pages are disabled. When omitted, local-file access is unrestricted and a security warning is printed.
  - **Type:** string[]

- **`--cloak`**
  Use CloakBrowser stealth-patched Chromium instead of system Chrome. Adds source-level fingerprint patches (canvas/WebGL/audio/GPU). Binary auto-downloads (~200MB) on first use. Identity is persisted per profile in <profile>/.cloak-seed.
  - **Type:** boolean
