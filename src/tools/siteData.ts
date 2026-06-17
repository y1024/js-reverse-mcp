/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

const MAX_SUMMARY_ITEMS = 8;

function getHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url;
    }
  } catch {
    return;
  }
  return;
}

function summarizeValues(values: string[]): string {
  const uniqueValues = [...new Set(values)].sort();
  if (uniqueValues.length === 0) {
    return 'none';
  }

  const visibleValues = uniqueValues.slice(0, MAX_SUMMARY_ITEMS);
  const remaining = uniqueValues.length - visibleValues.length;
  if (remaining <= 0) {
    return visibleValues.join(', ');
  }

  return `${visibleValues.join(', ')}, ... and ${remaining} more`;
}

export const clearSiteData = defineTool({
  name: 'clear_site_data',
  description: `Clear browser state to create a clean replay environment for the currently selected page. This clears cookies that affect the current page's HTTP(S) frame URLs, clears browser HTTP cache, clears persistent storage for the current page's HTTP(S) frame origins, and clears sessionStorage in current page HTTP(S) frames. This tool does not reload the page. Cookie cleanup is scoped by cookie domain/path matching for the current page frames, not by all cookies in the browser context.`,
  annotations: {
    category: ToolCategory.BROWSER_STATE,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const pageUrl = page.url();
    const url = new URL(pageUrl);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `clear_site_data requires an http(s) selected page. Current URL is ${pageUrl}. Navigate to the target site first.`,
      );
    }

    const browserContext = page.context();
    const frameUrls = [
      ...new Map(
        page
          .frames()
          .map(frame => getHttpUrl(frame.url()))
          .filter((frameUrl): frameUrl is URL => Boolean(frameUrl))
          .map(frameUrl => [frameUrl.href, frameUrl]),
      ).values(),
    ];
    const frameOrigins = [
      ...new Map(frameUrls.map(frameUrl => [frameUrl.origin, frameUrl.origin]))
        .values(),
    ];
    const warnings: string[] = [];
    let cookieCount: number | undefined;
    let cookieDomains: string[] = [];
    let cookieNames: string[] = [];
    let cookiesStatus = 'failed';
    let browserCacheStatus = 'failed';
    let originStorageStatus = `failed`;
    let sessionStorageStatus = 'failed';
    const clearedStorageOrigins: string[] = [];
    const failedStorageOrigins: string[] = [];
    const clearedSessionStorageFrames: string[] = [];
    const failedSessionStorageFrames: string[] = [];

    try {
      const cookies = await browserContext.cookies(
        frameUrls.map(frameUrl => frameUrl.href),
      );
      cookieCount = cookies.length;
      cookieDomains = cookies.map(cookie => cookie.domain);
      cookieNames = cookies.map(cookie => cookie.name);

      const cookiesByKey = new Map(
        cookies.map(cookie => [
          `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`,
          cookie,
        ]),
      );

      for (const cookie of cookiesByKey.values()) {
        await browserContext.clearCookies({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        });
      }

      cookiesStatus = `yes (${cookiesByKey.size} matching cookies)`;
      if (cookies.some(cookie => cookie.partitionKey)) {
        warnings.push(
          'Some matched cookies are partitioned. Patchright clearCookies filters by name/domain/path, so matching partitioned cookies may be cleared together.',
        );
      }
    } catch (error) {
      warnings.push(
        `Failed to inspect or clear cookies for current page frames: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const session = await browserContext.newCDPSession(page).catch(error => {
      warnings.push(
        `Failed to create CDP session for cache/origin storage cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });

    if (session) {
      try {
        await session.send('Network.clearBrowserCache');
        browserCacheStatus = 'yes';
      } catch (error) {
        warnings.push(
          `Failed to clear browser HTTP cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        for (const origin of frameOrigins) {
          try {
            await session.send('Storage.clearDataForOrigin', {
              origin,
              storageTypes: 'all',
            });
            clearedStorageOrigins.push(origin);
          } catch (error) {
            failedStorageOrigins.push(origin);
            warnings.push(
              `Failed to clear origin storage for ${origin}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        originStorageStatus = `${clearedStorageOrigins.length}/${frameOrigins.length} origins`;
      } catch (error) {
        warnings.push(
          `Failed to clear origin storage for current page frames: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await session.detach().catch(error => {
          warnings.push(
            `Failed to detach CDP session: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }

    for (const frame of page.frames()) {
      const frameUrl = getHttpUrl(frame.url());
      if (!frameUrl) {
        continue;
      }

      try {
        await frame.evaluate(() => {
          sessionStorage.clear();
        });
        clearedSessionStorageFrames.push(frameUrl.href);
      } catch (error) {
        failedSessionStorageFrames.push(frameUrl.href);
        warnings.push(
          `Failed to clear sessionStorage for frame ${frameUrl.href}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    sessionStorageStatus = `${clearedSessionStorageFrames.length}/${frameUrls.length} frames`;

    response.appendResponseLine(
      `Browser state cleanup completed for ${url.origin}`,
    );
    response.appendResponseLine(`URL: ${pageUrl}`);
    response.appendResponseLine(
      `Frame origins targeted: ${summarizeValues(frameOrigins)}`,
    );
    response.appendResponseLine(`Cookies cleared: ${cookiesStatus}`);
    response.appendResponseLine(
      `Cookies found before clearing: ${cookieCount ?? 'unknown'}`,
    );
    response.appendResponseLine(
      `Cookie domains: ${summarizeValues(cookieDomains)}`,
    );
    response.appendResponseLine(
      `Cookie names: ${summarizeValues(cookieNames)}`,
    );
    response.appendResponseLine(
      `Browser HTTP cache cleared: ${browserCacheStatus}`,
    );
    response.appendResponseLine(
      `Origin storage cleared: ${originStorageStatus}`,
    );
    response.appendResponseLine(
      `Origin storage cleared for: ${summarizeValues(clearedStorageOrigins)}`,
    );
    response.appendResponseLine(
      `Origin storage failed for: ${summarizeValues(failedStorageOrigins)}`,
    );
    response.appendResponseLine(
      `Session storage cleared: ${sessionStorageStatus}`,
    );
    response.appendResponseLine(
      `Session storage failed for frames: ${summarizeValues(failedSessionStorageFrames)}`,
    );

    response.appendResponseLine(`Warnings:`);
    if (!warnings.length) {
      response.appendResponseLine(`none`);
    }
    for (const warning of warnings) {
      response.appendResponseLine(`- ${warning}`);
    }

    response.appendResponseLine(
      'The page was not reloaded. Use navigate_page({type:"reload"}) to replay cookie generation.',
    );
  },
});
