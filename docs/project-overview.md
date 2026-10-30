# Entropy Maze - 项目总览

> **v2 重构已完成（几何 + 物理）**：迷宫改为随机完美迷宫（生成树，零闭环）+ 薄墙 + 通道中心线网络；
> 能量块改为圆形质点模型；热力学改用严格有限体㶲模型。
> 本文下方"开发计划 / 文件状态"为 v1 阶段的历史记录，最新实现请以
> [技术开发文档 v2](technical-doc.md) 与 [物理模型说明 v2](physics-model.md) 为准。

## 项目状态

**项目名称**: Entropy Maze - 热力学熵过程模拟游戏  
**创建日期**: 2026-10-25  
**当前版本**: v2.0.0（几何与物理重构完成）  
**v1.0.0**: 已归档（见 completion-report.md）

---

## 文档索引

### 核心文档

| 文档名称 | 说明 | 链接 |
|---------|------|------|
| **技术开发文档** | 详细的技术实现方案、架构设计、数据结构 | [technical-doc.md](docs/technical-doc.md) |
| **物理模型说明** | 热力学物理模型详解、计算公式、代码实现 | [physics-model.md](docs/physics-model.md) |
| **使用说明** | 游戏操作指南、规则说明、常见问题 | [user-guide.md](docs/user-guide.md) |
| **项目README** | 项目简介、快速开始、项目结构 | [README.md](../README.md) |

---

## 项目结构

```
entropy-maze-game/
│
├── index.html              # 主页面（待创建）
│
├── css/
│   ├── style.css          # 主样式（待创建）
│   └── game.css           # 游戏样式（待创建）
│
├── js/
│   ├── main.js            # 入口文件（待创建）
│   ├── game.js            # 游戏主逻辑（待创建）
│   ├── maze.js            # 迷宫类（待创建）
│   ├── block.js           # 能量图块类（待创建）
│   ├── physics.js         # 物理引擎（待创建）
│   ├── renderer.js        # 渲染引擎（待创建）
│   ├── input.js           # 输入处理（待创建）
│   └── ui.js              # UI更新（待创建）
│
├── assets/
│   └── images/            # 图片资源（待添加）
│
├── docs/
│   ├── technical-doc.md   # 技术开发文档 ✓
│   ├── physics-model.md   # 物理模型说明 ✓
│   ├── user-guide.md      # 使用说明 ✓
│   └── project-overview.md # 项目总览 ✓
│
└── README.md              # 项目README ✓
```

---

## 开发计划

### 阶段1：基础框架（1-2天）
- [ ] 创建项目结构
- [ ] 实现HTML页面布局
- [ ] 设置Canvas画布
- [ ] 实现基本渲染循环

**相关文件**：
- `index.html`
- `css/style.css`
- `js/main.js`

### 阶段2：核心数据结构（2-3天）
- [ ] 实现EnergyBlock类
- [ ] 实现Maze类
- [ ] 实现GameState类
- [ ] 数据验证和测试

**相关文件**：
- `js/block.js`
- `js/maze.js`
- `js/game.js`

### 阶段3：迷宫生成（2天）
- [ ] 设计固定迷宫布局（类似吃豆人）
- [ ] 实现迷宫渲染
- [ ] 实现碰撞检测

**相关文件**：
- `js/maze.js`
- `js/renderer.js`

### 阶段4：图块生成与分布（2天）
- [ ] 实现随机图块生成算法
- [ ] 实现图块在迷宫中的随机分布
- [ ] 确保初始能量总额固定

**相关文件**：
- `js/block.js`
- `js/game.js`

### 阶段5：拖拽交互（3天）
- [ ] 实现鼠标事件监听
- [ ] 实现图块拖拽逻辑
- [ ] 实现边界和碰撞检测
- [ ] 实现拖拽视觉反馈

**相关文件**：
- `js/input.js`
- `js/renderer.js`

### 阶段6：物理引擎（3-4天）
- [ ] 实现摩擦熵增算法
- [ ] 实现合并传热熵增算法
- [ ] 实现可用能计算
- [ ] 实现温度-灰度映射

