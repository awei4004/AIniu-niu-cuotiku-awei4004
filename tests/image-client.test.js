const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rules = require('../miniprogram/services/image-domain');
const { createBackend } = require('./helpers/api-harness');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY5kAAAAASUVORK5CYII=', 'base64');

function harness({ root = 'http://usr', bytes = png, size = bytes.length, cloud = false } = {}) {
  const backend = createBackend(cloud ? 'cloud' : 'local');
  const temporary = 'http://tmp/photo-with-misleading-extension.jpg';
  const files = new Map([[temporary, bytes]]);
  const calls = { saved: [], decoded: [], read: [], uploaded: [] };
  let decodeFails = false;
  let saveFails = false;
  let completeFails = false;
  let sequence = 0;
  const manager = {
    readFile({ filePath, success, fail }) {
      calls.read.push(filePath);
      if (!files.has(filePath)) return fail({ errMsg: 'readFile:fail missing file' });
      success({ data: Uint8Array.from(files.get(filePath)).buffer });
    },
    saveFile({ tempFilePath, filePath, success, fail }) {
      calls.saved.push(filePath);
      if (saveFails) return fail({ errMsg: 'saveFile:fail quota exceeded' });
      if (!files.has(tempFilePath)) return fail({ errMsg: 'saveFile:fail missing file' });
      files.set(filePath, files.get(tempFilePath));
      files.delete(tempFilePath);
      success({ savedFilePath: filePath });
    },
    unlink({ filePath, success }) { files.delete(filePath); success({}); }
  };
  const api = { async call(action, data) {
    if (action === 'file.complete' && completeFails) {
      completeFails = false;
      throw new Error('temporary registration failure');
    }
    return backend.call(action, data);
  } };
  const wx = {
    env: { USER_DATA_PATH: root },
    chooseMedia({ success }) { success({ tempFiles: [{ tempFilePath: temporary, size }] }); },
    getFileSystemManager: () => manager,
    getImageInfo({ src, success, fail }) {
      calls.decoded.push(src);
      if (src.startsWith('http://tmp/') || !files.has(src) || decodeFails) {
        return fail({ errMsg: 'getImageInfo:fail cannot decode image' });
      }
      success({ type: bytes[0] === 137 ? 'png' : 'jpeg', width: 1, height: 1 });
    },
    cloud: cloud ? { uploadFile({ filePath, cloudPath, success }) {
      calls.uploaded.push(filePath);
      assert.ok(files.has(filePath));
      const fileID = `cloud://test.bucket/${cloudPath}`;
      backend.putCloudFile(fileID, files.get(filePath));
      success({ fileID });
      return { onProgressUpdate(callback) { callback({ progress: 100 }); } };
    } } : undefined
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../miniprogram/services/image-client.js'), 'utf8'), {
    module, wx, getApp: () => ({ globalData: { cloudEnabled: cloud } }),
    require(id) {
      if (id === './api') return api;
      if (id === './image-domain') return rules;
      if (id === '../utils/storage') return { makeId: () => `image_${++sequence}` };
      throw new Error(id);
    }
  });
  return { client: module.exports, api, calls, files, temporary,
    failDecode() { decodeFails = true; }, failSave() { saveFails = true; },
    failComplete() { completeFails = true; } };
}

for (const root of ['http://usr', 'wxfile://usr']) {
  test(`images: ${root} persists a temporary URL before decoding and survives upload retry`, async () => {
    const env = harness({ root });
    const selection = await env.client.choose('album');
    assert.ok(selection.path.startsWith(`${root}/`));
    assert.ok(selection.path.endsWith('.png'));
    assert.equal(selection.format, 'png');
    assert.equal(selection.size, png.length);
    assert.deepEqual(env.calls.decoded, [selection.path]);
    assert.equal(env.files.has(env.temporary), false);
    env.failComplete();
    const options = { requestId: 'upload_client_retry', state: {} };
    await assert.rejects(env.client.upload(selection, options), /temporary registration failure/);
    const file = await env.client.upload(selection, options);
    assert.equal(file.status, 'ready');
    assert.equal((await env.api.call('file.access', { fileId: file._id })).url, selection.path);
    assert.equal((await env.client.upload(selection, options))._id, file._id);
    assert.equal(env.calls.saved.length, 1);
  });
}

test('images: validate actual bytes and size before persistence or rendering', async () => {
  for (const options of [
    { size: rules.MAX_BYTES + 1 }, { size: png.length + 1 }, { bytes: Buffer.from('not an image') }
  ]) {
    const env = harness(options);
    await assert.rejects(env.client.choose('album'), { code: 'FILE_INVALID' });
    assert.equal(env.calls.saved.length, 0);
    assert.equal(env.calls.decoded.length, 0);
    if (options.size > rules.MAX_BYTES) assert.equal(env.calls.read.length, 0);
  }
});

test('images: persistence and decode failures never return a temporary preview URL', async () => {
  const save = harness();
  save.failSave();
  await assert.rejects(save.client.choose('album'), { errMsg: 'saveFile:fail quota exceeded' });
  assert.equal(save.calls.decoded.length, 0);
  const decode = harness();
  decode.failDecode();
  await assert.rejects(decode.client.choose('album'), { code: 'FILE_INVALID' });
  assert.equal(decode.files.size, 0);
});

test('images: cloud upload retries reuse the uploaded persistent file', async () => {
  const env = harness({ cloud: true });
  const selection = await env.client.choose('camera');
  const options = { requestId: 'upload_cloud_client', state: {} };
  env.failComplete();
  await assert.rejects(env.client.upload(selection, options), /temporary registration failure/);
  const file = await env.client.upload(selection, options);
  assert.equal(file.status, 'ready');
  assert.deepEqual(env.calls.uploaded, [selection.path]);
  assert.equal(env.calls.saved.length, 1);
});
