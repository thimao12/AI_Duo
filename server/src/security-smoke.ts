import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startServer } from './app.ts';
import { api } from '../../web/src/api.ts';

const previousDevOrigins = process.env.AI_DUO_DEV_ORIGINS;
process.env.AI_DUO_DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

const server = await startServer({ port: 0 });
const baseUrl = server.url;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, baseUrl), init);
}

function requestWithHost(path: string, host: string): Promise<number> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, headers: { host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

try {
  const plainText = await request('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(plainText.status, 415, 'plain text run creation must be rejected');

  for (const origin of ['https://evil.com', 'http://localhost:3000']) {
    const rejectedOrigin = await request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{"mode":"invalid"}',
    });
    assert.equal(rejectedOrigin.status, 403, `${origin} must be rejected`);
  }

  const rejectedHost = await requestWithHost('/api/runs', 'evil.com');
  assert.equal(rejectedHost, 403, 'non-local Host must be rejected');

  for (const origin of [baseUrl, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
    const acceptedOrigin = await request('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{"mode":"invalid"}',
    });
    assert.equal(acceptedOrigin.status, 400, `${origin} should reach run config validation`);
  }

  const cancel = await request('/api/runs/not-active/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: '{}',
  });
  assert.equal(cancel.status, 404, 'JSON cancel requests should reach the cancel route');

  const originalFetch = globalThis.fetch;
  let cancelRequest: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    cancelRequest = init;
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };
  try {
    await api.cancel('test-id');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(cancelRequest?.method, 'POST');
  assert.equal(new Headers(cancelRequest?.headers).get('content-type'), 'application/json');
  assert.equal(cancelRequest?.body, '{}');

  console.log('API security smoke checks passed.');
} finally {
  server.close();
  if (previousDevOrigins === undefined) delete process.env.AI_DUO_DEV_ORIGINS;
  else process.env.AI_DUO_DEV_ORIGINS = previousDevOrigins;
}
