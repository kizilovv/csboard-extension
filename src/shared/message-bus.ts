// ============================================================
// CSBOARD — Typed Message Bus
// ============================================================
// Type-safe wrapper around chrome.runtime.sendMessage.
// Provides:
// - Compile-time message/response type checking
// - Runtime validation of message shape
// - Automatic error wrapping into Result<T>
// - Timeout handling (MV3 service workers can die mid-request)

import type {
  ExtensionMessage,
  MessageType,
  ResponseFor,
  PageScriptEvent,
  PageScriptEventType,
} from './types';
import { type Result, Ok, Fail } from './result';
import { CSBoardError } from './types';
import { createLogger } from './logger';

const logger = createLogger('message-bus');

// --- Chrome Message Bus (content script / popup → background) ---

const DEFAULT_TIMEOUT_MS = 10_000; // 10s — generous for API calls through background

/**
 * Send a typed message to the background service worker.
 * Returns Result<T> instead of throwing.
 */
export async function sendTypedMessage<T extends MessageType>(
  message: Extract<ExtensionMessage, { type: T }>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Result<ResponseFor<T>, CSBoardError>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('Message timed out', { type: message.type, timeoutMs });
      resolve(Fail(
        `Message ${message.type} timed out after ${timeoutMs}ms`,
        'NETWORK_ERROR',
        true,
      ));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);

        // Check for chrome.runtime.lastError (disconnected port, etc.)
        if (chrome.runtime.lastError) {
          logger.error('Chrome runtime error', {
            type: message.type,
            error: chrome.runtime.lastError.message,
          });
          resolve(Fail(
            chrome.runtime.lastError.message ?? 'Unknown chrome runtime error',
            'NETWORK_ERROR',
            true,
          ));
          return;
        }

        // Check for API-level errors in response
        if (response && typeof response === 'object' && 'error' in response && !('ok' in response)) {
          resolve(Fail(
            String(response.error),
            'API_ERROR',
            false,
          ));
          return;
        }

        resolve(Ok(response as ResponseFor<T>));
      });
    } catch (err) {
      clearTimeout(timer);
      const message_ = err instanceof Error ? err.message : String(err);
      logger.error('Failed to send message', { type: message.type, error: message_ });
      resolve(Fail(message_, 'NETWORK_ERROR', true));
    }
  });
}

// --- Message Handler Registry (background service worker side) ---

type HandlerFn<T extends MessageType> = (
  message: Extract<ExtensionMessage, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<ResponseFor<T>>;

type HandlerMap = {
  [K in MessageType]?: HandlerFn<K>;
};

/**
 * Create a type-safe message router for the background service worker.
 *
 * Usage:
 *   const router = createMessageRouter();
 *   router.on('GET_AUTH_STATUS', async () => getAuthStatus());
 *   router.on('LOGIN', async (msg) => loginWithToken(msg.data.token));
 *   router.listen();
 */
export function createMessageRouter() {
  const handlers: HandlerMap = {};
  const routerLogger = createLogger('router');

  return {
    on<T extends MessageType>(type: T, handler: HandlerFn<T>) {
      (handlers as Record<string, unknown>)[type] = handler;
      return this; // chainable
    },

    listen() {
      chrome.runtime.onMessage.addListener(
        (message: ExtensionMessage, sender, sendResponse) => {
          const handler = (handlers as Record<string, HandlerFn<MessageType>>)[message.type];

          if (!handler) {
            routerLogger.warn('No handler for message type', { type: message.type });
            sendResponse({ error: `Unknown message type: ${message.type}` });
            return true;
          }

          routerLogger.debug('Handling message', { type: message.type });

          handler(message as never, sender)
            .then((result) => {
              sendResponse(result);
            })
            .catch((err) => {
              routerLogger.error('Handler error', {
                type: message.type,
                error: err instanceof Error ? err.message : String(err),
              });
              sendResponse({ error: err instanceof Error ? err.message : 'Internal error' });
            });

          return true; // async response
        },
      );

      routerLogger.info('Message router listening', {
        handlers: Object.keys(handlers),
      });
    },

    /**
     * Dispatch a message through the router manually.
     * Used for onMessageExternal (website → extension).
     */
    dispatch(
      message: ExtensionMessage,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) {
      const handler = (handlers as Record<string, HandlerFn<MessageType>>)[message.type];

      if (!handler) {
        routerLogger.warn('No handler for external message type', { type: message.type });
        sendResponse({ error: `Unknown message type: ${message.type}` });
        return;
      }

      routerLogger.debug('Dispatching external message', { type: message.type });

      handler(message as never, sender)
        .then((result) => sendResponse(result))
        .catch((err) => {
          routerLogger.error('External handler error', {
            type: message.type,
            error: err instanceof Error ? err.message : String(err),
          });
          sendResponse({ error: err instanceof Error ? err.message : 'Internal error' });
        });
    },
  };
}

// --- Page Script Bridge (window.postMessage) ---

/**
 * Listen for messages from injected page scripts.
 * Type-safe handler for CSBOARD_* events.
 */
export function onPageScriptEvent<T extends PageScriptEventType>(
  type: T,
  handler: (data: Extract<PageScriptEvent, { type: T }>['data']) => void,
): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== type) return;

    handler(event.data.data);
  };

  window.addEventListener('message', listener);

  // Return cleanup function
  return () => window.removeEventListener('message', listener);
}
