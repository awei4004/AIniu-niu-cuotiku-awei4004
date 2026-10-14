# 小学生语文数学错题知识库

这是一个原生微信小程序项目，当前已完成阶段一和阶段二：项目骨架、学生管理、当前用户初始化、基础数据隔离接口，以及手动错题库闭环。

## 用微信开发者工具打开

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 选择本项目目录 `D:\workplace\微信小程序期末作业`。
4. 如果暂时没有真实 AppID，可以先使用游客 AppID 运行界面和本地演示模式。
5. 编译后进入首页，添加学生并录入、筛选、查看、编辑和删除错题。

## 当前运行模式

项目默认是本地演示模式：

```text
miniprogram/config/env.js
```

```js
module.exports = {
  cloudEnvId: ''
};
```

`cloudEnvId` 为空时，用户、学生和错题数据保存在微信开发者工具的本地缓存中，适合没有云环境时演示。

配置真实云开发环境后，将其替换为云环境 ID：

```js
module.exports = {
  cloudEnvId: '你的云环境ID'
};
```

然后在微信开发者工具中：

1. 开通并选择云开发环境。
2. 创建 `users`、`students` 和 `wrong_questions` 数据库集合。
3. 上传并部署 `cloudfunctions/api` 云函数，选择“云端安装依赖”。
4. 将数据库客户端权限设置为仅云函数可读写，业务接口中的归属校验负责区分用户。
5. 运行小程序并检查学生创建、切换、错题录入和筛选。

云端业务默认通过云函数访问，`wrong_questions` 使用软删除；删除学生前会检查是否存在未删除的关联错题。

## 当前文件

```text
project.config.json                 微信开发者工具项目配置
miniprogram/                        小程序前端
  pages/questions/                  错题列表、录入编辑和详情
  pages/review/                     复习占位页
  pages/profile/                    我的页面
  pages/students/                   学生管理
  services/api.js                   云端/本地统一调用
  utils/storage.js                  本地演示存储
cloudfunctions/api/                 学生、用户和错题云函数
tests/student-api.test.js           学生和错题数据生命周期测试
scripts/check.js                    语法与微信模板编译检查
```

## 本地验证

在项目根目录运行：

```powershell
npm.cmd test
npm.cmd run check
```

`npm.cmd test` 验证本地学生生命周期和输入校验；`npm.cmd run check` 使用 Node 和微信开发者工具自带编译器检查 JavaScript、WXML 和 WXSS。

## 阶段二验收流程

```text
打开小程序
  → 添加“小明”、三年级
  → 录入数学题 `23 × 14 =`
  → 填写学生答案、正确答案和错误原因
  → 返回错题库按数学筛选并搜索知识点
  → 打开详情并编辑掌握状态
  → 删除错题后确认列表不再显示
  → 进入学生管理确认仍有错题时不能删除学生
```

当前阶段暂不包含图片 OCR、AI 同类题、在线练习和打印文档，这些属于后续阶段。
