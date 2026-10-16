const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createBackend } = require('./helpers/api-harness');

function page(name, api, memory = new Map()) {
  let definition;
  let sequence = 0;
  const navigation = [];
  const context = vm.createContext({
    require(id) {
      if (id.endsWith('/api')) return api;
      if (id.endsWith('/storage')) return { makeId: () => `request_${++sequence}` };
      throw new Error(id);
    },
    Page(value) { definition = value; },
    wx: { getStorageSync: (key) => memory.get(key), setStorageSync: (key, value) => memory.set(key, value),
      removeStorageSync: (key) => memory.delete(key), showToast() {}, showModal: ({ success }) => success({ confirm: true }),
      navigateTo: ({ url }) => navigation.push(url), switchTab: ({ url }) => navigation.push(url) }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${name}/index.js`), 'utf8'), context);
  const instance = Object.assign({}, definition, { data: structuredClone(definition.data),
    setData(patch) {
      Object.entries(patch).forEach(([key, value]) => {
        const parts = key.split('.');
        let object = this.data;
        parts.slice(0, -1).forEach((part) => { object = object[part]; });
        object[parts[parts.length - 1]] = value;
      });
    }, navigation });
  return instance;
}
const event = (dataset) => ({ currentTarget: { dataset } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('generation page retains candidates and can retry when local AI is disconnected', async () => {
  const backend = createBackend('local');
  const student = await backend.call('student.create', { name: '连接测试学生', grade: 3 });
  const source = await backend.call('question.create', { studentId: student._id, subject: 'math', questionText: '23 + 14 =' });
  await backend.call('generation.create', { sourceQuestionId: source._id });
  let connected = false;
  const instance = page('generation', { call(action, data) {
    if (action === 'generation.config') return connected ? Promise.resolve({ provider: 'openai-compatible', ready: true })
      : Promise.reject(new Error('本地服务未启动'));
    return backend.call(action, data);
  } });
  instance.onLoad({ sourceQuestionId: source._id });
  await settle();
  assert.equal(instance.data.providerLabel, 'AI 未连接');
  assert.equal(instance.data.aiReady, false);
  assert.equal(instance.data.source._id, source._id);
  assert.equal(instance.data.questions.length, 1);
  assert.equal(instance.data.error, '本地服务未启动');
  connected = true;
  await instance.loadData();
  assert.equal(instance.data.providerLabel, 'AI 出题');
  assert.equal(instance.data.aiReady, true);
  assert.equal(instance.data.error, '');
});

test('generation page recovers a lost response after reentry without creating a second batch', async () => {
  const backend = createBackend('local');
  const student = await backend.call('student.create', { name: '恢复学生', grade: 3 });
  const source = await backend.call('question.create', { studentId: student._id, subject: 'math', questionText: '23 × 14 =' });
  const memory = new Map();
  let calls = 0;
  const api = { async call(action, data) {
    const result = await backend.call(action, data);
    if (action === 'generation.create') { calls += 1; throw { errMsg: 'network interrupted' }; }
    return result;
  } };
  const first = page('generation', api, memory);
  first.onLoad({ sourceQuestionId: source._id });
  await settle();
  await first.generate();
  assert.equal(first.data.uncertain, true);
  await first.generate();
  assert.equal(calls, 1);
  const restored = page('generation', api, memory);
  restored.onLoad({ sourceQuestionId: source._id });
  await settle();
  assert.equal(restored.data.uncertain, false);
  assert.equal(restored.data.questions.length, 3);
  assert.equal(memory.size, 0);
  assert.equal(calls, 1);
});

test('generation page marks real AI and disables generation when cloud AI is unconfigured', async () => {
  const backend = createBackend('local');
  const student = await backend.call('student.create', { name: '配置学生', grade: 3 });
  const source = await backend.call('question.create', { studentId: student._id, subject: 'math', questionText: '23 × 14 =' });
  for (const ready of [true, false]) {
    const api = { call: (action, data) => action === 'generation.config'
      ? Promise.resolve({ provider: 'openai-compatible', ready }) : backend.call(action, data) };
    const instance = page('generation', api);
    instance.onLoad({ sourceQuestionId: source._id });
    await settle();
    assert.equal(instance.data.providerLabel, ready ? 'AI 出题' : 'AI 待配置');
    if (!ready) { await instance.generate(); assert.equal(instance.data.questions.length, 0); }
  }
});

test('generation page recovers a request that never reached the server and clears explicit failures', async () => {
  const backend = createBackend('local');
  const student = await backend.call('student.create', { name: '中断学生', grade: 3 });
  const source = await backend.call('question.create', { studentId: student._id, subject: 'math', questionText: '23 × 14 =' });
  let first = true;
  const api = { call(action, data) {
    if (action === 'generation.create' && first) {
      first = false;
      return Promise.reject({ errMsg: 'request never sent' });
    }
    return backend.call(action, data);
  } };
  const instance = page('generation', api);
  instance.onLoad({ sourceQuestionId: source._id });
  await settle();
  await instance.generate();
  const originalId = instance.pending.requestId;
  await instance.queryTask();
  assert.equal(instance.data.uncertain, false);
  assert.equal(instance.data.questions.length, 3);
  assert.equal(backend.inspect('tasks')[0].requestId, originalId);
  const failed = page('generation', { call: (action, data) => action === 'generation.create'
    ? Promise.reject(Object.assign(new Error('认证失败'), { code: 'AI_AUTH_FAILED' })) : backend.call(action, data) });
  failed.onLoad({ sourceQuestionId: source._id });
  await settle();
  await failed.generate();
  assert.equal(failed.data.uncertain, false);
  assert.equal(failed.pending, null);
  assert.equal(failed.data.error, '认证失败');
});

test('pages support generation editing, practice, result and history navigation', async () => {
  const api = createBackend('local');
  const student = await api.call('student.create', { name: '页面学生', grade: 3 });
  const source = await api.call('question.create', { studentId: student._id, subject: 'math', questionText: '23 × 14 =' });
  const generation = page('generation', api);
  generation.onLoad({ sourceQuestionId: source._id });
  await settle();
  generation.generate();
  await settle();
  assert.equal(generation.data.questions.length, 3);
  assert.equal(generation.data.busy, false);
  const id = generation.data.questions[0]._id;
  generation.edit(event({ id }));
  for (const [field, value] of Object.entries({ questionText: '30 + 2 =', correctAnswer: '32', analysis: '30 加 2 得 32' })) {
    generation.changeField({ ...event({ field }), detail: { value } });
  }
  generation.saveEditor();
  await settle();
  assert.equal(generation.data.editor, null);
  generation.confirm(event({ id }));
  await settle();
  generation.practice(event({ id }));
  assert.match(generation.navigation[0], /pages\/practice\/index\?id=/);

  const practice = page('practice', api);
  practice.onLoad({ id });
  await settle();
  assert.equal(practice.data.question.correctAnswer, undefined);
  practice.changeAnswer({ detail: { value: '32' } });
  practice.submit();
  practice.submit();
  await settle();
  assert.equal(practice.data.resultLabel, '答对了');
  assert.equal(practice.data.record.questionSnapshot.correctAnswer, '32');
  assert.equal((await api.call('practice.records')).length, 1);

  const review = page('review', api);
  review.onShow();
  await settle();
  assert.equal(review.data.questions.length, 1);
  assert.equal(review.data.drafts.length, 2);
  assert.equal(review.data.records.length, 1);
  review.openRecord(event({ id: practice.data.record._id }));
  assert.match(review.navigation[0], /recordId=/);

  const result = page('practice', api);
  result.onLoad({ recordId: practice.data.record._id });
  await settle();
  assert.equal(result.data.question.questionText, '30 + 2 =');
  assert.equal(result.data.resultLabel, '答对了');
});

test('pages let adults grade an open answer and remove orphaned drafts', async () => {
  const api = createBackend('local');
  const student = await api.call('student.create', { name: '开放题学生', grade: 2 });
  const source = await api.call('question.create', { studentId: student._id, subject: 'chinese', questionText: '写出美丽的近义词' });
  const [first, second] = await api.call('generation.create', { sourceQuestionId: source._id, count: 2 });
  await api.call('generation.confirm', { generatedQuestionId: first._id });
  const practice = page('practice', api);
  practice.onLoad({ id: first._id });
  await settle();
  practice.changeAnswer({ detail: { value: '合理答案' } });
  practice.submit();
  await settle();
  assert.equal(practice.data.resultLabel, '待判定');
  practice.grade(event({ status: 'correct' }));
  await settle();
  assert.equal(practice.data.resultLabel, '答对了');

  await api.call('question.delete', { questionId: source._id });
  const generation = page('generation', api);
  generation.onLoad({ sourceQuestionId: source._id });
  await settle();
  assert.equal(generation.data.source, null);
  assert.equal(generation.data.questions.length, 2);
  generation.remove(event({ id: second._id }));
  await settle();
  assert.equal(generation.data.questions.length, 1);
});
