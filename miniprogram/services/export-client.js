const api = require('./api');
const localPdf = require('./pdf-local');
const { PDFDocument } = require('../vendor/pdf-lib');
const { error } = require('./export-domain');

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  try {
    if (value && typeof value.byteLength === 'number') {
      const buffer = value.buffer || value;
      return new Uint8Array(buffer, Number(value.byteOffset) || 0, value.byteLength);
    }
  } catch (failure) {
    throw runtimeError('capture-read', failure, '截图数据格式无法识别');
  }
  throw error('EXPORT_RUNTIME', 'capture-read：微信未返回有效的截图字节，请重试');
}

function runtimeError(stage, failure, fallback) {
  if (failure && failure.stage === stage && failure.code) return failure;
  const message = failure && (failure.message || failure.errMsg || failure.errorMessage) || fallback;
  const wrapped = error('EXPORT_RUNTIME', `${stage}：${message}`);
  wrapped.stage = stage;
  wrapped.errMsg = failure && failure.errMsg;
  wrapped.cause = failure;
  return wrapped;
}

const invoke = (target, name, options, stage = name) => new Promise((resolve, reject) => {
  try {
    target[name](Object.assign({}, options, {
      success: resolve,
      fail: (failure) => reject(runtimeError(stage, failure, `${name} 调用失败`))
    }));
  } catch (failure) {
    reject(runtimeError(stage, failure, `${name} 调用失败`));
  }
});

function canvasFor(page, retries = 4) {
  return new Promise((resolve, reject) => {
    let query;
    try {
      query = wx.createSelectorQuery().in(page).select('#pdfCanvas');
      query.fields({ node: true, size: true }).exec((items) => {
        const result = items && items[0];
        const canvas = result && result.node;
        if (canvas && typeof canvas.getContext === 'function' && (canvas.width || result.width) && (canvas.height || result.height)) {
          resolve(canvas);
          return;
        }
        if (retries > 0) {
          setTimeout(() => canvasFor(page, retries - 1).then(resolve, reject), 180);
          return;
        }
        reject(error('EXPORT_RUNTIME', 'canvas-ready：打印画布尚未就绪，请稍后重试'));
      });
    } catch (failure) {
      if (retries > 0) {
        setTimeout(() => canvasFor(page, retries - 1).then(resolve, reject), 180);
      } else {
        reject(runtimeError('canvas-ready', failure, '打印画布查询失败'));
      }
    }
  });
}

async function finish(task, page, onProgress = () => {}) {
  if (task.provider !== 'local' || task.status !== 'running') return task;
  const manager = wx.getFileSystemManager();
  const filePath = `${wx.env.USER_DATA_PATH}/export_${task._id}.pdf`;
  let document;
  try {
    const existing = await invoke(manager, 'readFile', { filePath });
    const pdf = await PDFDocument.load(existing.data);
    document = { pageCount: pdf.getPageCount() };
  } catch (ignored) { /* A missing or incomplete file is regenerated from the immutable task snapshot. */ }
  if (!document) {
    try {
      const canvas = await canvasFor(page);
      document = await localPdf.render(task.snapshot, { canvas, onProgress,
        loadImage: async (fileId) => {
          let source;
          try {
            source = await api.call('file.access', { fileId });
          } catch (failure) {
            throw runtimeError('image-access', failure, '原图地址获取失败');
          }
          return new Promise((resolve, reject) => {
            let image;
            try { image = canvas.createImage(); }
            catch (failure) { reject(runtimeError('image-load', failure, '原图加载失败')); return; }
            image.onload = () => resolve(image);
            image.onerror = (failure) => reject(runtimeError('image-load', failure, '原图无法读取，请关闭附带原图或重新上传后导出'));
            image.src = source.url;
          });
        },
        capture: async () => {
          const width = Number(canvas.width);
          const height = Number(canvas.height);
          if (!width || !height) throw error('EXPORT_RUNTIME', 'canvas-capture：打印画布尺寸无效，请稍后重试');
          const result = await invoke(wx, 'canvasToTempFilePath', {
            canvas, x: 0, y: 0, width, height, destWidth: width, destHeight: height,
            fileType: 'jpg', quality: 0.95
          }, 'canvas-capture');
          try {
            const file = await invoke(manager, 'readFile', { filePath: result.tempFilePath }, 'capture-read');
            return bytesFrom(file && file.data !== undefined ? file.data : file);
          } finally { await invoke(manager, 'unlink', { filePath: result.tempFilePath }, 'capture-cleanup').catch(() => {}); }
        }
      });
      const data = document.bytes.buffer.slice(document.bytes.byteOffset, document.bytes.byteOffset + document.bytes.byteLength);
      await invoke(manager, 'writeFile', { filePath, data }, 'pdf-write');
    } catch (failure) {
      const wrapped = runtimeError(failure.stage || 'pdf-render', failure, 'PDF 生成失败，请重试');
      await api.call('export.fail', { taskId: task._id, attempt: task.attempt, code: wrapped.code, message: wrapped.message }).catch(() => {});
      throw wrapped;
    }
  }
  let completed;
  try {
    completed = await api.call('export.complete', { taskId: task._id, attempt: task.attempt, localPath: filePath, pageCount: document.pageCount });
  } catch (failure) {
    throw runtimeError('task-complete', failure, '导出任务状态更新失败，请查询任务');
  }
  onProgress(100);
  return completed;
}

async function open(taskId) {
  const result = await api.call('export.access', { taskId });
  let filePath = result.url;
  if (result.provider === 'cloud') {
    const downloaded = await invoke(wx.cloud, 'downloadFile', { fileID: result.cloudFileId });
    filePath = downloaded.tempFilePath;
  }
  return invoke(wx, 'openDocument', { filePath, fileType: 'pdf', showMenu: true });
}

module.exports = { finish, open };
