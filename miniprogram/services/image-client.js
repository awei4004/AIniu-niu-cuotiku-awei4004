const api = require('./api');
const rules = require('./image-domain');
const storage = require('../utils/storage');

function cloudEnabled() {
  try { return Boolean(getApp().globalData.cloudEnabled && wx.cloud); } catch (error) { return false; }
}

function invoke(target, name, options) {
  return new Promise((resolve, reject) => target[name](Object.assign({}, options, { success: resolve, fail: reject })));
}

async function choose(sourceType) {
  const result = await invoke(wx, 'chooseMedia', { count: 1, mediaType: ['image'],
    sourceType: [sourceType], sizeType: ['original'] });
  const chosen = result.tempFiles && result.tempFiles[0];
  if (!chosen) throw rules.error('FILE_INVALID', '未选择图片');
  rules.uploadFields({ format: 'jpg', size: chosen.size });
  const manager = wx.getFileSystemManager();
  const response = await invoke(manager, 'readFile', { filePath: chosen.tempFilePath });
  const bytes = new Uint8Array(response.data);
  const fields = rules.uploadFields({ format: bytes[0] === 137 ? 'png' : 'jpg', size: chosen.size });
  rules.checkImage(bytes, fields);
  // DevTools http://tmp URLs must not reach the image decoder or renderer.
  const filePath = `${wx.env.USER_DATA_PATH}/${storage.makeId('question_image')}.${fields.format}`;
  const saved = await invoke(manager, 'saveFile', { tempFilePath: chosen.tempFilePath, filePath });
  const savedPath = saved.savedFilePath || filePath;
  try {
    await invoke(wx, 'getImageInfo', { src: savedPath });
  } catch (error) {
    await invoke(manager, 'unlink', { filePath: savedPath }).catch(() => {});
    throw rules.error('FILE_INVALID', '无法读取图片内容，请重新选择 JPG 或 PNG 图片');
  }
  return Object.assign({ path: savedPath }, fields);
}

async function upload(selection, { requestId, state, onProgress = () => {} }) {
  const registered = await api.call('file.register', { requestId, format: selection.format, size: selection.size });
  if (registered.status === 'ready') { onProgress(100); return registered; }
  onProgress(0);
  if (cloudEnabled()) {
    if (!state.cloudFileId) {
      const response = await new Promise((resolve, reject) => {
        const task = wx.cloud.uploadFile({ cloudPath: registered.cloudPath, filePath: selection.path, success: resolve, fail: reject });
        if (task && task.onProgressUpdate) task.onProgressUpdate((value) => onProgress(value.progress));
      });
      state.cloudFileId = response.fileID;
    }
    const file = await api.call('file.complete', { fileId: registered._id, cloudFileId: state.cloudFileId });
    onProgress(100);
    return file;
  }
  if (!state.localPath) state.localPath = selection.path;
  const file = await api.call('file.complete', { fileId: registered._id, localPath: state.localPath });
  onProgress(100);
  return file;
}

module.exports = { choose, upload, cloudEnabled };
