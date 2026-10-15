const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const domain = require('../../miniprogram/services/practice-domain');
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function createBackend(mode) {
  const memory = new Map();
  const tables = new Map();
  let openid = 'alice';
  let sequence = 0;
  let setFailure = 0;
  let adapter = async (source, options) => domain.demoGenerate(source, options);
  let ocrAdapter = async () => ({ provider: 'tencent', text: '23 × 14 =' });
  let ocrCalls = 0;
  let pdfCalls = 0;
  let pdfRenderer = async () => ({ bytes: Buffer.from('%PDF-1.7 mock'), pageCount: 1 });
  const uploads = [];
  let clockOffset = 0;
  let transactionQueue = Promise.resolve();
  const cloudFiles = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.now() + clockOffset])); }
    static now() { return Date.now() + clockOffset; }
  }
  const rows = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };
  const match = (item, query) => Object.entries(query).every(([key, value]) => {
    if (value && value.operation === 'exists') return (item[key] !== undefined) === value.value;
    if (value && value.operation === 'neq') return item[key] !== value.value;
    return item[key] === value;
  });
  function collection(name) {
    let query = {};
    let field;
    let direction;
    let skip = 0;
    let limit = 100;
    const handle = {
      where(value) { query = value; return this; },
      orderBy(value, order) { field = value; direction = order; return this; },
      skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; },
      async get() {
        let result = rows(name).filter((item) => match(item, query));
        if (field) result = result.slice().sort((a, b) => (Number(a[field]) - Number(b[field])) * (direction === 'desc' ? -1 : 1));
        return { data: clone(result.slice(skip, skip + limit)) };
      },
      async count() { return { total: rows(name).filter((item) => match(item, query)).length }; },
      async add({ data }) {
        const id = `cloud_${++sequence}`;
        rows(name).push(Object.assign({}, clone(data), { _id: id }));
        return { _id: id };
      },
      doc(id) {
        return {
          async get() { return { data: clone(rows(name).find((item) => item._id === id)) || null }; },
          async set({ data }) {
            if (setFailure && name === 'generated_questions' && --setFailure === 0) throw new Error('injected database write failure');
            const index = rows(name).findIndex((item) => item._id === id);
            const record = Object.assign({}, clone(data), { _id: id });
            if (index < 0) rows(name).push(record); else rows(name)[index] = record;
          },
          async update({ data }) {
            const item = rows(name).find((record) => record._id === id);
            if (!item) throw new Error('Missing document');
            Object.assign(item, clone(data));
          },
          async remove() { tables.set(name, rows(name).filter((item) => item._id !== id)); }
        };
      }
    };
    return handle;
  }
  const db = {
    command: {
      exists: (value) => ({ operation: 'exists', value }),
      neq: (value) => ({ operation: 'neq', value })
    },
    collection,
    runTransaction(callback) {
      const pending = transactionQueue.then(async () => {
        const backup = clone(tables);
        try { return await callback(db); } catch (error) {
          tables.clear();
          backup.forEach((value, key) => tables.set(key, value));
          throw error;
        }
      });
      transactionQueue = pending.catch(() => {});
      return pending;
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test', init() {}, getWXContext: () => ({ OPENID: openid }),
    database(config) {
      // The real SDK throws for absent doc.get unless this option is explicitly disabled.
      assert.equal(config.throwOnNotFound, false);
      return db;
    },
    async downloadFile({ fileID }) {
      if (!cloudFiles.has(fileID)) throw new Error('Missing cloud file');
      return { fileContent: Buffer.from(cloudFiles.get(fileID)) };
    },
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = `cloud://test.bucket/${cloudPath}`;
      uploads.push(fileID);
      cloudFiles.set(fileID, Buffer.from(fileContent));
      return { fileID };
    },
    async deleteFile({ fileList }) {
      fileList.forEach((id) => cloudFiles.delete(id));
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
    async getTempFileURL({ fileList }) {
      return { fileList: fileList.map((fileID) => ({ fileID, status: cloudFiles.has(fileID) ? 0 : -1,
        tempFileURL: `https://files.example.test/${fileID.split('/').slice(3).join('/')}` })) };
    }
  };
  const context = vm.createContext({ Date: Clock, Math, Promise, Buffer, console: { error() {} },
    getApp: () => ({ globalData: { cloudEnabled: false } }),
    wx: { getStorageSync: (key) => clone(memory.get(key)), setStorageSync: (key, value) => memory.set(key, clone(value)) }
  });
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const requireFile = (id) => {
      if (id === 'wx-server-sdk') return cloud;
      if (id === './ai-adapter') return { provider: 'demo', generate: (...args) => adapter(...args) };
      if (id === './ocr-adapter') return { provider: () => 'tencent', recognize: (...args) => { ocrCalls += 1; return ocrAdapter(...args); } };
      if (id === './pdf-renderer') return { render: (...args) => { pdfCalls += 1; return pdfRenderer(...args); } };
      if (!id.startsWith('.')) return require(id);
      return load(path.resolve(path.dirname(file), `${id}.js`));
    };
    vm.runInContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`, context,
      { filename: file })(requireFile, module, module.exports);
    return module.exports;
  }
  const entry = load(path.join(root, mode === 'local' ? 'miniprogram/services/api.js' : 'cloudfunctions/api/index.js'));
  const keys = { generated_questions: 'local_generated_questions', practice_records: 'local_practice_records',
    wrong_questions: 'local_wrong_questions', tasks: 'local_tasks', files: 'local_files' };
  return {
    async call(action, data = {}) {
      if (mode === 'local') return clone(await entry.call(action, data));
      const response = await entry.main({ action, data });
      if (!response.ok) { const error = new Error(response.error.message); error.code = response.error.code; throw error; }
      return clone(response.data);
    },
    switchUser(value) {
      openid = value;
      if (mode === 'local') memory.set('local_user', { _id: value, currentStudentId: '' });
    },
    inspect: (name) => clone(mode === 'local' ? memory.get(keys[name]) || [] : rows(name)),
    setAdapter(value) { adapter = value; },
    setOcrAdapter(value) { ocrAdapter = value; },
    ocrCalls: () => ocrCalls,
    setPdfRenderer(value) { pdfRenderer = value; },
    pdfCalls: () => pdfCalls,
    uploads: () => uploads.slice(),
    putCloudFile(id, bytes) { cloudFiles.set(id, Buffer.from(bytes)); },
    getCloudFile(id) { return cloudFiles.has(id) ? Buffer.from(cloudFiles.get(id)) : undefined; },
    advanceClock(value) { clockOffset += value; },
    failWrites() { setFailure = 2; }
  };
}

module.exports = { createBackend };
