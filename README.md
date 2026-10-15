# 小学生语文数学错题知识库

这是一个原生微信小程序项目，当前已实现阶段一至阶段四的演示闭环：学生管理、手动错题库、同类题生成确认、在线练习、复习记录和图片 OCR 录入。

阶段三当前使用明确标记的模板出题适配器，尚未调用真实 AI 模型。阶段四本地模式使用明确标记的演示识别；云端已预留腾讯云 OCR 适配器，只有配置云函数环境变量后才调用真实 OCR。

## 用微信开发者工具打开

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 选择本项目目录 `D:\workplace\微信小程序期末作业`。
4. 如果暂时没有真实 AppID，可以先使用游客 AppID 运行界面和本地演示模式。
5. 编译后进入首页，添加学生并录入错题；在录入页可以拍照/选图，或在错题详情中点击“生成同类题”继续阶段三流程。

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

`cloudEnvId` 为空时，用户、学生、错题、原图登记、生成题、生成任务和复习记录保存在微信开发者工具的本地缓存中，适合没有云环境时演示。

配置真实云开发环境后，将其替换为云环境 ID，并在云函数环境变量中配置 OCR 服务：

```js
module.exports = {
  cloudEnvId: '你的云环境ID'
};
```

然后在微信开发者工具中：

1. 开通并选择云开发环境。
2. 创建 `users`、`students`、`wrong_questions`、`generated_questions`、`practice_records`、`tasks` 和 `files` 数据库集合。
3. 在云函数环境变量中配置 `OCR_PROVIDER=tencent`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`，可选配置 `TENCENT_OCR_REGION` 和 `TENCENT_SESSION_TOKEN`。
4. 在根目录运行 `npm.cmd run build`，同步本地与云函数共用的出题、图片校验和判题规则。
5. 上传并部署 `cloudfunctions/api` 云函数，选择“云端安装依赖”。
6. 将数据库客户端权限设置为仅云函数可读写，业务接口中的归属校验负责区分用户。
7. 运行小程序并检查学生、错题、原图、生成题和复习记录。云环境配置只切换运行模式，本地缓存数据不会自动迁移。

云端业务默认通过云函数访问，`wrong_questions` 使用软删除；删除学生前会检查关联错题、未删除生成题和历史练习记录。阶段三生成批次保存和练习提交使用数据库事务。

## 当前文件

```text
project.config.json                 微信开发者工具项目配置
miniprogram/                        小程序前端
  pages/questions/                  错题列表、录入编辑和详情
  pages/generation/                 出题配置、候选题编辑确认
  pages/review/                     已确认练习、待确认题、复习记录
  pages/practice/                   在线练习、答案解析和家长判定
  pages/profile/                    我的页面
  pages/students/                   学生管理
  services/api.js                   云端/本地统一调用
  services/practice-domain.js       共用出题、JSON 校验、快照和判题规则
  services/image-domain.js          图片大小、格式、OCR 结果和原图绑定规则
  services/image-client.js          选图、上传进度和 OCR 页面调用
  utils/storage.js                  本地演示存储
cloudfunctions/api/                 学生、错题、生成题和练习云函数
  image-service.js                   文件登记、归属检查、OCR 任务和临时访问地址
  ocr-adapter.js                    腾讯云 OCR 服务端签名适配器
tests/student-api.test.js           学生和错题数据生命周期测试
tests/practice-api.test.js          本地/云函数模拟接口测试
tests/practice-pages.test.js        页面事件和闭环调用测试
tests/image-api.test.js              图片/OCR 本地与云函数模拟测试
tests/ocr-adapter.test.js            OCR 签名和服务端输出边界测试
scripts/sync-domain.js              同步云函数规则模块
scripts/check.js                    语法与微信模板编译检查
```

## 本地验证

在项目根目录运行：

```powershell
npm.cmd test
npm.cmd run check
```

`npm.cmd test` 验证学生、错题、阶段三闭环和阶段四图片/OCR流程；云函数测试使用模拟数据库，页面测试使用模拟微信运行环境。`npm.cmd run check` 使用 Node 和微信开发者工具自带编译器检查 JavaScript、WXML 和 WXSS。测试和检查前会自动同步云函数规则模块。

这些检查不代替真机界面验证或真实云环境部署验证。

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

## 阶段三验收流程

```text
录入数学错题 23 × 14 =
  → 详情点击“生成同类题”
  → 选择 3 道和难度，生成候选题
  → 修改一道题的题目、答案与解析，保存后确认
  → 点击“练习”并提交答案
  → 查看答案和解析
  → 在“复习 → 记录”查看历史
  → 再编辑该生成题，历史记录仍显示原题快照
```

数学整数单步加减乘除支持系统判定；简单一步应用题、拼音字词和近反义词使用家长判定，提交后先保存为待判定。未确认题不能练习，编辑已确认题会回到待确认状态。原错题内容变化后，旧候选题不能确认，需要重新生成。

演示出题只在有限模板范围内运行，不支持阅读理解、作文、复杂公式或复杂几何。图片 OCR 属于阶段四，打印文档属于阶段五。

阶段三的接口、状态规则和详细验收步骤见 [阶段三说明.md](阶段三说明.md)。

阶段四的图片格式校验、上传、OCR 任务、人工校对、原图查看和真实 OCR 配置见 [阶段四说明.md](阶段四说明.md)。默认本地演示不会调用真实 OCR；图片 OCR 和打印文档属于不同能力，PDF 导出仍需后续阶段实现。
