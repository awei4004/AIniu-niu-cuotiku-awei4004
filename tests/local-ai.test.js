const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const http = require('http');
const { createService } = require('../local-server/service');
const { createServer } = require('../local-server');
const { createBackend } = require('./helpers/api-harness');
const domain = require('../miniprogram/services/practice-domain');

const source = { subject: 'math', grade: 3, version: 1, questionText: '23 + 14 =',
  questionType: '计算题', correctAnswer: '37', studentAnswer: '38', errorReason: '加法错误' };
const input = { source, requestId: 'local-ai-request', count: 1, difficulty: 'normal' };
const code = (value) => (failure) => failure.code === value;
function fixture(t, generate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-question-ai-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  let received;
  const adapter = { provider: () => 'openai-compatible', status: () => ({ provider: 'openai-compatible', ready: true }),
    async generate(value, options) {
      calls += 1;
      received = value;
      if (generate) return generate(value, options);
      return { sourceVersion: domain.sourceVersion(value), questions: Array.from({ length: options.count }, (_, index) => ({
        questionText: `${30 + index} + 45 =`, correctAnswer: String(75 + index), analysis: '按数位相加。',
        knowledgePoints: '加法', questionType: '计算题', answerType: 'objective', difficulty: options.difficulty
      })) };
    } };
  const service = createService({ adapter, directory });
  return { directory, adapter, service, calls: () => calls, received: () => received };
}
async function listen(t, service) {
  const server = createServer(service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((failure) => failure ? reject(failure) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('local AI tasks survive restart and reuse results without sending identity fields', async (t) => {
  const f = fixture(t);
  const request = { ...input, source: { ...source, ownerId: 'private-owner', imageFileId: 'private-image', name: 'private-name' } };
  const first = await f.service.call('generation.create', request);
  assert.equal(first.status, 'completed');
  assert.equal(first.questions.length, 1);
  assert.equal(f.received().ownerId, undefined);
  assert.equal(f.received().imageFileId, undefined);
  assert.equal(f.received().name, undefined);
  assert.equal((await f.service.call('generation.create', request)).questions[0].questionText, first.questions[0].questionText);
  const restarted = createService({ adapter: f.adapter, directory: f.directory });
  assert.equal((await restarted.call('generation.create', request)).status, 'completed');
  assert.equal(f.calls(), 1);
  await assert.rejects(restarted.call('generation.create', { ...input, count: 2 }), code('CONFLICT'));
  await assert.rejects(restarted.call('task.get', { type: 'generation', requestId: 'unknown-request' }), code('NOT_FOUND'));
});

test('local AI concurrent retries share one task and interrupted tasks never resubmit automatically', async (t) => {
  let finish;
  const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  const running = f.service.call('generation.create', input);
  const task = await f.service.call('generation.create', input);
  assert.equal(task.status, 'running');
  assert.equal(f.calls(), 1);
  const snapshot = path.join(f.directory, 'restart');
  fs.mkdirSync(snapshot);
  fs.copyFileSync(path.join(f.directory, 'tasks.json'), path.join(snapshot, 'tasks.json'));
  const restarted = createService({ adapter: f.adapter, directory: snapshot });
  assert.equal((await restarted.call('generation.create', input)).errorCode, 'AI_TASK_INTERRUPTED');
  assert.equal(f.calls(), 1);
  finish({ sourceVersion: domain.sourceVersion(source), questions: [] });
  assert.equal((await running).errorCode, 'INVALID_AI_OUTPUT');
});

test('local AI validates source and retains sanitized provider failures', async (t) => {
  const f = fixture(t, () => { throw new Error('secret-api-key'); });
  for (const value of [{ ...input, requestId: '../bad' }, { ...input, count: 4 },
    { ...input, source: { ...source, grade: 7 } }, { ...input, source: { ...source, questionText: '' } }]) {
    await assert.rejects(f.service.call('generation.create', value), code('VALIDATION_ERROR'));
  }
  assert.equal(f.calls(), 0);
  const task = await f.service.call('generation.create', input);
  assert.equal(task.errorCode, 'AI_PROVIDER_FAILED');
  assert.equal(JSON.stringify(task).includes('secret-api-key'), false);
  assert.equal(fs.readFileSync(path.join(f.directory, 'tasks.json'), 'utf8').includes('secret-api-key'), false);
  assert.equal((await f.service.call('generation.create', input)).status, 'failed');
  assert.equal(f.calls(), 1);
  f.adapter.status = () => ({ provider: 'openai-compatible', ready: false });
  await assert.rejects(f.service.call('generation.create', { ...input, requestId: 'not-configured' }), code('AI_NOT_CONFIGURED'));
});

test('local HTTP rejects browser origins, invalid hosts and malformed bodies', async (t) => {
  const f = fixture(t);
  const url = await listen(t, f.service);
  assert.equal((await (await fetch(`${url}/health`)).json()).data.ready, true);
  for (const headers of [{ origin: 'https://example.test' }, { host: 'evil.example.test:8787' }]) {
    const status = await new Promise((resolve, reject) => {
      http.get(`${url}/health`, { headers }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  }
  for (const body of ['bad json', 'null', JSON.stringify({ action: 'generation.create', data: null })]) {
    const response = await fetch(`${url}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
  }
  const oversized = await fetch(`${url}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(128 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  assert.equal(f.calls(), 0);
});

async function miniFixture(t, generate, loseResponse = false) {
  const f = fixture(t, generate);
  const url = await listen(t, f.service);
  const requests = [];
  let lost = false;
  const api = createBackend('local', { localAiBaseUrl: url, request(options) {
    requests.push(structuredClone(options.data));
    fetch(options.url, { method: options.method, headers: options.header, body: JSON.stringify(options.data) })
      .then(async (response) => {
        const data = await response.json();
        if (loseResponse && !lost && options.data.action === 'generation.create') {
          lost = true;
          options.fail({ errMsg: 'response lost' });
        } else options.success({ statusCode: response.status, data });
      }).catch(options.fail);
  } });
  const student = await api.call('student.create', { name: '不应传输的学生姓名', grade: 3 });
  const question = await api.call('question.create', { ...source, studentId: student._id });
  return { ...f, api, question, requests, request: { sourceQuestionId: question._id, count: 1, requestId: input.requestId } };
}

test('mini program uses local HTTP, imports drafts once, and completes practice without cloud', async (t) => {
  const f = await miniFixture(t);
  assert.equal((await f.api.call('generation.config')).ready, true);
  const [question] = await f.api.call('generation.create', f.request);
  assert.equal(question.provider, 'openai-compatible');
  assert.equal(question.status, 'draft');
  assert.equal((await f.api.call('generation.create', f.request))[0]._id, question._id);
  assert.equal(f.calls(), 1);
  const submitted = f.requests.find((item) => item.action === 'generation.create').data;
  assert.equal(submitted.source.studentId, undefined);
  assert.equal(JSON.stringify(submitted).includes('不应传输的学生姓名'), false);
  await f.api.call('generation.confirm', { generatedQuestionId: question._id });
  const record = await f.api.call('practice.submit', { generatedQuestionId: question._id, answer: '75', submissionId: 'practice-local-ai' });
  assert.equal(record.resultStatus, 'correct');
  assert.equal(f.api.inspect('generated_questions').length, 1);
  f.api.switchUser('other-user');
  await assert.rejects(f.api.call('task.get', { type: 'generation', requestId: f.request.requestId }), code('NOT_FOUND'));
  const otherStudent = await f.api.call('student.create', { name: '另一学生', grade: 3 });
  const otherSource = await f.api.call('question.create', { ...source, studentId: otherStudent._id });
  const [otherQuestion] = await f.api.call('generation.create', { ...f.request, sourceQuestionId: otherSource._id });
  assert.notEqual(otherQuestion._id, question._id);
  assert.equal(otherQuestion.ownerId, 'other-user');
  assert.equal(f.api.inspect('generated_questions').length, 2);
});

test('mini program recovers a lost generation response through the original task', async (t) => {
  const f = await miniFixture(t, undefined, true);
  await assert.rejects(f.api.call('generation.create', f.request), code('LOCAL_AI_UNREACHABLE'));
  assert.equal(f.api.inspect('tasks')[0].status, 'running');
  assert.equal(f.api.inspect('generated_questions').length, 0);
  const task = await f.api.call('task.get', { type: 'generation', requestId: f.request.requestId });
  assert.equal(task.status, 'completed');
  await f.api.call('task.get', { type: 'generation', requestId: f.request.requestId });
  await f.api.call('generation.create', f.request);
  assert.equal(f.api.inspect('generated_questions').length, 1);
  assert.equal(f.calls(), 1);
});

test('mini program never publishes results if the source changed during generation', async (t) => {
  let finish;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const f = await miniFixture(t, (value, options) => { started(); return new Promise((resolve) => {
    finish = () => resolve(domain.demoGenerate(value, options));
  }); });
  const pending = f.api.call('generation.create', f.request);
  await ready;
  await f.api.call('question.update', { ...f.question, questionId: f.question._id, errorReason: '修改错因' });
  finish();
  await assert.rejects(pending, code('SOURCE_CHANGED'));
  assert.equal(f.api.inspect('generated_questions').length, 0);
  assert.equal(f.api.inspect('tasks')[0].status, 'failed');
});
