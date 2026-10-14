const api = require('../../services/api');

Page({
  data: {
    user: null,
    currentStudent: null,
    studentCount: 0
  },

  onShow() {
    this.loadOverview();
  },

  loadOverview() {
    Promise.all([
      api.call('user.bootstrap'),
      api.call('student.list')
    ]).then(([overview, students]) => {
      this.setData({
        user: overview.user,
        currentStudent: overview.currentStudent,
        studentCount: students.length
      });
    }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  openStudents() {
    wx.navigateTo({ url: '/pages/students/index' });
  },

  showComingSoon() {
    wx.showToast({ title: '错题录入将在下一阶段开放', icon: 'none' });
  }
});
