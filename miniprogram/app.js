const { cloudEnvId } = require('./config/env');

App({
  globalData: {
    cloudEnabled: false
  },

  onLaunch() {
    if (cloudEnvId && wx.cloud) {
      wx.cloud.init({
        env: cloudEnvId,
        traceUser: true
      });
      this.globalData.cloudEnabled = true;
    }

    if (!wx.getStorageSync('local_user')) {
      wx.setStorageSync('local_user', {
        _id: 'local-user',
        openid: 'local-openid',
        displayName: '本地演示用户',
        currentStudentId: '',
        createdAt: Date.now()
      });
    }
  }
});
