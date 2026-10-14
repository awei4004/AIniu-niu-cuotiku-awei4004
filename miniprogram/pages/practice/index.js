const api = require('../../services/api');
const storage = require('../../utils/storage');
const labels = { correct: '答对了', wrong: '需要再练习', ungraded: '待判定' };

Page({
  data: { question: null, record: null, answer: '', loading: true, busy: false, error: '', resultLabel: '' },
  onLoad(options) {
    this.questionId = options.id || '';
    this.recordId = options.recordId || '';
    this.submissionId = storage.makeId('submission');
    this.loadData();
  },
  loadData() {
    this.setData({ loading: true, error: '' });
    const request = this.recordId ? api.call('practice.detail', { recordId: this.recordId })
      : api.call('practice.start', { generatedQuestionId: this.questionId });
    request.then((result) => {
      if (this.recordId) this.showRecord(result);
      else this.setData({ question: result, loading: false });
    }).catch((error) => this.setData({ loading: false, error: error.message }));
  },
  changeAnswer(event) { this.setData({ answer: event.detail.value }); },
  submit() {
    if (this.data.busy || this.data.record) return;
    if (!this.data.answer.trim()) {
      wx.showToast({ title: '请先填写答案', icon: 'none' });
      return;
    }
    this.setData({ busy: true, error: '' });
    api.call('practice.submit', { generatedQuestionId: this.questionId,
      answer: this.data.answer, submissionId: this.submissionId, questionVersion: this.data.question.version })
      .then((record) => this.showRecord(record))
      .catch((error) => this.setData({ error: error.message }))
      .finally(() => this.setData({ busy: false }));
  },
  showRecord(record) {
    this.setData({ record, question: record.questionSnapshot, answer: record.answer,
      resultLabel: labels[record.resultStatus], loading: false });
  },
  grade(event) {
    if (this.data.busy || !this.data.record) return;
    this.setData({ busy: true });
    api.call('practice.grade', { recordId: this.data.record._id, resultStatus: event.currentTarget.dataset.status })
      .then((record) => this.showRecord(record))
      .catch((error) => wx.showToast({ title: error.message, icon: 'none' }))
      .finally(() => this.setData({ busy: false }));
  },
  openReview() { wx.switchTab({ url: '/pages/review/index' }); }
});
