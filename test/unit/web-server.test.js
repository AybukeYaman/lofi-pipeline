import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { getProject, getProjects } from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';

async function createProjectsFixture() {
  const videosDir = await mkdtemp(join(tmpdir(), 'lofi-web-api-'));
  const projectName = 'quiet-night';
  const projectDir = join(videosDir, projectName);
  await mkdir(join(projectDir, 'audio'), { recursive: true });
  await mkdir(join(projectDir, 'resimler'));
  await mkdir(join(projectDir, 'videolar'));
  await mkdir(join(projectDir, 'references'));
  await writeFile(join(projectDir, 'project.json'), JSON.stringify({
    clip: '',
    audioDir: './audio',
    video: { cropBottom: 150, aspect: '16:9' },
    output: { dir: './out' },
    style: 'cozy-realistic',
  }, null, 2));

  return {
    videosDir,
    projectName,
    cleanup: () => rm(videosDir, { recursive: true, force: true }),
  };
}

async function startServer(projectApi) {
  const server = createWebServer({ projectApi });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

describe('web server project API', () => {
  test('GET /api/projects returns filesystem projects', async () => {
    const fixture = await createProjectsFixture();
    const server = await startServer({
      getProjects: () => getProjects({ videosDir: fixture.videosDir }),
      getProject: (id) => getProject(id, { videosDir: fixture.videosDir }),
    });
    try {
      const response = await fetch(`${server.url}/api/projects`);
      assert.equal(response.status, 200);
      const projects = await response.json();
      assert.equal(projects.length, 1);
      assert.equal(projects[0].id, fixture.projectName);
      assert.equal(projects[0].name, fixture.projectName);
      assert.equal(typeof projects[0].mtimeMs, 'number');
      assert.equal(projects[0].step.id, 'faz3');
      assert.match(projects[0].step.detail, /videolar/);
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });

  test('GET /api/projects/:id returns inspectProject data and nextStep', async () => {
    const fixture = await createProjectsFixture();
    const server = await startServer({
      getProjects: () => getProjects({ videosDir: fixture.videosDir }),
      getProject: (id) => getProject(id, { videosDir: fixture.videosDir }),
    });
    try {
      const response = await fetch(`${server.url}/api/projects/${fixture.projectName}`);
      const project = await response.json();
      assert.equal(response.status, 200);
      assert.equal(project.id, fixture.projectName);
      assert.equal(project.name, fixture.projectName);
      assert.equal(project.style, 'cozy-realistic');
      assert.equal(project.step.id, 'faz3');
      assert.equal(project.projectJson.ok, true);
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });

  test('missing projects, traversal attempts, and unknown routes return JSON errors', async () => {
    const fixture = await createProjectsFixture();
    const server = await startServer({
      getProjects: () => getProjects({ videosDir: fixture.videosDir }),
      getProject: (id) => getProject(id, { videosDir: fixture.videosDir }),
    });
    try {
      const missing = await fetch(`${server.url}/api/projects/not-a-project`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'Project not found' });

      const traversal = await fetch(`${server.url}/api/projects/..%2Foutside`);
      assert.equal(traversal.status, 400);
      assert.deepEqual(await traversal.json(), { error: 'Invalid project id' });

      const unknown = await fetch(`${server.url}/api/unknown`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: 'Not found' });
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });

  test('canonical akış rotaları doğru API metoduna gövdeyle gider', async () => {
    const calls = [];
    const record = (name) => async (id, body) => {
      calls.push([name, id, body]);
      return { ok: name };
    };
    const server = await startServer({
      uploadProjectImage: record('image'),
      uploadProjectClip: record('clip'),
      uploadProjectAudio: record('audio'),
      updateTrackOrder: record('order'),
    });
    const send = (method, path, body) => fetch(`${server.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      assert.equal((await send('POST', '/api/projects/p/images', { slot: 'scene' })).status, 200);
      assert.equal((await send('POST', '/api/projects/p/clips', { name: 'a.mp4' })).status, 200);
      assert.equal((await send('POST', '/api/projects/p/audio', { name: 'a.mp3' })).status, 200);
      assert.equal((await send('PUT', '/api/projects/p/order', { mode: 'alphabetical' })).status, 200);
      assert.deepEqual(calls, [
        ['image', 'p', { slot: 'scene' }],
        ['clip', 'p', { name: 'a.mp4' }],
        ['audio', 'p', { name: 'a.mp3' }],
        ['order', 'p', { mode: 'alphabetical' }],
      ]);
      assert.equal((await send('GET', '/api/projects/p/order')).status, 405);
    } finally {
      await server.close();
    }
  });
});
