const api = require('../../services/api');

Page({
  data: {
    user: null,
    currentStudent: null,
    students: []
  },

  onShow() {
    this.loadData();
  },

  loadData() {
    Promise.all([api.call('user.bootstrap'), api.call('student.list')]).then(([overview, students]) => {
      const firstLetter = overview.user && overview.user.displayName ? overview.user.displayName.slice(0, 1) : '我';
      this.setData({
        user: overview.user,
        currentStudent: overview.currentStudent,
        students,
        firstLetter
      });
    }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    });
  },

  openStudents() {
    wx.navigateTo({ url: '/pages/students/index' });
  }
});
