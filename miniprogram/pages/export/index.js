const api = require('../../services/api');
const client = require('../../services/export-client');
const storage = require('../../utils/storage');
const { MAX_QUESTIONS } = require('../../services/export-domain');
const RECOVERY_KEY = 'export_recovery';
const statusLabels = { running: '正在生成', completed: '已生成', failed: '生成失败' };

Page({
  data: {
    students: [], studentLabels: [], studentIndex: 0, studentId: '', questions: [], visibleQuestions: [],
    selectedIds: [], selectedCount: 0, subjects: ['全部学科', '语文', '数学'], subjectIndex: 0, keyword: '',
    title: '错题复习', template: 'practice', includeImages: false, lineOptions: ['3 行', '6 行', '9 行'], lineIndex: 1,
    loading: true, busy: false, opening: false, uncertain: false, error: '', progress: 0, task: null, history: []
  },

  onLoad(options) {
    this.initialStudentId = options.studentId || '';
    this.initialQuestionId = options.questionId || '';
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const [students, overview] = await Promise.all([api.call('student.list'), api.call('user.bootstrap')]);
      const studentIndex = Math.max(0, students.findIndex((s) => s._id === (this.initialStudentId || overview.user.currentStudentId)));
      this.setData({ students, studentLabels: students.map((s) => s.name), studentIndex, studentId: students[studentIndex] && students[studentIndex]._id || '' });
      await this.loadQuestions();
      if (this.initialQuestionId && this.data.questions.some((q) => q._id === this.initialQuestionId)) {
        this.setData({ selectedIds: [this.initialQuestionId] });
        this.filterQuestions();
      }
      await this.loadHistory();
      const request = wx.getStorageSync(RECOVERY_KEY);
      if (request) {
        try { this.acceptTask(await api.call('task.get', Object.assign({ type: 'export' }, request))); }
        catch (failure) {
          if (failure.code === 'NOT_FOUND') wx.removeStorageSync(RECOVERY_KEY);
          else { this.recoveryRequest = request; this.setData({ uncertain: true, error: '上次导出状态尚未确认，请查询任务' }); }
        }
      }
    } catch (failure) { this.setData({ error: failure.message || '加载失败，请重试' }); }
    finally { this.setData({ loading: false }); }
  },

  async loadQuestions() {
    if (!this.data.studentId) { this.setData({ questions: [], visibleQuestions: [], selectedIds: [], selectedCount: 0 }); return; }
    const studentId = this.data.studentId;
    const questions = await api.call('question.list', { studentId });
    if (this.data.studentId !== studentId) return;
    this.setData({ questions });
    this.filterQuestions();
  },

  filterQuestions() {
    const subject = ['', 'chinese', 'math'][this.data.subjectIndex];
    const keyword = this.data.keyword.trim().toLowerCase();
    const selected = new Set(this.data.selectedIds);
    this.setData({ selectedCount: selected.size, visibleQuestions: this.data.questions
      .filter((q) => (!subject || q.subject === subject) && (!keyword || [q.questionText, q.chapter, q.knowledgePoints].join(' ').toLowerCase().includes(keyword)))
      .map((q) => ({ _id: q._id, questionText: q.questionText, subjectLabel: q.subject === 'math' ? '数学' : '语文', checked: selected.has(q._id) })) });
  },

  async changeStudent(event) {
    if (this.data.busy || this.data.loading) return;
    const index = Number(event.detail.value);
    this.setData({ studentIndex: index, studentId: this.data.students[index]._id, questions: [], visibleQuestions: [], selectedIds: [], selectedCount: 0, loading: true, error: '' });
    try { await this.loadQuestions(); }
    catch (failure) { this.setData({ questions: [], visibleQuestions: [], error: failure.message || '错题加载失败' }); }
    finally { this.setData({ loading: false }); }
  },
  changeSubject(event) { this.setData({ subjectIndex: Number(event.detail.value) }); this.filterQuestions(); },
  changeKeyword(event) { this.setData({ keyword: event.detail.value }); this.filterQuestions(); },
  changeTitle(event) { this.setData({ title: event.detail.value }); },
  changeLines(event) { this.setData({ lineIndex: Number(event.detail.value) }); },
  changeImages(event) { this.setData({ includeImages: event.detail.value }); },
  changeTemplate(event) { this.setData({ template: event.detail.value, includeImages: false }); },

  selectQuestions(event) {
    if (this.data.busy) return;
    const visible = new Set(this.data.visibleQuestions.map((q) => q._id));
    const selectedIds = this.data.selectedIds.filter((id) => !visible.has(id)).concat(event.detail.value);
    if (selectedIds.length > MAX_QUESTIONS) {
      this.setData({ error: '每份资料最多选择 20 道题，请分批导出' });
      this.filterQuestions();
      return;
    }
    this.setData({ selectedIds, error: '' });
    this.filterQuestions();
  },

  selectAll() {
    if (this.data.busy) return;
    const ids = [...new Set(this.data.selectedIds.concat(this.data.visibleQuestions.map((q) => q._id)))];
    if (ids.length > MAX_QUESTIONS) { this.setData({ error: '当前结果超过 20 道，请筛选或手动选择' }); return; }
    this.setData({ selectedIds: ids, error: '' }); this.filterQuestions();
  },
  clearSelection() { if (!this.data.busy) { this.setData({ selectedIds: [] }); this.filterQuestions(); } },

  async generate() {
    if (this.data.busy || this.data.loading || this.data.uncertain) return;
    if (!this.data.selectedIds.length || !this.data.title.trim()) { this.setData({ error: '请填写标题并选择至少一道错题' }); return; }
    const requestId = storage.makeId('export');
    this.setData({ task: null });
    this.recoveryRequest = { requestId };
    wx.setStorageSync(RECOVERY_KEY, this.recoveryRequest);
    await this.run(() => api.call('export.create', { requestId, studentId: this.data.studentId, questionIds: this.data.selectedIds,
      template: this.data.template, title: this.data.title, includeImages: this.data.includeImages, answerLines: [3, 6, 9][this.data.lineIndex] }));
  },

  async run(operation) {
    this.setData({ busy: true, error: '', progress: 0, uncertain: false });
    try {
      let task = await operation();
      this.recoveryRequest = { taskId: task._id };
      wx.setStorageSync(RECOVERY_KEY, this.recoveryRequest);
      this.acceptTask(task);
      task = await client.finish(task, this, (progress) => this.setData({ progress }));
      this.acceptTask(task);
    } catch (failure) {
      try {
        const recovered = await api.call('task.get', Object.assign({ type: 'export' }, this.recoveryRequest));
        this.acceptTask(recovered);
        if (recovered.status !== 'completed') this.setData({ error: recovered.error || failure.message || failure.errMsg || '导出未完成，请查询任务后重试' });
      } catch (queryFailure) {
        const invalid = queryFailure.code === 'NOT_FOUND' && ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'EXPORT_LIMIT'].includes(failure.code);
        this.setData({ uncertain: !invalid, error: failure.message || failure.errMsg || '导出结果尚未确认，请查询任务' });
        if (invalid) wx.removeStorageSync(RECOVERY_KEY);
      }
    } finally { this.setData({ busy: false }); await this.loadHistory(); }
  },

  acceptTask(task) {
    this.setData({ task: Object.assign({}, task, { title: task.snapshot.title, count: task.snapshot.questions.length,
      statusLabel: statusLabels[task.status] }), uncertain: task.status === 'running', error: task.status === 'failed' ? task.error : '',
      progress: task.status === 'completed' ? 100 : this.data.progress });
    if (task.status !== 'running') wx.removeStorageSync(RECOVERY_KEY);
  },

  async recoverTask() {
    if (this.data.busy) return;
    const request = this.recoveryRequest || (this.data.task && { taskId: this.data.task._id }) || wx.getStorageSync(RECOVERY_KEY);
    if (!request) return;
    await this.run(() => api.call('task.get', Object.assign({ type: 'export' }, request)));
  },
  async retryTask() {
    if (this.data.busy || !this.data.task) return;
    this.recoveryRequest = { taskId: this.data.task._id };
    wx.setStorageSync(RECOVERY_KEY, this.recoveryRequest);
    await this.run(() => api.call('export.retry', { taskId: this.data.task._id }));
  },
  async loadHistory() {
    try {
      const tasks = await api.call('export.list');
      this.setData({ history: tasks.map((t) => Object.assign({}, t, { statusLabel: statusLabels[t.status],
        templateLabel: t.template === 'practice' ? '练习版' : '解析版', dateLabel: new Date(t.createdAt).toLocaleDateString() })) });
    } catch (failure) { this.setData({ error: failure.message || '导出记录加载失败' }); }
  },
  async selectHistory(event) {
    if (this.data.busy || this.data.uncertain) return;
    try {
      const taskId = event.currentTarget.dataset.id;
      const task = await api.call('task.get', { type: 'export', taskId });
      this.recoveryRequest = { taskId };
      this.acceptTask(task);
      if (task.status === 'running') wx.setStorageSync(RECOVERY_KEY, { taskId });
    } catch (failure) { this.setData({ error: failure.message || '无法读取记录' }); }
  },
  async openDocument() {
    if (this.data.opening || !this.data.task || this.data.task.status !== 'completed') return;
    this.setData({ opening: true, error: '' });
    try { await client.open(this.data.task._id); }
    catch (failure) { this.setData({ error: failure.message || failure.errMsg || 'PDF 打开失败，请重试；本地文件若已被清理，请重新导出' }); }
    finally { this.setData({ opening: false }); }
  },
  openStudents() { wx.navigateTo({ url: '/pages/students/index' }); }
});
