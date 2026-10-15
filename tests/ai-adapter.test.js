const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAdapter, createTransport } = require('../cloudfunctions/api/ai-adapter');
const domain = require('../miniprogram/services/practice-domain');
const { createBackend } = require('./helpers/api-harness');

const env = { AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'https://ai.example.test/v1',
  AI_API_KEY: 'server-secret', AI_MODEL: 'configured-model' };
const source = { _id: 'private-question-id', ownerId: 'private-owner-id', studentId: 'private-student-id',
  openid: 'private-openid', name: 'private-name', sourceFileId: 'private-file-id', grade: 3,
  subject: 'math', questionText: '23 × 14 =', correctAnswer: '322', errorReason: '忘记进位', knowledgePoints: '两位数乘法' };
const options = { count: 1, difficulty: 'normal' };
const question = { questionText: '24 × 15 =', correctAnswer: '360', analysis: '24×10+24×5=360。',
  knowledgePoints: '两位数乘法', questionType: '计算题', difficulty: 'normal', answerType: 'objective' };
const response = (questions = [question], extra = {}) => ({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ questions }) }, ...extra }] });
const code = (expected) => (failure) => failure.code === expected;

test('real AI adapter sends teaching fields only and binds validated results to the server snapshot', async () => {
  let sent;
  const adapter = createAdapter({ env, send: async (request) => { sent = request; return response(); } });
  assert.deepEqual(adapter.status(), { provider: 'openai-compatible', ready: true });
  const output = await adapter.generate(source, options);
  assert.equal(output.sourceVersion, domain.sourceVersion(source));
  assert.deepEqual(domain.validateOutput(output, source, options), [question]);
  assert.equal(sent.url.href, 'https://ai.example.test/v1/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer server-secret');
  assert.equal(sent.headers['Content-Length'], Buffer.byteLength(sent.body));
  const body = JSON.parse(sent.body);
  assert.equal(body.model, env.AI_MODEL);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /JSON/);
  const prompt = JSON.parse(body.messages[1].content);
  assert.equal(prompt.source.errorReason, source.errorReason);
  for (const value of ['private-question-id', 'private-owner-id', 'private-student-id', 'private-openid', 'private-name', 'private-file-id', env.AI_API_KEY]) {
    assert.equal(sent.body.includes(value), false);
  }
  assert.equal(JSON.stringify(adapter.status()).includes(env.AI_API_KEY), false);
});

test('AI configuration must be explicit and invalid configuration never invokes the provider', async () => {
  for (const config of [{}, { ...env, AI_API_KEY: '' }, { ...env, AI_MODEL: '' },
    { ...env, AI_BASE_URL: 'http://ai.example.test' }, { ...env, AI_BASE_URL: 'https://user:pass@ai.example.test' },
    { ...env, AI_TIMEOUT_MS: '0' }, { ...env, AI_MAX_TOKENS: 'bad' }, { ...env, AI_TOKEN_PARAMETER: 'unknown' }]) {
    const adapter = createAdapter({ env: config, send: () => { assert.fail('must not call provider'); } });
    assert.equal(adapter.status().ready, false);
    await assert.rejects(adapter.generate(source, options), code('AI_NOT_CONFIGURED'));
  }
  const demo = createAdapter({ env: { AI_PROVIDER: 'demo' }, send: () => assert.fail('demo must stay offline') });
  assert.equal(demo.provider(), 'demo');
  assert.equal(domain.validateOutput(await demo.generate(source, options), source, options).length, 1);
});

test('compatible adapter supports token parameter selection, fenced JSON and parent grading', async () => {
  let body;
  const adapter = createAdapter({ env: { ...env, AI_TOKEN_PARAMETER: 'max_completion_tokens', AI_RESPONSE_FORMAT: 'text' },
    send: async (request) => {
      body = JSON.parse(request.body);
      return response([], { message: { content: '```json\n' + JSON.stringify({ questions: [question] }) + '\n```' } });
    } });
  const output = await adapter.generate({ ...source, subject: 'chinese' }, options);
  assert.equal(output.questions[0].answerType, 'open');
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.response_format, undefined);
  for (const values of [{ correctAnswer: '360 支' }, { questionType: '应用题' }, { questionType: '选择题' }]) {
    const parent = createAdapter({ env, send: async () => response([{ ...question, ...values }]) });
    assert.equal((await parent.generate(source, options)).questions[0].answerType, 'open');
  }
});

test('AI result boundary rejects truncated, refused, malformed, duplicate and incomplete questions', async () => {
  for (const output of [{}, response([], { finish_reason: 'length' }), response([], { message: { refusal: 'no' } }),
    response([], { message: { content: 'not JSON' } }), response([]), response([null]),
    response([{ ...question, analysis: '' }]), response([{ ...question, difficulty: 'hard' }]),
    response([{ ...question, questionText: source.questionText }])]) {
    await assert.rejects(createAdapter({ env, send: async () => output }).generate(source, options), code('INVALID_AI_OUTPUT'));
  }
  await assert.rejects(createAdapter({ env, send: async () => response([question, question]) })
    .generate(source, { ...options, count: 2 }), code('INVALID_AI_OUTPUT'));
});

