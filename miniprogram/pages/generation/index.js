const api = require('../../services/api');
const storage = require('../../utils/storage');
const difficulties = ['easy', 'normal', 'hard'];
const terminalCodes = ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'SOURCE_CHANGED', 'INVALID_AI_OUTPUT',
  'UNSUPPORTED_GENERATION', 'AI_NOT_CONFIGURED', 'AI_AUTH_FAILED', 'AI_RATE_LIMITED', 'AI_CONFIG_ERROR', 'AI_PROVIDER_FAILED', 'AI_TIMEOUT'];

Page({
  data: {
    sourceQuestionId: '', source: null, questions: [], loading: true, busy: false,
    count: 3, difficultyIndex: 1, difficultyLabels: ['基础', '一般', '提高'],
    editor: null, editorId: '', answerTypeIndex: 0,
    answerTypeLabels: ['系统判定（唯一答案）', '家长判定（开放题）'], error: '',
    providerLabel: '正在检查', aiReady: false, uncertain: false
  },

  onLoad(options) {
    this.setData({ sourceQuestionId: options.sourceQuestionId || '' });
    this.pendingKey = `generation_pending_${this.data.sourceQuestionId}`;
    this.pending = wx.getStorageSync(this.pendingKey) || null;
    this.setData({ uncertain: Boolean(this.pending) });
    this.loadData().then(() => { if (this.pending) return this.queryTask(); });
  },

  loadData() {
    this.setData({ loading: true, error: '' });
    return Promise.all([
      api.call('question.detail', { questionId: this.data.sourceQuestionId }).catch((error) => {
        this.setData({ error: error.message });
        return null;
      }),
      api.call('generation.list', { sourceQuestionId: this.data.sourceQuestionId }),
      api.call('generation.config')
    ]).then(([source, questions, config]) => {
      this.setData({ source, questions, loading: false, aiReady: config.ready,
        providerLabel: config.provider === 'demo' ? '演示出题' : config.ready ? 'AI 出题' : 'AI 待配置' });
    }).catch((error) => this.setData({ loading: false, error: error.message }));
  },

  changeCount(event) { this.setData({ count: Number(event.detail.value) + 1 }); },
  changeDifficulty(event) { this.setData({ difficultyIndex: Number(event.detail.value) }); },

  generate() {
    if (this.data.busy || this.data.uncertain || !this.data.source || !this.data.aiReady) return;
    this.pending = { sourceQuestionId: this.data.sourceQuestionId, requestId: storage.makeId('generation'),
      count: this.data.count, difficulty: difficulties[this.data.difficultyIndex] };
    wx.setStorageSync(this.pendingKey, this.pending);
    this.setData({ busy: true, error: '' });
    return api.call('generation.create', this.pending).then(() => {
      this.clearPending();
      return this.loadData();
    }).catch((error) => this.generationFailure(error))
      .finally(() => this.setData({ busy: false }));
  },

  clearPending() {
    this.pending = null;
    wx.removeStorageSync(this.pendingKey);
    this.setData({ uncertain: false });
  },

  generationFailure(error) {
    if (terminalCodes.includes(error.code)) this.clearPending();
    else this.setData({ uncertain: true });
    this.setData({ error: error.message || error.errMsg || '出题结果尚未确认，请查询原任务' });
  },

  queryTask() {
    if (this.data.busy || !this.pending) return;
    this.setData({ busy: true, error: '' });
    const request = this.pending;
    return api.call('task.get', { type: 'generation', requestId: request.requestId })
      .catch((error) => {
        if (error.code !== 'NOT_FOUND') throw error;
        // Reuse the same ID when the original request never reached the server.
        return api.call('generation.create', request).then(() => ({ status: 'completed' }));
      }).then((task) => {
        if (task.status === 'running') {
          this.setData({ uncertain: true, error: '出题仍在进行，请稍后查询原任务' });
          return;
        }
        this.clearPending();
        if (task.status === 'failed') this.setData({ error: task.error || '出题失败，请重新生成' });
        else return this.loadData();
      }).catch((error) => this.generationFailure(error))
      .finally(() => this.setData({ busy: false }));
  },

  edit(event) {
    if (this.data.busy) return;
    const question = this.data.questions.find((item) => item._id === event.currentTarget.dataset.id);
    this.setData({ editorId: question._id, editor: Object.assign({}, question),
      answerTypeIndex: question.answerType === 'open' ? 1 : 0 });
  },
  closeEditor() { if (!this.data.busy) this.setData({ editor: null, editorId: '' }); },
  changeField(event) {
    const field = event.currentTarget.dataset.field;
    if (['questionText', 'correctAnswer', 'analysis', 'knowledgePoints'].includes(field)) {
      this.setData({ [`editor.${field}`]: event.detail.value });
    }
  },
  changeAnswerType(event) {
    const index = Number(event.detail.value);
    this.setData({ answerTypeIndex: index, 'editor.answerType': index ? 'open' : 'objective' });
  },
  saveEditor() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    api.call('generation.update', Object.assign({}, this.data.editor, {
      generatedQuestionId: this.data.editorId
    })).then(() => {
      this.setData({ editor: null, editorId: '' });
      return this.loadData();
    }).catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ busy: false }));
  },
  confirm(event) {
    this.mutate('generation.confirm', event.currentTarget.dataset.id);
  },
  remove(event) {
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: '删除生成题', content: '确认删除这道候选题？', success: (result) => {
      if (result.confirm) this.mutate('generation.delete', id);
    } });
  },
  mutate(action, id) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    api.call(action, { generatedQuestionId: id }).then(() => this.loadData())
      .catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ busy: false }));
  },
  practice(event) {
    wx.navigateTo({ url: `/pages/practice/index?id=${event.currentTarget.dataset.id}` });
  },
  openReview() { wx.switchTab({ url: '/pages/review/index' }); }
});
