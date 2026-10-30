/**
 * 灵魂端口（B3.5）
 *
 * 世界这一侧（漫游、自动闲聊）只认这个接口，不认具体 Kernel 类。
 * 只暴露"想事情 + 记会话 + 用工具"这几件事。
 */
export function createMindPort(kernel) {
  return {
    runTurn: (...args) => kernel.runTurn(...args),
    sessions: kernel.sessions,
    tools: kernel.tools,
    brain: kernel.brain,
    brainChoice: kernel.brainChoice,
    gate: kernel.pipeline?.gate || null,
    souls: kernel.souls,
  };
}
