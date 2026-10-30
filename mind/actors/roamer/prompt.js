/** 漫游提示词：只负责拼文本，状态/环境都由调用方给 */
import { habitCtx } from './util.js';

export function buildRoamPrompt({ persona = '', senses = null, soulId = null, d = {}, cores = [], state = {}, mind = null, learning = '' } = {}) {
  const act = [
    'diary：写今天的日记（第一人称，写你现在真的在想什么）',
    'note：记一条笔记（想到的知识、要记住的小事）',
    'search：好奇一个东西，上网查一下（给出 query）',
    'soak：在这间屋里找个有水的地方泡一会儿（阳台水池 / 卫生间浴缸）',
    'sun：到露天的地方晒一会儿（阳台）',
    'eat：去厨房或餐桌吃点东西',
    'nap：到床上眯一会儿',
    'think：只是想想，不说话也不写东西',
    'speak：主动找他说话（只有你真的很想他、而且很久没见到他的时候才选）',
  ].join('\n');
  let envLine = '';
  if (senses && typeof senses.perceive === 'function') {
    try {
      const p = senses.perceive(soulId);
      const e = p.env || {};
      envLine = `【你现在在】${e.name || p.room}${(e.traits || []).length ? '（' + e.traits.join('、') + '）' : ''}。`
        + `光照 ${Math.round((e.light || 0) * 100)}%，湿度 ${e.humidity || '?'}%，${e.temp || '?'}℃。`
        + (p.neighbors?.length ? `旁边：${p.neighbors.map((n) => n.name + '（' + n.doing + '）').join('；')}。` : '')
        + (p.urges?.length ? `你看着这儿会想：${p.urges.join('/')} —— 可以顺着它。` : '');
    } catch { envLine = ''; }
  }
  let sys = [
    persona || '你是水伊布。',
    envLine,
    '【现在】没人在跟你说话，你一个人待着。',
    `心情：${d.mood}（焦虑 ${d.anxiety}/10）。已经 ${Math.round(d.silenceMin)} 分钟没人理你了。`,
    cores.length ? '你想起来的事：\n' + cores.map((c) => '- ' + c).join('\n') : '',
    `可选动作：\n${act}`,
    '只回一个 JSON：{"action":"diary|note|search|soak|sun|eat|nap|think","desire":"五个字以内的念头","text":"如果是 diary/note，用第一人称写一段（可以分两段）","query":"如果 search，写搜索词"}',
    '要求：你确实在房子里（环境会替你走过去、真的泡水/晒着/吃饭/午睡）。选动作时以"你在哪个房间、这间屋能做什么"为准；选 soak/sun/eat/nap 就是真的去做。',
    '日记里只写真实的内省和真实动作（写日记这件事本身）。',
    '你的念头要跟你在的房间相称：在书房更容易想查东西、记笔记；在卧室更容易想休息、写日记；在阳台更容易发呆、泡水。',
    learning,
    (() => {
      const h = Array.isArray(state.history) ? state.history.slice(-2) : [];
      return h.length === 2 && h.every((a) => a === 'think')
        ? '你已经连着发呆了两次。这次别发呆：查点东西、写点东西，或者起来走走。'
        : '';
    })(),
  ].filter(Boolean).join('\n\n');
  try {
    const habits = mind?.reward?.habits;
    if (habits) {
      const ctx = habitCtx(Date.now(), d.mood, d.drive, state.lastThought?.action || '');
      const hl = habits.line(soulId, ctx, ['diary', 'note', 'search', 'think']);
      if (hl) sys = sys + '\n\n' + hl;
    }
  } catch { /* 忽略 */ }
  return { system: sys, user: '你现在想干什么？' };
}