**相关文件**：
- `js/physics.js`
- `js/block.js`

### 阶段7：合并逻辑（2天）
- [ ] 实现相邻检测
- [ ] 实现合并条件判断
- [ ] 实现合并动画效果
- [ ] 实现合并后的状态更新

**相关文件**：
- `js/game.js`
- `js/physics.js`
- `js/renderer.js`

### 阶段8：UI与统计（2天）
- [ ] 实现统计面板
- [ ] 实现控制面板
- [ ] 实现实时更新
- [ ] 实现可用能峰值追踪

**相关文件**：
- `js/ui.js`
- `css/game.css`

### 阶段9：优化与测试（2-3天）
- [ ] 性能优化
- [ ] 物理参数调优
- [ ] 边界情况处理
- [ ] 完整测试

### 阶段10：文档与发布（1-2天）
- [ ] 编写使用说明
- [ ] 代码审查
- [ ] 部署到服务器
- [ ] 发布

---

## 核心概念

### 熵 (Entropy)
- 系统无序度的度量
- 公式：S = Q/T
- 游戏中的体现：拖拽和合并都会增加熵

### 可用能 (Exergy)
- 系统能做的最大有用功
- 公式：E = Q × (1 - T₀/T)
- 游戏中的体现：每次操作都会损失可用能

### 传热熵增
- 热量从高温传到低温时熵增加
- 游戏中的体现：合并时因温差导致熵增

### 摩擦熵增
- 摩擦力做功转化为热量，导致熵增
- 游戏中的体现：拖拽时产生摩擦，熵增加

---

## 技术栈

### 前端技术
- **HTML5 Canvas** - 游戏渲染引擎
- **JavaScript (ES6+)** - 主要开发语言
- **CSS3** - 界面样式

### 开发工具
- **VS Code** - 代码编辑器
- **Git** - 版本控制
- **Chrome DevTools** - 调试工具

### 可选增强
- **Phaser.js** - 2D游戏框架（如需更复杂的游戏逻辑）
- **Three.js** - 如需3D可视化效果
- **Web Workers** - 物理计算多线程处理

---

## 关键算法

### 1. 摩擦熵增算法
```javascript
function calculateFrictionEntropy(block, distance, frictionCoeff, backgroundTemp) {
    const gravity = 9.81;
    const frictionForce = frictionCoeff * block.mass * gravity;
    const work = frictionForce * distance;
    const heatGenerated = work;
    const temperatureKelvin = block.temperature + 273.15;
    const entropyIncrease = heatGenerated / temperatureKelvin;
    const tempIncrease = heatGenerated / (block.mass * 1.0);
    const exergyLoss = heatGenerated * (1 - backgroundTemp / temperatureKelvin);
    
    return {
        entropyIncrease,
        tempIncrease,
        exergyLoss
    };
}
```

### 2. 合并传热熵增算法
```javascript
function calculateMergeEntropy(block1, block2, backgroundTemp) {
    const specificHeat = 1.0;
    const T1 = block1.temperature + 273.15;
    const T2 = block2.temperature + 273.15;
    const totalMass = block1.mass + block2.mass;
    const T_final = (block1.mass * T1 + block2.mass * T2) / totalMass;
    
    const deltaS1 = block1.mass * specificHeat * Math.log(T_final / T1);
    const deltaS2 = block2.mass * specificHeat * Math.log(T_final / T2);
    const totalEntropyChange = deltaS1 + deltaS2;
    
    const T0_kelvin = backgroundTemp + 273.15;
    const exergyLoss = T0_kelvin * totalEntropyChange;
    
    return {
        finalTemperature: T_final - 273.15,
        entropyChange: totalEntropyChange,
        exergyLoss,
        newMass: totalMass
    };
}
```

### 3. 可用能计算
```javascript
function calculateExergy(block, backgroundTemp) {
    const T_kelvin = block.temperature + 273.15;
    const T0_kelvin = backgroundTemp + 273.15;
    const Q = block.mass * block.temperature;
    return Q * (1 - T0_kelvin / T_kelvin);
}
```

