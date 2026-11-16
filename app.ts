// app.ts — the forge's HTTP server: one process, one in-memory store, four surfaces.
//
//   GET  /healthz            the boot probe (no auth)
//   /{owner}/{repo}.git/*    git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   /api/v3/*                GitHub REST v3
//   POST /api/graphql        GitHub GraphQL v4
//   POST /mcp                Model Context Protocol (Streamable HTTP)
//
// Everything but /healthz and the API root takes the trial's bearer token
// (MAKEFUN_SHOP_TOKEN): a missing or wrong token is 401. Every reply is JSON
// with a non-empty X-GitHub-Request-Id; an unknown route is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type HandlerResult } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the trial's requests carry ('' when unset: auth is then open). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** One store for the process's whole life: the trial is one run, one store. */
const store = new Store();

let requestCounter = 0;

/** Answer one request with a body; `headers` go beside the JSON ones. */
function send(res: ServerResponse, result: HandlerResult): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': result.contentType,
    'content-length': String(result.body.length),
    'x-github-request-id': `req-${requestCounter}`,
    ...(result.headers ?? {}),
  };
  try {
    res.writeHead(result.status, headers);
    res.end(result.body);
  } catch {
    // The peer went away between the request and the answer.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(res, { status, contentType: JSON_TYPE, headers, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') });
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Lowercased headers as a plain record. */
function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Read a request body whole (a pack is the largest body this server sees). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authed(headers: Record<string, string | undefined>): boolean {
  if (EXPECTED_TOKEN === '') return true;
  return (headers.authorization ?? '') === `Bearer ${EXPECTED_TOKEN}`;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const { pathname, query } = pathOf(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const segments = pathname.split('/').filter((part) => part !== '');

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (
        segments.length >= 2 &&
        segments[1] !== undefined &&
        segments[1].endsWith('.git') &&
        (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
      ) {
        if (!authed(headers)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const owner = decodeURIComponent(segments[0]!);
        const repoName = decodeURIComponent(segments[1]!.slice(0, -'.git'.length));
        const suffix = `/${segments.slice(2).join('/')}`;
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        const result = await handleGit(store, EXPECTED_TOKEN, method, owner, repoName, suffix, query, headers, body);
        send(res, result);
        return;
      }

      // GraphQL v4.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authed(headers)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        send(res, await handleGraphql(store, body));
        return;
      }

      // MCP.
      if (pathname === '/mcp') {
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        send(res, await handleMcp(store, EXPECTED_TOKEN, method, headers, body));
        return;
      }

      // REST v3.
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2).map((part) => decodeURIComponent(part));
        const isRoot = restSegments.length === 0;
        if (!isRoot && !authed(headers)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const restReq: RestRequest = {
          method,
          segments: restSegments,
          query,
          headers,
          body,
          origin,
          path: `/api/v3${restSegments.length === 0 ? '' : `/${restSegments.join('/')}`}`,
        };
        send(res, await handleRest(store, restReq));
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The response is already gone.
      }
    });
  });
}