function transportFor(emit) {
  let destroyed = false;
  const send = createTransport((url, config, callback) => {
    const request = new EventEmitter();
    request.destroy = () => { destroyed = true; request.emit('error', new Error('private transport details')); };
    request.end = () => queueMicrotask(() => {
      const result = new EventEmitter();
      result.statusCode = 200;
      result.resume = () => {};
      emit(result, callback, request);
    });
    return request;
  });
  return { send: () => send({ url: new URL(env.AI_BASE_URL), headers: {}, body: '{}', timeoutMs: 10 }),
    destroyed: () => destroyed };
}

test('AI HTTP transport handles success, sanitized status errors, interrupted responses and limits', async () => {
  const ok = transportFor((result, callback) => {
    callback(result); result.emit('data', Buffer.from(JSON.stringify(response()))); result.emit('end');
  });
  assert.deepEqual(await ok.send(), response());
  for (const [status, expected] of [[401, 'AI_AUTH_FAILED'], [403, 'AI_AUTH_FAILED'], [429, 'AI_RATE_LIMITED'],
    [400, 'AI_CONFIG_ERROR'], [404, 'AI_CONFIG_ERROR'], [422, 'AI_CONFIG_ERROR'], [500, 'AI_PROVIDER_FAILED']]) {
    const transport = transportFor((result, callback) => { result.statusCode = status; callback(result); });
    await assert.rejects(transport.send(), (failure) => {
      assert.equal(failure.code, expected);
      assert.equal(failure.message.includes('private'), false);
      return true;
    });
    assert.equal(transport.destroyed(), true);
  }
  for (const [emit, expected] of [
    [(result, callback) => { callback(result); result.emit('aborted'); }, 'AI_PROVIDER_FAILED'],
    [(result, callback) => { callback(result); result.emit('data', Buffer.alloc(1024 * 1024 + 1)); }, 'INVALID_AI_OUTPUT'],
    [(result, callback) => { callback(result); result.emit('data', Buffer.from('bad')); result.emit('end'); }, 'INVALID_AI_OUTPUT'],
    [() => {}, 'AI_TIMEOUT']
  ]) await assert.rejects(transportFor(emit).send(), code(expected));
});

async function fixture() {
  const api = createBackend('cloud');
  const student = await api.call('student.create', { name: '测试学生', grade: 3 });
  const saved = await api.call('question.create', { studentId: student._id, subject: 'math', questionText: source.questionText });
  const request = { sourceQuestionId: saved._id, requestId: 'real-ai-request', ...options };
  return { api, source: saved, request };
}

test('real adapter integrates with cloud generation and repeated requests reuse validated drafts', async () => {
  const { api, request } = await fixture();
  const adapter = createAdapter({ env, send: async () => response() });
  api.setAdapter(adapter.generate, adapter.provider());
  assert.equal((await api.call('generation.config')).provider, 'openai-compatible');
  const [first] = await api.call('generation.create', request);
  assert.equal(first.provider, 'openai-compatible');
  assert.equal(first.status, 'draft');
  assert.equal((await api.call('generation.create', request))[0]._id, first._id);
  assert.equal(api.aiCalls(), 1);
  assert.equal(api.inspect('generated_questions').length, 1);
  await assert.rejects(api.call('generation.create', { ...request, count: 2 }), code('CONFLICT'));
  const task = await api.call('task.get', { type: 'generation', requestId: request.requestId });
  assert.equal(task.status, 'completed');
  api.switchUser('other-user');
  await assert.rejects(api.call('task.get', { type: 'generation', taskId: task._id }), code('NOT_FOUND'));
});

test('concurrent generation runs one provider call and timed out tasks reject late results', async () => {
  const { api, request } = await fixture();
  let release;
  api.setAdapter((saved, values) => new Promise((resolve) => { release = () => resolve(domain.demoGenerate(saved, values)); }));
  const running = api.call('generation.create', request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  await assert.rejects(api.call('generation.create', request), code('GENERATION_RUNNING'));
  assert.equal(api.aiCalls(), 1);
  assert.equal((await api.call('task.get', { type: 'generation', requestId: request.requestId })).status, 'running');
  api.advanceClock(90001);
  const expired = await api.call('task.get', { type: 'generation', requestId: request.requestId });
  assert.equal(expired.status, 'failed');
  assert.equal(expired.errorCode, 'AI_TIMEOUT');
  release();
  await assert.rejects(running, code('AI_TIMEOUT'));
  assert.equal(api.inspect('generated_questions').length, 0);
  await assert.rejects(api.call('generation.create', request), code('AI_TIMEOUT'));
  assert.equal(api.aiCalls(), 1);
});

test('source edits during a real AI request reject stale output without saving questions', async () => {
  const { api, source: saved, request } = await fixture();
  let release;
  const adapter = createAdapter({ env, send: async () => new Promise((resolve) => { release = () => resolve(response()); }) });
  api.setAdapter(adapter.generate, adapter.provider());
  const running = api.call('generation.create', request);
  await new Promise((resolve) => setImmediate(resolve));
  await api.call('question.update', { ...saved, questionId: saved._id, questionText: '12 × 15 =' });
  release();
  await assert.rejects(running, code('SOURCE_CHANGED'));
  assert.equal(api.inspect('generated_questions').length, 0);
  assert.equal(api.inspect('tasks')[0].status, 'failed');
});
