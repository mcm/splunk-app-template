import { app as currentAppName } from "@splunk/splunk-utils/config";
import { createFetchInit, findErrorMessage } from "@splunk/splunk-utils/fetch";
import { createRESTURL } from "@splunk/splunk-utils/url";

/**
 * A thrown non-2xx response.
 *
 * `body` is whatever came back: FastAPI answers with JSON (`{"detail": ...}`), but a request
 * rejected by splunkd before it reaches Python answers with the Splunk error envelope, and in
 * XML rather than JSON unless `output_mode=json` was on the query string. Both shapes are
 * preserved as-is; `message` is the best human-readable string that could be pulled out of
 * either.
 */
export class SplunkApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  /** Parsed JSON when the response was JSON, the raw text when it was not, `null` when empty. */
  readonly body: unknown;

  constructor(response: Response, body: unknown) {
    super(describeError(response, body));
    this.name = "SplunkApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.body = body;
  }
}

export interface SplunkApiRequestOptions {
  /** Query string parameters. `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra request headers, merged over the Splunk defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SplunkApiClient {
  get<T>(path: string, options?: SplunkApiRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T>;
  delete<T>(path: string, options?: SplunkApiRequestOptions): Promise<T>;
}

/**
 * Builds a client for one REST namespace - the `match` prefix from `restmap.conf`, without its
 * leading slash. Paths are relative to it, so `createSplunkApiClient("sprockets/gizmos").get("42")`
 * calls `/services/sprockets/gizmos/42`.
 *
 * You only need this when the backend is split across several handlers, each with its own
 * `[script:...]` stanza and `match`. For the single-handler case use the exported `apiGet`,
 * `apiPost`, ... below.
 */
export function createSplunkApiClient(namespace: string): SplunkApiClient {
  return {
    get: (path, options) => request("GET", namespace, path, undefined, options),
    post: (path, body, options) => request("POST", namespace, path, body, options),
    put: (path, body, options) => request("PUT", namespace, path, body, options),
    patch: (path, body, options) => request("PATCH", namespace, path, body, options),
    delete: (path, options) => request("DELETE", namespace, path, undefined, options),
  };
}

/**
 * `GET` this app's REST namespace. The path is relative to the namespace, so `apiGet("d6")`
 * calls `/services/my_splunk_app/d6`. The type parameter is the parsed response body and is
 * unchecked at runtime - it is a promise about what the route returns, not a validation of it.
 *
 * ```ts
 * const gizmos = await apiGet<Gizmo[]>("gizmos");
 * ```
 */
export function apiGet<T>(path: string, options?: SplunkApiRequestOptions): Promise<T> {
  return request("GET", appNamespace(), path, undefined, options);
}

/** `POST` this app's REST namespace. `body` is JSON-encoded unless it is already a `BodyInit`. */
export function apiPost<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T> {
  return request("POST", appNamespace(), path, body, options);
}

/** `PUT` this app's REST namespace. `body` is JSON-encoded unless it is already a `BodyInit`. */
export function apiPut<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T> {
  return request("PUT", appNamespace(), path, body, options);
}

/** `PATCH` this app's REST namespace. `body` is JSON-encoded unless it is already a `BodyInit`. */
export function apiPatch<T>(path: string, body?: unknown, options?: SplunkApiRequestOptions): Promise<T> {
  return request("PATCH", appNamespace(), path, body, options);
}

/** `DELETE` this app's REST namespace. */
export function apiDelete<T>(path: string, options?: SplunkApiRequestOptions): Promise<T> {
  return request("DELETE", appNamespace(), path, undefined, options);
}

/**
 * The REST namespace to use when the caller does not name one.
 *
 * Read off the page URL (`/en-US/app/<app>/<view>`) rather than baked in at build time, so
 * renaming the app is one edit in `package.json` instead of three. That works because this
 * template gives the handler a `match` equal to the app id. splunkd's REST namespace is global
 * and has no such requirement, so a backend split across handlers with unrelated `match` values
 * wants `createSplunkApiClient` instead.
 */
function appNamespace(): string {
  if (!currentAppName) {
    throw new Error(
      "Could not read the app name from the page URL, so the REST namespace is unknown. " +
        'Name it explicitly with createSplunkApiClient("my_splunk_app").'
    );
  }
  return currentAppName;
}

async function request<T>(
  method: string,
  namespace: string,
  path: string,
  body: unknown,
  options: SplunkApiRequestOptions = {}
): Promise<T> {
  const response = await fetch(url(namespace, path, options.query), fetchInit(method, body, options));

  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new SplunkApiError(response, parsed);
  }
  return parsed as T;
}

function url(
  namespace: string,
  path: string,
  query: SplunkApiRequestOptions["query"]
): string {
  // createRESTURL prepends everything Splunk Web needs to proxy through to splunkd: the
  // deployment's root path, the locale, and `/splunkd/__raw/services`. Hardcoding `/services/...`
  // breaks on any instance served under a non-root path.
  const restUrl = createRESTURL(`${namespace}/${path.replace(/^\//, "")}`);
  if (!query) return restUrl;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${restUrl}?${queryString}` : restUrl;
}

function fetchInit(method: string, body: unknown, options: SplunkApiRequestOptions): RequestInit {
  const headers: Record<string, string> = { ...options.headers };

  const hasBody = body !== undefined;
  if (hasBody && !isBodyInit(body)) {
    // Splunk's defaults assume the form-encoded bodies its own REST API takes. A FastAPI route
    // declaring a Pydantic model wants JSON, so override rather than inherit.
    headers["Content-Type"] = "application/json";
  }

  // `createFetchInit` supplies `credentials: "include"` plus the two headers splunkd's CSRF
  // check demands on POST/PUT/PATCH/DELETE: `X-Splunk-Form-Key`, read from the
  // `splunkweb_csrf_token_<webport>` cookie, and `X-Requested-With: XMLHttpRequest`. Both are
  // required - omitting either fails the request with 401 "CSRF validation failed" before it
  // ever reaches Python, which is the trap a bare `fetch(url, { credentials: "include" })`
  // falls into the moment a GET-only page grows its first write. It reads the cookie on every
  // call, so a session that re-authenticates mid-page keeps working.
  const init = createFetchInit({ method, headers, signal: options.signal });

  if (!hasBody) {
    // Nothing to describe, and a Content-Type on a bodyless request only invites 415s.
    delete (init.headers as Record<string, string>)["Content-Type"];
    return init;
  }
  return { ...init, body: isBodyInit(body) ? body : JSON.stringify(body) };
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  );
}

/**
 * Deliberately not `response.json()`: an error raised by splunkd rather than by the app comes
 * back as XML, and `json()` would throw over it and lose the only useful diagnostic.
 */
async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeError(response: Response, body: unknown): string {
  if (typeof body === "object" && body !== null) {
    // FastAPI's `HTTPException(detail=...)`. Validation errors put a list here instead, which
    // has no one-line rendering worth guessing at - those fall through to `body`.
    const { detail } = body as { detail?: unknown };
    if (typeof detail === "string") return detail;

    // Splunk's own `{ messages: [{ type, text }] }` envelope, e.g. a failed CSRF check.
    const splunkMessage = findErrorMessage(body);
    if (splunkMessage && typeof splunkMessage.text === "string") return splunkMessage.text;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}