---

## 数据结构

### EnergyBlock 类
```javascript
class EnergyBlock {
    constructor(id, x, y, size, temperature) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.size = size;
        this.temperature = temperature;
        this.mass = size * size;
        this.entropy = 0;
        this.exergy = 0;
        this.isMerged = false;
        this.velocity = 0;
    }
}
```

### Maze 类
```javascript
class Maze {
    constructor(rows, cols, cellSize) {
        this.rows = rows;
        this.cols = cols;
        this.cellSize = cellSize;
        this.grid = [];
        this.walls = [];
        this.blocks = [];
    }
}
```

### GameState 类
```javascript
class GameState {
    constructor() {
        this.totalEnergy = 0;
        this.totalExergy = 0;
        this.maxExergy = 0;
        this.totalEntropy = 0;
        this.blockCount = 0;
        this.backgroundTemp = 20;
        this.frictionCoeff = 0.1;
        this.moveCount = 0;
        this.mergeCount = 0;
        this.gameStatus = 'ready';
    }
}
```

---

## 配置参数

### 默认配置
```javascript
const GAME_CONFIG = {
    // 迷宫配置
    mazeRows: 20,
    mazeCols: 25,
    cellSize: 30,
    
    // 图块配置
    blockCount: 15,
    minBlockSize: 1,
    maxBlockSize: 3,
    
    // 温度配置
    minTemperature: 0,
    maxTemperature: 300,
    backgroundTemperature: 20,
    
    // 物理参数
    frictionCoefficient: 0.15,
    specificHeat: 1.0,
    
    // 能量配置
    totalEnergy: 10000,
};
```

---

## 测试计划

### 单元测试
- [ ] 物理计算函数测试
- [ ] 碰撞检测测试
- [ ] 数据模型测试

### 集成测试
- [ ] 拖拽交互测试
- [ ] 合并逻辑测试
- [ ] 统计数据测试

### 性能测试
- [ ] 大量图块渲染性能
- [ ] 物理计算性能
- [ ] 内存占用测试

### 用户体验测试
- [ ] 操作流畅性
- [ ] 视觉效果
- [ ] 游戏平衡性

---

## 部署方案

### 静态部署（推荐）
- **GitHub Pages** - 免费托管
- **Netlify** - 免费托管，支持CI/CD
- **Vercel** - 免费托管，快速部署

### 服务器部署
- **Node.js + Express** - 自建服务器
- **Nginx** - 静态文件服务

---

## 扩展功能

### 高级功能（可选）
- [ ] 多种迷宫布局选择
- [ ] 自定义图块参数
- [ ] 物理参数调节面板
- [ ] 游戏回放功能
- [ ] 排行榜系统

### 教学功能（可选）
- [ ] 热力学知识提示
- [ ] 操作引导教程
- [ ] 熵增过程可视化
- [ ] 可用能变化曲线图

### 社交功能（可选）
- [ ] 分享游戏成绩
- [ ] 挑战好友最高分
- [ ] 观看好友回放

---

## 参考资料

### 热力学
- 《工程热力学》- 可用能理论
- 热力学第二定律
- 熵增原理

### 游戏开发
- HTML5 Canvas游戏开发
- 2D物理引擎实现
- 碰撞检测算法

### 在线资源
- [MDN Canvas API](https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API)
- [Phaser.js](https://phaser.io/)
- [热力学基础](https://zh.wikipedia.org/wiki/热力学)

---

## 团队与贡献

### 作者
- AI Assistant

### 贡献者
- 欢迎贡献代码！

---

## 更新日志

### 2026-10-25
- ✓ 完成技术开发文档
- ✓ 完成物理模型说明
- ✓ 完成使用说明
- ✓ 完成项目总览
- ✓ 创建项目结构

### 待完成
- [ ] 实现核心代码
- [ ] 完成测试
- [ ] 发布v1.0.0

---

## 许可证

MIT License

---

**文档版本**: v1.0  
**创建日期**: 2026-10-25  
**最后更新**: 2026-10-25
