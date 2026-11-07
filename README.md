<div align="center">
  
# 🐳 DeepBrim

**专为 DeepSeek 网页端打造的上下文真值仪表盘**

[![Edge Add-ons](https://img.shields.io/badge/Microsoft_Edge-等待审核中-blue?logo=microsoftedge)](https://github.com/MCharlieDev/DeepBrim)
[![Version](https://img.shields.io/badge/version-1.3.3-green)](https://github.com/MCharlieDev/DeepBrim)
[![License](https://img.shields.io/badge/license-MIT-orange)](https://github.com/MCharlieDev/DeepBrim/blob/main/LICENSE)

> “看清每一次 Token 用量，保护你的长对话不被突然截断。”

</div>

---

## 💡 为什么选择 DeepBrim？

你是否经历过：深夜用网页版 DeepSeek 写了几个小时的代码或长文，聊得正嗨，突然弹出一句冷冰冰的“对话已达上限”？前面几十轮的铺垫瞬间灰飞烟灭。

市面上的同类工具大多依靠数网页字数来“估算” Token，长对话误差极大；甚至打开旧对话时，会给出荒谬的“0.1%”假数据。

**DeepBrim 彻底改变了这一切。** 它不是一个简单的字数统计器，而是通过拦截底层网络协议（Hook Fetch/XHR），直接获取官方落库的**绝对真值**。

## ✨ 核心特性

- 🎯 **拒绝估算，底层直出**：抓取 SSE 流式数据与全量历史包，拿的是官方最真实的 Token 账单。
- ⏳ **完美历史回溯**：打开几个月前的老对话，也能瞬间拉取全量数据，算出真实的累计消耗。
- 🧩 **精准消耗拆分**：不仅能看总计，还能精准剥离出“本轮对话”和“附件”到底消耗了多少 Token。
- 🛡️ **极简无感，绝对安全**：没有弹窗，没有后台请求。权限仅申请 `storage`，所有数据均存在浏览器本地，绝不收集任何隐私。
- 📉 **诚实的降级策略**：遇到官方接口波动拿不到真值时，它宁可标注估算值（带 `~` 号），也绝不伪装成精确数据。

## 📸 界面预览

<p align="center">
  <img src="你的截图1地址" width="45%" alt="长文分析预警" />
  <img src="你的截图2地址" width="45%" alt="官方真值面板" />
</p>

## 🚀 安装方式

### 方式一：应用商店（推荐）
目前插件已在 Microsoft Edge 加载项商店提交审核，审核通过后可在商店搜索 **DeepBrim** 直接安装。
*(待审核通过后更新商店链接)*

### 方式二：开发者模式加载
1. 下载本仓库的 ZIP 压缩包并解压，或克隆本仓库：
   `git clone https://github.com/MCharlieDev/DeepBrim.git`
2. 打开 Edge 浏览器，在地址栏输入 `edge://extensions/`（Chrome 为 `chrome://extensions/`）。
3. 开启右上角的**“开发人员模式”**。
4. 点击**“加载解压缩的扩展”**，选择刚才解压的 `DeepBrim` 文件夹即可。

## 🛠️ 技术架构解析 (For Developers)

为了实现极致的准确率和稳定性，DeepBrim 在底层做了大量极其克制的防御机制：
1. **双世界隔离**：UI 渲染在 `Shadow DOM` (Isolated World) 中，与页面完全隔离；网络拦截在 `MAIN World`。
2. **缓存穿透**：自动剔除 `cache_version` 并附加时间戳，强制服务端返回全量历史包（`history_messages`），破解官方的 `MERGE` 增量缓存限制。
3. **三段式超时**：全量请求采用 TTFB、Idle、Total 三阶段超时控制，完美解决弱网大包下载被误杀、或空对话请求服务端挂起的问题。
4. **被动主动抢断**：一旦页面自身请求拿到了完整数据，立刻 `abort` 插件发出的全量请求，极致节省带宽。

## 🔧 开发者调试模式
如果你在使用的过程中发现数字不再跳动，可以在“设置 -> 基础”中勾选 **“开启底层调试日志 (DEBUG)”**，然后在浏览器控制台（F12）查看详细的底层拦截日志，方便反馈 Bug。

## 📄 开源协议
本项目基于 [MIT License](LICENSE) 协议开源。欢迎提交 Issue 或 Pull Request。

---
*如果这个小工具保护了你的长对话，欢迎点一个 ⭐ Star 支持一下！*
