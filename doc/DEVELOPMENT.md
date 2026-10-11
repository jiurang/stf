# STF 开发环境

STF 是把二十多个独立进程（RethinkDB + ZeroMQ + Web）拼起来的群控系统。
好消息是开发时不用管这些——`stf local` 一把全起。

---

## 跑起来

需要 Node ≥ 22.18.0、RethinkDB ≥ 2.2、ADB、GraphicsMagick。

```bash
# 1. 装依赖
npm install

# 2. 编译 lib/ 下的 TypeScript（bin/stf 跑的就是这个产物）
node build.mts compile

# 3. 另开一个终端，起数据库
rethinkdb

# 4. 回项目目录，启动（大雄云控单元会跟着一起起）
npm run local

```
