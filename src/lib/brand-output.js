import { normalizeBrandDeep } from './fa.js';

// Express middleware: every JSON body leaves the server with "پیام‌نور" written with a half-space.
// Only the response is changed; stored data is never touched.
export function brandNameOutput(request, response, next) {
  const sendJson = response.json.bind(response);
  response.json = (body) => sendJson(normalizeBrandDeep(body));
  next();
}
