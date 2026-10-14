const api = require('../../services/api');
const difficulties = ['easy', 'normal', 'hard'];

Page({
  data: {
    sourceQuestionId: '', source: null, questions: [], loading: true, busy: false,
    count: 3, difficultyIndex: 1, difficultyLabels: ['基础', '一般', '提高'],
    editor: null, editorId: '', answerTypeIndex: 0,
    answerTypeLabels: ['系统判定（唯一答案）', '家长判定（开放题）'], error: ''
  },

  onLoad(options) {
    this.setData({ sourceQuestionId: options.sourceQuestionId || '' });
    this.loadData();
  },

  loadData() {
    this.setData({ loading: true, error: '' });
    return Promise.all([
      api.call('question.detail', { questionId: this.data.sourceQuestionId }).catch((error) => {
        this.setData({ error: error.message });
        return null;
      }),
      api.call('generation.list', { sourceQuestionId: this.data.sourceQuestionId })
    ]).then(([source, questions]) => {
      this.setData({ source, questions, loading: false });
    }).catch((error) => this.setData({ loading: false, error: error.message }));
  },

  changeCount(event) { this.setData({ count: Number(event.detail.value) + 1 }); },
  changeDifficulty(event) { this.setData({ difficultyIndex: Number(event.detail.value) }); },

  generate() {
    if (this.data.busy || !this.data.source) return;
    this.setData({ busy: true, error: '' });
    api.call('generation.create', {
      sourceQuestionId: this.data.sourceQuestionId,
      count: this.data.count, difficulty: difficulties[this.data.difficultyIndex]
    }).then(() => this.loadData())
      .catch((error) => this.setData({ error: error.message }))
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
