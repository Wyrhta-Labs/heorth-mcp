/**
 * A fake upstream: records every request and answers from a scripted queue.
 * Tests inject it as the clients' `fetch`, so nothing here touches the network.
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  /** Raw body, for testing non-JSON answers. Wins over `body`. */
  text?: string;
  /** Response `Content-Type` (default `application/json`), for text answers. */
  contentType?: string;
  /** Reject instead of answering — a connection failure. */
  throws?: unknown;
  /** Never settle, so the client's timeout fires. */
  hang?: boolean;
}

/**
 * The first two parameters of Node's global `fetch` — `string | URL | Request`
 * and `RequestInit`. Derived from the runtime signature rather than written out,
 * because the DOM `RequestInfo` alias does not exist without the `dom` lib and
 * this project targets Node's undici-backed fetch only.
 */
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export interface FakeUpstream {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  script(...responses: ScriptedResponse[]): void;
}

export function createFakeUpstream(...initial: ScriptedResponse[]): FakeUpstream {
  const queue: ScriptedResponse[] = [...initial];
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });

    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throws) throw next.throws;
    if (next.hang) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const status = next.status ?? 200;
    const body = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    // 204/205/304 must not carry a body — the Response constructor rejects one.
    return new Response(status === 204 || status === 205 || status === 304 ? null : body, {
      status,
      headers: { 'Content-Type': next.contentType ?? 'application/json' },
    });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    script(...responses: ScriptedResponse[]) {
      queue.push(...responses);
    },
  };
}
