/** Localhost HTTP server for the web UI. */

import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { BuildAlreadyRunningError, createBuildJobs } from './build-jobs.js';
import {
  ApiError,
  completeMusic,
  createLibraryStyle,
  createProject,
  generateStyle,
  getAsset,
  getBuild,
  getLibrary,
  getMaster,
  getMusic,
  getProject,
  getProjects,
  InvalidProjectIdError,
  listClips,
  ProjectNotFoundError,
  selectClip,
  startBuild,
  updateCrop,
} from './project-api.js';

const MAX_BODY_BYTES = 64 * 1024;
/** Yalnızca bu makineden: DNS rebinding ile başka bir sitenin API'yi okumasını engeller. */
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

export function createDefaultProjectApi({ buildJobs = createBuildJobs() } = {}) {
  return {
    getProjects: () => getProjects(),
    getProject: (id) => getProject(id),
    createProject: (body) => createProject(body),
    getLibrary: () => getLibrary(),
    createLibraryStyle: (body) => createLibraryStyle(body),
    generateStyle: (id, body) => generateStyle(id, body),
    getMaster: (id) => getMaster(id),
    listClips: (id) => listClips(id),
    getMusic: (id) => getMusic(id),
    selectClip: (id, body) => selectClip(id, body),
    completeMusic: (id, body) => completeMusic(id, body),
    updateCrop: (id, body) => updateCrop(id, body),
    startBuild: (id, body) => startBuild(id, body, { buildJobs }),
    getBuild: (id) => getBuild(id, { buildJobs }),
    getAsset: (id, assetType, filename) => getAsset(id, assetType, filename),
  };
}

/**
 * Rotalar. `id` yoldaki proje kimliği, `params` sonraki yol parçaları (çözülmüş).
 * `file: true` rotası JSON değil `{ path, size, contentType }` dosyasını akıtır.
 * @type {{ method: string, pattern: RegExp, file?: boolean, handle: (api: object, ctx: object) => Promise<[number, unknown]> }[]}
 */
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handle: async () => [200, { ok: true }] },
  { method: 'GET', pattern: /^\/api\/library$/, handle: async (api) => [200, await api.getLibrary()] },
  {
    method: 'POST',
    pattern: /^\/api\/styles$/,
    handle: async (api, { body }) => [201, await api.createLibraryStyle(body)],
  },
  { method: 'GET', pattern: /^\/api\/projects$/, handle: async (api) => [200, await api.getProjects()] },
  {
    method: 'POST',
    pattern: /^\/api\/projects$/,
    handle: async (api, { body }) => [201, await api.createProject(body)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)$/,
    handle: async (api, { id }) => [200, await api.getProject(id)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)\/master$/,
    handle: async (api, { id }) => [200, await api.getMaster(id)],
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]*)\/style\/generate$/,
    handle: async (api, { id, body }) => [200, await api.generateStyle(id, body)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)\/clips$/,
    handle: async (api, { id }) => [200, await api.listClips(id)],
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/([^/]*)\/clip$/,
    handle: async (api, { id, body }) => [200, await api.selectClip(id, body)],
  },
  {
    method: 'PUT',
    pattern: /^\/api\/projects\/([^/]*)\/crop$/,
    handle: async (api, { id, body }) => [200, await api.updateCrop(id, body)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)\/music$/,
    handle: async (api, { id }) => [200, await api.getMusic(id)],
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]*)\/music\/complete$/,
    handle: async (api, { id, body }) => [200, await api.completeMusic(id, body)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)\/build$/,
    handle: async (api, { id }) => [200, await api.getBuild(id)],
  },
  {
    method: 'POST',
    pattern: /^\/api\/projects\/([^/]*)\/build$/,
    handle: async (api, { id, body }) => [202, await api.startBuild(id, body)],
  },
  {
    method: 'GET',
    pattern: /^\/api\/projects\/([^/]*)\/assets\/([^/]*)\/([^/]*)$/,
    file: true,
    handle: async (api, { id, params }) => [200, await api.getAsset(id, ...params)],
  },
];

export function createWebServer({ projectApi = createDefaultProjectApi() } = {}) {
  return createServer(async (request, response) => {
    try {
      if (!LOCAL_HOST.test(request.headers.host ?? '')) {
        sendJson(response, 403, { error: 'Forbidden host' });
        return;
      }

      const path = request.url?.split('?')[0] ?? '/';
      const matches = ROUTES
        .map((route) => ({ route, match: route.pattern.exec(path) }))
        .filter(({ match }) => match !== null);
      if (matches.length === 0) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      const found = matches.find(({ route }) => route.method === request.method);
      if (!found) {
        response.setHeader('allow', matches.map(({ route }) => route.method).join(', '));
        sendJson(response, 405, { error: 'Method not allowed' });
        return;
      }

      const [id, ...params] = found.match.slice(1).map(decodeURIComponent);
      let body;
      if (request.method !== 'GET') {
        assertSafeWrite(request);
        body = await readJsonBody(request);
      }

      const [status, payload] = await found.route.handle(projectApi, { id, params, body });
      if (found.route.file) sendFile(request, response, payload);
      else sendJson(response, status, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message, ...error.details });
        return;
      }
      if (error instanceof InvalidProjectIdError || error instanceof URIError) {
        sendJson(response, 400, { error: 'Invalid project id' });
        return;
      }
      if (error instanceof ProjectNotFoundError) {
        sendJson(response, 404, { error: 'Project not found' });
        return;
      }
      if (error instanceof BuildAlreadyRunningError) {
        sendJson(response, 409, { error: error.message, projectId: error.projectId });
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: 'Internal server error' });
    }
  });
}

/**
 * Yazan istekler JSON olmalı ve başka bir siteden gelmemeli: application/json
 * tarayıcıda ön kontrol (preflight) gerektirir, sunucu CORS izni vermez.
 */
function assertSafeWrite(request) {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (!LOCAL_HOST.test(host)) throw new ApiError(403, 'Forbidden origin');
  }
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new ApiError(415, 'Content-Type must be application/json');
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * Dosyayı akıtır. Tek aralıklı Range desteklenir: tarayıcı <video> ileri sarmak
 * için ister. Anlaşılmayan Range başlığında dosyanın tamamı gönderilir.
 */
function sendFile(request, response, { path, size, contentType }) {
  const range = parseRange(request.headers.range, size);
  if (range === null) {
    response.writeHead(416, { 'content-range': `bytes */${size}` });
    response.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const headers = {
    'content-type': contentType,
    'content-length': size === 0 ? 0 : end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  response.writeHead(range ? 206 : 200, headers);
  if (size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(path, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/** @returns {{ start: number, end: number } | undefined | null} null: karşılanamaz aralık (416) */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  const [start, end] = match[1] === ''
    ? [Math.max(0, size - Number(match[2])), size - 1]
    : [Number(match[1]), match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)];
  if (start >= size || start > end || (match[1] === '' && Number(match[2]) === 0)) return null;
  return { start, end };
}

function portFromEnvironment(value) {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = portFromEnvironment(process.env.PORT);
  const server = createWebServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Web API listening at http://127.0.0.1:${port}`);
  });
}
