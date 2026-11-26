// 结构化游戏驱动的注册表。目录里的 structured 游戏必须在这里有同 id 的代码，否则跳过。
import * as pvz from './pvz.js';
import * as g2048 from './g2048.js';
import * as sokoban from './sokoban.js';

export const DRIVERS = { pvz, g2048, sokoban };
