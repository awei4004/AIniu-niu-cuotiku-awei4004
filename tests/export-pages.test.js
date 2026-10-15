const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createBackend } = require('./helpers/api-harness');

function page(api, { memory = new Map(), client = {} } = {}) {
  let definition;
  let sequence = 0;
  const context = vm.createContext({
    require(id) {
      if (id.endsWith('/api')) return api;
      if (id.endsWith('/export-client')) return { finish: async (task) => task, ...client };
      if (id.endsWith('/export-domain')) return require('../miniprogram/services/export-domain');
      if (id.endsWith('/storage')) return { makeId: () => `export_page_request_${++sequence}` };
      throw new Error(id);
    },
    Page(value) { definition = value; },
    wx: { getStorageSync: (key) => memory.get(key), setStorageSync: (key, value) => memory.set(key, structuredClone(value)),
      removeStorageSync: (key) => memory.delete(key), navigateTo() {} }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/export/index.js'), 'utf8'), context);
  return Object.assign({}, definition, { data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } });
}
const change = (value) => ({ detail: { value } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const api = createBackend('local');
  const student = await api.call('student.create', { name: '导出页面学生', grade: 3 });
  const questions = [];
  for (const subject of ['math', 'chinese', 'math']) questions.push(await api.call('question.create', {
    studentId: student._id, subject, questionText: subject === 'math' ? '23 × 14 =' : '写出春天的景色'
  }));
  const memory = new Map();
  const instance = page(api, { memory });
  instance.initialStudentId = student._id;
  await instance.load();
  return { api, student, questions, memory, instance };
}

test('export page preserves selection across filters and clears it on student change', async () => {
  const { api, questions, instance } = await fixture();
  instance.changeSubject(change(2));
  instance.selectQuestions(change([questions[0]._id]));
  instance.changeSubject(change(1));
  instance.selectQuestions(change([questions[1]._id]));
  assert.equal(instance.data.selectedCount, 2);
  instance.changeKeyword(change('不存在的题目'));
  assert.equal(instance.data.visibleQuestions.length, 0);
  assert.equal(instance.data.selectedCount, 2);
  instance.changeKeyword(change(''));
  instance.changeSubject(change(0));
  assert.equal(instance.data.visibleQuestions.filter((q) => q.checked).length, 2);
  const second = await api.call('student.create', { name: '另一学生', grade: 1 });
  instance.data.students.push(second);
  await instance.changeStudent(change(1));
  assert.equal(instance.data.studentId, second._id);
  assert.equal(instance.data.selectedCount, 0);
  assert.equal(instance.data.visibleQuestions.length, 0);
});

test('export page prevents duplicate clicks, resumes local tasks and opens completed history', async () => {
  const { api, instance, memory } = await fixture();
  instance.selectAll();
  const first = instance.generate();
  await instance.generate();
  await first;
  assert.equal(api.inspect('tasks').filter((t) => t.type === 'export').length, 1);
  assert.equal(instance.data.uncertain, true);
  assert.ok(memory.get('export_recovery').taskId);
  let opened;
  const resumed = page(api, { memory, client: {
    finish: (task) => api.call('export.complete', { taskId: task._id, attempt: task.attempt,
      localPath: `wxfile://usr/export_${task._id}.pdf`, pageCount: 2 }),
    open: async (id) => { opened = id; }
  } });
  await resumed.load();
  assert.equal(resumed.data.task.status, 'running');
  await resumed.recoverTask();
  assert.equal(resumed.data.task.status, 'completed');
  assert.equal(memory.has('export_recovery'), false);
  assert.equal(resumed.data.history.length, 1);
  await resumed.selectHistory({ currentTarget: { dataset: { id: resumed.data.task._id } } });
  await resumed.openDocument();
  assert.equal(opened, resumed.data.task._id);
});

test('export page recovers lost create responses without creating a second task', async () => {
  const { api, memory, student } = await fixture();
  let loseResponse = true;
  const wrapped = { async call(action, data) {
    const result = await api.call(action, data);
    if (action === 'export.create' && loseResponse) { loseResponse = false; throw new Error('网络中断'); }
    return result;
  } };
  const instance = page(wrapped, { memory });
  instance.initialStudentId = student._id;
  await instance.load();
  instance.selectAll();
  await instance.generate();
  assert.equal(instance.data.task.status, 'running');
  assert.equal(instance.data.uncertain, true);
  await instance.generate();
  assert.equal(api.inspect('tasks').filter((t) => t.type === 'export').length, 1);
});

test('export page exposes retry after render failure and keeps completed tasks after open failure', async () => {
  const { api, student, memory } = await fixture();
  let fail = true;
  const instance = page(api, { memory, client: {
    async finish(task) {
      if (fail) {
        await api.call('export.fail', { taskId: task._id, attempt: task.attempt });
        throw new Error('画布失败');
      }
      return api.call('export.complete', { taskId: task._id, attempt: task.attempt,
        localPath: `wxfile://usr/export_${task._id}.pdf`, pageCount: 1 });
    },
    async open() { throw new Error('文件已被清理'); }
  } });
  instance.initialStudentId = student._id;
  await instance.load();
  instance.selectAll();
  await instance.generate();
  assert.equal(instance.data.task.status, 'failed');
  assert.equal(instance.data.uncertain, false);
  fail = false;
  await instance.retryTask();
  assert.equal(instance.data.task.attempt, 2);
  assert.equal(instance.data.task.status, 'completed');
  await instance.openDocument();
  await tick();
  assert.equal(instance.data.opening, false);
  assert.match(instance.data.error, /清理/);
  assert.equal(instance.data.task.status, 'completed');
});
