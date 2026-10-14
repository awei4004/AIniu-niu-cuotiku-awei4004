const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createBackend } = require('./helpers/api-harness');

function page(name, api) {
  let definition;
  const navigation = [];
  const context = vm.createContext({
    require(id) {
      if (id.endsWith('/api')) return api;
      if (id.endsWith('/storage')) return { makeId: () => `submission_${Date.now()}` };
      throw new Error(id);
    },
    Page(value) { definition = value; },
    wx: { showToast() {}, showModal: ({ success }) => success({ confirm: true }),
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
