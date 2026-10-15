const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, wrap, WIDTH, HEIGHT, MARGIN, BOTTOM } = require('../miniprogram/services/pdf-layout');
const rules = require('../miniprogram/services/export-domain');
const measure = (text, size) => Array.from(text).length * size;
const snapshot = (template) => ({ title: '三年级错题复习', template, answerLines: 6,
  student: { name: '小明', grade: 3 }, questions: [{ subject: 'chinese', questionText: '阅读短文。' }] });

test('PDF layout keeps long Chinese, newlines and images inside A4 pages', () => {
  const data = snapshot('analysis');
  data.questions[0] = { subject: 'chinese', questionText: '春天的校园。'.repeat(300) + '\r\n第二段\n最后一段',
    sourceFileId: 'portrait', correctAnswer: '正确答案', analysis: '理解题意。'.repeat(100) };
  const plan = layout(data, measure, { portrait: { width: 500, height: 1500 } });
  assert.ok(plan.pages.length >= 2);
  assert.equal(plan.width, WIDTH);
  assert.equal(plan.height, HEIGHT);
  const content = [];
  for (const [index, page] of plan.pages.entries()) {
    assert.equal(page.at(-1).text, `${index + 1} / ${plan.pages.length}`);
    for (const op of page.slice(0, -1)) {
      assert.ok(op.x >= MARGIN);
      assert.ok(op.y >= 42);
      assert.ok(op.y + (op.height || op.size || 0) <= BOTTOM);
      if (op.type === 'text') { assert.ok(op.x + measure(op.text, op.size) <= WIDTH - MARGIN); content.push(op.text); }
      if (op.type === 'image') { assert.equal(op.height / op.width, 3); assert.ok(op.height <= 330); }
    }
  }
  assert.ok(content.includes('第二段'));
  assert.ok(content.includes('最后一段'));
});

test('PDF practice output excludes secret answer fields and original images', () => {
  const data = snapshot('practice');
  Object.assign(data.questions[0], { analysis: 'SECRET', correctAnswer: 'SECRET', sourceFileId: 'secret-image' });
  const plan = layout(data, measure);
  assert.equal(JSON.stringify(plan).includes('SECRET'), false);
  assert.equal(plan.pages.flat().filter((op) => op.type === 'image').length, 0);
  assert.equal(plan.pages.flat().filter((op) => op.light).length, 6);
});

test('PDF wrapper preserves all code points and rejects excessive pagination', () => {
  const value = '中文ABC😀'.repeat(100);
  assert.equal(wrap(value, 11, measure).join(''), value);
  const data = snapshot('practice');
  data.questions[0].questionText = '长题'.repeat(100000);
  assert.throws(() => layout(data, measure), { code: 'EXPORT_LIMIT' });
  assert.equal(rules.MAX_PAGES, 60);
});
