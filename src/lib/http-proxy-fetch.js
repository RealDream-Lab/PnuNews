// A small fetch-like function that reaches https:// addresses through an HTTP proxy (CONNECT tunnel), for example
// the v2rayA container's HTTP port (http://v2raya:20171). Only what the Telegram client needs is implemented:
// POST/GET with a string or FormData body, and a response with `status`, `ok`, `json()` and `text()`.
// No dependencies: node:http, node:https and node:tls only.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// "http://v2raya:20171" -> { hostname, port }; anything else throws.
export function parseProxyUrl(value, name = 'proxy') {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${name} باید نشانی معتبر مثل http://v2raya:20171 باشد.`); }
  if (url.protocol !== 'http:' || !url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.username || url.password) {
    throw new Error(`${name} باید فقط به شکل http://میزبان:پورت باشد (بدون مسیر و بدون نام کاربری).\n${name} must look like http://host:port.`);
  }
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) };
}

export function createProxyFetch(proxyUrl, { tlsOptions = {} } = {}) {
  const proxy = parseProxyUrl(proxyUrl, 'TELEGRAM_PROXY');

  function openTunnel(target, signal) {
    return new Promise((resolve, reject) => {
      const authority = `${target.hostname}:${target.port || 443}`;
      const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: authority, headers: { host: authority }, signal });
      request.once('connect', (response, socket) => {
        if (response.statusCode === 200) { resolve(socket); return; }
        socket.destroy();
        reject(Object.assign(new Error(`proxy answered CONNECT with ${response.statusCode}`), { code: `PROXY_${response.statusCode}` }));
      });
      request.once('response', (response) => { response.resume(); reject(Object.assign(new Error(`proxy answered ${response.statusCode}`), { code: `PROXY_${response.statusCode}` })); });
      request.once('error', reject);
      request.end();
    });
  }

  return async function proxyFetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.protocol !== 'https:') throw new TypeError('only https addresses can be reached through the proxy');
    const method = init.method ?? 'GET';
    const headers = { ...(init.headers ?? {}), connection: 'close' };
    let payload = null;
    if (init.body instanceof FormData) {
      const encoded = new Response(init.body); // builds the multipart body and its boundary
      headers['content-type'] = encoded.headers.get('content-type');
      payload = Buffer.from(await encoded.arrayBuffer());
    } else if (init.body !== undefined && init.body !== null) {
      payload = Buffer.from(init.body);
    }
    if (payload) headers['content-length'] = String(payload.length);

    const socket = await openTunnel(url, init.signal);
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket, servername: url.hostname, ...tlsOptions });
      const done = (fn, value) => { fn(value); };
      const request = https.request({
        method,
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers,
        // no `agent` on purpose: Node only uses createConnection when no agent is involved
        createConnection: () => secure,
        signal: init.signal,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { secure.destroy(); reject(Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' })); return; }
          chunks.push(chunk);
        });
        response.on('error', (error) => { secure.destroy(); reject(error); });
        response.on('end', () => {
          secure.destroy();
          const text = Buffer.concat(chunks).toString('utf8');
          done(resolve, {
            status: response.statusCode,
            ok: response.statusCode >= 200 && response.statusCode < 300,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      });
      request.on('error', (error) => { secure.destroy(); reject(error); });
      secure.on('error', (error) => { reject(error); });
      request.end(payload);
    });
  };
}
