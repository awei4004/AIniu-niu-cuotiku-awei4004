const api = require('../../services/api');

const MASTERY_OPTIONS = [
  { value: 'new', label: '待复习' },
  { value: 'reviewing', label: '复习中' },
  { value: 'familiar', label: '较熟悉' },
  { value: 'mastered', label: '已掌握' }
];

Page({
  data: {
    questionId: '',
    question: null,
    student: null,
    masteryOptions: MASTERY_OPTIONS,
    masteryIndex: 0,
    loading: true,
    deleting: false,
    imageUrl: '', imageError: '', imageLoading: false
  },

  onLoad(options) {
    this.setData({ questionId: options.id || '' });
    this.loadDetail(options.id || '');
  },

  onShow() {
    if (this.data.questionId && this.data.question) this.loadDetail(this.data.questionId);
  },

  loadDetail(questionId) {
    if (!questionId) {
      this.setData({ loading: false });
      return;
    }
    this.setData({ loading: true });
    Promise.all([
      api.call('question.detail', { questionId }),
      api.call('student.list')
    ]).then(([question, students]) => {
      this.setData({
        question: Object.assign({}, question, {
          subjectLabel: question.subject === 'math' ? '数学' : '语文',
          difficultyLabel: getDifficultyLabel(question.difficulty),
          masteryLabel: getMasteryLabel(question.mastery)
        }),
        student: students.find((item) => item._id === question.studentId) || null,
        masteryIndex: Math.max(0, MASTERY_OPTIONS.findIndex((item) => item.value === question.mastery)),
        loading: false
      });
      this.loadImage(question.sourceFileId);
    }).catch((error) => {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  editQuestion() {
    wx.navigateTo({ url: `/pages/questions/form?id=${this.data.questionId}` });
  },

  exportQuestion() {
    if (!this.data.question) return;
    wx.navigateTo({ url: `/pages/export/index?studentId=${this.data.question.studentId}&questionId=${this.data.questionId}` });
  },

  loadImage(fileId) {
    this.imageFileId = fileId;
    if (!fileId) { this.setData({ imageUrl: '', imageError: '', imageLoading: false }); return Promise.resolve(); }
    this.setData({ imageLoading: true, imageError: '', imageUrl: '' });
    return api.call('file.access', { fileId }).then((result) => {
      if (this.imageFileId === fileId) this.setData({ imageUrl: result.url });
    }).catch((error) => {
      if (this.imageFileId === fileId) this.setData({ imageError: error.message || '原图暂时无法查看' });
    }).finally(() => {
      if (this.imageFileId === fileId) this.setData({ imageLoading: false });
    });
  },

  onImageError(event) {
    if (event.currentTarget.dataset.src !== this.data.imageUrl) return;
    this.setData({ imageUrl: '', imageError: '原图加载失败，请重新加载；本地图片若已被清理，请编辑错题并重新选择图片' });
  },

  previewImage() {
    if (this.data.imageLoading || !this.data.question) return;
    this.loadImage(this.data.question.sourceFileId).then(() => {
      if (this.data.imageUrl) wx.previewImage({ urls: [this.data.imageUrl],
        fail: () => this.setData({ imageError: '原图暂时无法预览，请重新加载' }) });
    });
  },

  retryImage() { this.loadImage(this.data.question.sourceFileId); },

  generateSimilar() {
    wx.navigateTo({ url: `/pages/generation/index?sourceQuestionId=${this.data.questionId}` });
  },

  changeMastery(event) {
    const masteryIndex = Number(event.detail.value);
    const mastery = MASTERY_OPTIONS[masteryIndex].value;
    const question = this.data.question;
    if (!question || mastery === question.mastery) return;
    this.setData({ masteryIndex });
    api.call('question.update', Object.assign({}, question, { mastery, expectedVersion: question.version || 1 })).then((updated) => {
      this.setData({ question: Object.assign({}, updated, {
        subjectLabel: updated.subject === 'math' ? '数学' : '语文',
        difficultyLabel: getDifficultyLabel(updated.difficulty),
        masteryLabel: getMasteryLabel(updated.mastery)
      }) });
      wx.showToast({ title: '状态已更新', icon: 'success' });
    }).catch((error) => {
      this.setData({ masteryIndex: Math.max(0, MASTERY_OPTIONS.findIndex((item) => item.value === question.mastery)) });
      wx.showToast({ title: error.message || '状态更新失败', icon: 'none' });
    });
  },

  deleteQuestion() {
    if (this.data.deleting) return;
    wx.showModal({
      title: '删除错题',
      content: '删除后默认列表中不再显示这道错题，确认继续吗？',
      confirmColor: '#d43828',
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ deleting: true });
        api.call('question.delete', { questionId: this.data.questionId }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 350);
        }).catch((error) => {
          this.setData({ deleting: false });
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        });
      }
    });
  }
});

function getMasteryLabel(value) {
  return { new: '待复习', reviewing: '复习中', familiar: '较熟悉', mastered: '已掌握' }[value] || '待复习';
}

function getDifficultyLabel(value) {
  return { easy: '基础', normal: '一般', hard: '提高' }[value] || '一般';
}
