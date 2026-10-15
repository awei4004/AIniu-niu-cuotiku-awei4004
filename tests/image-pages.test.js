const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function page(name, api, images = {}) {
  let definition;
  const context = {
    require(id) {
      if (id.endsWith('/api')) return api;
      if (id.endsWith('/image-client')) return images;
      if (id.endsWith('/storage')) return { makeId: () => 'upload_page_test' };
      throw new Error(id);
    },
    Page(value) { definition = value; },
    wx: { showModal: ({ success }) => success({ confirm: true }) }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/questions/${name}.js`), 'utf8'), context);
  return Object.assign({}, definition, { data: structuredClone(definition.data),
    setData(patch) { Object.assign(this.data, patch); } });
}
const errorEvent = (src) => ({ currentTarget: { dataset: { src } } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('image form: failed rendering retains attachment and permits reloading or removal', async () => {
  const savedPath = 'http://usr/question.png';
  const form = page('form', { call: async () => ({ url: savedPath }) });
  form.setData({ sourceFileId: 'file_first', imageUrl: savedPath, questionText: '1 + 2 =', ocrText: 'candidate' });
  form.onImageError(errorEvent('http://usr/older.png'));
  assert.equal(form.data.imageError, '');
  form.onImageError(errorEvent(savedPath));
  assert.equal(form.data.imageUrl, '');
  assert.equal(form.data.sourceFileId, 'file_first');
  assert.equal(form.data.questionText, '1 + 2 =');
  assert.ok(form.data.imageError);
  await form.retryImage();
  assert.equal(form.data.imageUrl, savedPath);
  assert.equal(form.data.imageError, '');
  form.onImageError(errorEvent(savedPath));
  form.removeImage();
  assert.equal(form.data.sourceFileId, '');
  assert.equal(form.data.imageError, '');
  assert.equal(form.data.questionText, '1 + 2 =');
});

test('image form: failed upload remains retryable after preview also fails', async () => {
  let attempts = 0;
  const selection = { path: 'http://usr/question.png', format: 'png', size: 100 };
  const form = page('form', { call: async () => ({ url: selection.path }) }, {
    choose: async () => selection,
    async upload(value) {
      assert.equal(value.path, selection.path);
      if (++attempts === 1) throw new Error('upload interrupted');
      return { _id: 'file_first' };
    }
  });
  form.choosePhoto({ currentTarget: { dataset: { source: 'album' } } });
  await settle();
  assert.equal(form.data.uploadPending, true);
  assert.equal(form.data.imageBusy, false);
  form.onImageError(errorEvent(selection.path));
  assert.equal(form.data.imageUrl, '');
  form.retryUpload();
  await settle();
  assert.equal(form.data.uploadPending, false);
  assert.equal(form.data.sourceFileId, 'file_first');
  assert.equal(form.data.imageUrl, selection.path);
});

test('image detail: rendering errors allow retry without losing question text', async () => {
  const savedPath = 'wxfile://usr/question.png';
  const detail = page('detail', { call: async () => ({ url: savedPath }) });
  detail.setData({ question: { sourceFileId: 'file_first', questionText: '1 + 2 =' } });
  await detail.loadImage('file_first');
  detail.onImageError(errorEvent('wxfile://usr/older.png'));
  assert.equal(detail.data.imageError, '');
  detail.onImageError(errorEvent(savedPath));
  assert.equal(detail.data.imageUrl, '');
  assert.ok(detail.data.imageError);
  assert.equal(detail.data.question.questionText, '1 + 2 =');
  detail.retryImage();
  await settle();
  assert.equal(detail.data.imageUrl, savedPath);
  assert.equal(detail.data.imageError, '');
});

test('image detail: an outdated access request cannot restore a removed image', async () => {
  let resolveAccess;
  const detail = page('detail', { call: () => new Promise((resolve) => { resolveAccess = resolve; }) });
  const pending = detail.loadImage('file_first');
  await detail.loadImage('');
  resolveAccess({ url: 'http://usr/older.png' });
  await pending;
  assert.equal(detail.data.imageUrl, '');
  assert.equal(detail.data.imageLoading, false);
});
