import { webSearch } from './web.js';
import { seeImage } from './vision.js';

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description = '') => ({ type: 'string', description });
const num = (description = '') => ({ type: 'number', description });
const split = (v) => (Array.isArray(v) ? v.map(String) : String(v || '').split(/[,，、\s]+/).filter(Boolean));

/**
 * 内置工具：memory_* / note_* / diary_* / dream_* / fact_* / person_* / send_message / web_search。
 * 只注册，不在这里做权限——权限仍由 Gate / send 里的 chat 检查负责。
 *
 * `scope()` 返回**当前会话的 soul 存储**（memory / facts / records / people），
 * 所以换人格以后她写的记忆、事实、日记都落在那个 soul 自己的目录里。
 */
export function registerBuiltins({ tools, kernel, scope, vision = {} }) {
  const store = () => scope() || {};
  // 空间：优先用内核绑定的世界（带注意力/事件），没有再退化成文件版
  const spaceOf = () => {
    const w = kernel.world?.space;
    if (!w) throw new Error('世界还没装配（kernel.world 为空）');
    return w;
  };
  const meOf = () => {
    const turn = kernel.currentTurn;
    if (!turn) throw new Error('现在没有正在进行的一轮');
    return turn.soul || 'vaporeon';
  };
  const defs = [
    ['memory_search', '按线索回忆（会遗忘，重要的事才记得住）', 'read',
      S({ query: str('线索/关键词'), limit: num('最多几条，默认 5') }, ['query']),
      async ({ query, limit } = {}) => ({ results: store().memory.recall(query, { limit: Number(limit) || 5 }) })],

    ['memory_write', '写一条记忆（重要性 0-1；寒暄 0.3、一般 0.5、约定 0.7、重要 0.85+；core=true 表示核心记忆、几乎不会忘）', 'write',
      S({ text: str('发生了什么'), keywords: str('关键词，逗号分隔'), salience: num('重要性 0-1'), core: { type: 'boolean', description: '是否核心记忆' } }, ['text']),
      async ({ text, keywords, salience, core } = {}) => store().memory.write({ text, keywords: split(keywords), salience: Number(salience) || 0.5, core: core === true })],

    ['note_add', '记一条笔记（长期保留，回忆时不自动带出）', 'write',
      S({ text: str('笔记正文'), tags: str('标签，逗号分隔') }, ['text']),
      async ({ text, tags } = {}) => store().records.noteAdd(text, { tags: split(tags) })],

    ['note_search', '按关键词查笔记', 'read',
      S({ query: str('关键词'), limit: num('最多几条，默认 5') }, ['query']),
      async ({ query, limit } = {}) => ({ results: store().records.noteSearch(query, { limit: Number(limit) || 5 }) })],

    ['diary_write', '写今天的日记。用第一人称写「我」的想法和感受，像真的在写字（不要写格式、不要列条目、不要写「心情从A变成B」这种日志腔）', 'write',
      S({ text: str('日记正文，第一人称，可分段'), title: str('这一条的小标题，如「等了好久」「有点不痛快」'), date: str('YYYY-MM-DD，可空（默认今天）') }, ['text']),
      async ({ text, title, date } = {}) => store().records.diaryWrite(text, { date: date || undefined, title: title || '' })],

    ['diary_read', '读日记（不给日期就读最近几篇）', 'read',
      S({ date: str('YYYY-MM-DD，可空'), limit: num('最多几篇，默认 3') }, []),
      async ({ date, limit } = {}) => ({ entries: store().records.diaryRead({ date, limit: Number(limit) || 3 }) })],

    ['dream_write', '记一个梦', 'write',
      S({ text: str('梦的内容') }, ['text']),
      async ({ text } = {}) => store().records.dreamWrite(text)],

    ['dream_recall', '回忆做过的梦（不传关键词按最近）', 'read',
      S({ query: str('关键词，可空'), limit: num('最多几段，默认 5') }, []),
      async ({ query, limit } = {}) => ({ dreams: store().records.dreamRecall(query || '', { limit: Number(limit) || 5 }) })],

    ['fact_add', '写一条客观事实（不遗忘、可检索）', 'write',
      S({ title: str('一句话标题'), content: str('事实正文'), keywords: str('关键词，逗号分隔'), source: str('来源') }, ['content']),
      async ({ title, content, keywords, source } = {}) => store().facts.add({ title, content, keywords: split(keywords), source })],

    ['fact_search', '查客观事实', 'read',
      S({ query: str('关键词'), limit: num('最多几条，默认 4') }, ['query']),
      async ({ query, limit } = {}) => ({ results: store().facts.search(query, { limit: Number(limit) || 4 }) })],

    ['person_recent', '看最近和某人聊了什么（默认主人）', 'read',
      S({ person: str('人 ID，如 owner / group:123，可空'), limit: num('最多几条，默认 10') }, []),
      async ({ person, limit } = {}) => ({ person: person || 'owner', lines: store().people.historyLines(person || 'owner', Number(limit) || 10) })],

['sticker_react', '发一个表情包表达情绪（挑一个 emotion：happy/sad/angry/worried/…）', 'write',
      S({ emotion: str('情绪名，例如 happy / sad / angry / worried / stunned / sigh') }, ['emotion']),
      async ({ emotion } = {}) => {
        const turn = kernel.currentTurn;
        if (!turn) throw new Error('现在没有正在进行的一轮');
        const rt = kernel.stores(turn.soul);
        const stickers = rt?.stickers;
        if (!stickers) throw new Error('这个人格没有表情包目录');
        const e = String(emotion || '').trim().toLowerCase();
        if (!stickers.has(turn.soul, e)) {
          throw new Error('没有这个表情：' + (e || '(空)') + '；可用：' + stickers.list(turn.soul).join(', '));
        }
        if ((turn.stickers || []).length >= 2) throw new Error('这一轮已经发了 2 个表情，够了');
        const item = { emotion: e, url: '/sticker/' + encodeURIComponent(turn.soul || 'vaporeon') + '/' + e + '.png' };
        turn.stickers.push(item);
        turn.event('sticker', item);
        return item;
      }],

// ── 感官 / 身体（空间是唯一权威：看见的、走到的、说的话都落在 state/space.json）──
    ['look', '看看你现在在哪、旁边有谁、他们各自在干什么（真实处境，不要脑补）', 'read',
      S({}, []),
      async () => {
        const p = spaceOf().perceive(meOf());
        return {
          room: p.roomName,
          doing: p.doing,
          nearby: (p.neighbors || []).map((x) => x.name + '（' + (x.doing || '') + '）'),
          time: p.time.part + ' ' + p.time.hm,
          note: '这就是你此刻真实的位置和处境。',
        };
      }],

    ['listen', '听听房间里最近说了什么（不传 limit 就听 5 句）', 'read',
      S({ limit: num('最多几句，默认 5') }, []),
      async ({ limit } = {}) => {
        const p = spaceOf().perceive(meOf());
        const talk = spaceOf().recentTalk('living', Number(limit) || 5);
        return { room: p.roomName, heard: talk.length ? talk.map((t) => t.name + '：' + t.text) : ['（这边很安静）'] };
      }],

    ['walk_to', '走到另一个房间（卧室/厨房/阳台/餐厅/书房/卫生间/次卧/客厅）。换地方一定要用这个，别只是在话里说', 'write',
      S({ room: str('要去哪：卧室 / 书房 / 阳台 / 客厅 …') }, ['room']),
async ({ room } = {}) => {
        const me = meOf();
        const env = spaceOf().env;
        const here = env.positionOf(me);
        const target = env.resolveRoom ? env.resolveRoom(room) : null;
        if (target && here.room === target.id && !here.walking) {
          return { ok: true, already: true, room: target.id, roomName: target.name, note: '你已经在' + target.name + '了。' };
        }
        return spaceOf().moveTo(me, room, { doing: '走过去' });
      }],

    ['say_to', '在房间里说一句话（to 填名字就是单独对她说）', 'write',
      S({ text: str('要说的话'), to: str('对谁说，可空（空 = 对房间里所有人）') }, ['text']),
      async ({ text, to } = {}) => {
        const me = meOf();
        // 空间里说话：带位置和半径，附近的灵魂会听见（事件 + 注意力都会处理）
        const target = String(to || '').trim();
        return spaceOf().speak({ from: me, text, radius: target ? 120 : 280, to: target || null });
      }],

    ['send_message', '跨通道说一句（目标通道要有 chat 权限）', 'write',
      S({ target: str('目标通道，如 private:123 / group:456'), text: str('要说的话') }, ['target', 'text']),
      async ({ target, text } = {}) => {
        const r = await kernel.send(target, text);
        if (!r.ok) throw new Error(r.error);
        return r;
      }],

    ['web_search', '联网搜索（不需要密钥）', 'read',
      S({ query: str('搜索词'), limit: num('最多几条，默认 5') }, ['query']),
      async ({ query, limit } = {}) => {
        const r = await webSearch(query, { limit: Number(limit) || 5 });
        if (!r.ok) throw new Error(r.error);
        return r.data;
      }],

    ['see_image', '看一张图（默认看本轮/最近一张附件）', 'read',
      S({ url: str('图片 URL 或 /media/…'), file: str('本地文件名'), dataUrl: str('data:image/…;base64,…'), prompt: str('想问什么') }, []),
      async (args = {}) => {
        const r = await seeImage(args, { config: vision, root: kernel.root, lastMedia: kernel.lastMedia || [] });
        if (!r.ok) throw new Error(r.error);
        return r.data;
      }],

    ['send_sticker', '发一个收藏表情（需要通道支持；网页不支持）', 'write',
      S({ target: str('目标通道，如 group:123'), sticker: str('表情 id/文件名/URL') }, ['sticker']),
      async ({ target, sticker } = {}) => {
        const r = await kernel.sendSticker(target, sticker);
        if (!r.ok) throw new Error(r.error);
        return r;
      }],
  ];

  // 会把参数发到外网的工具（external 只作标记，调试页会标出来）
  const EXTERNAL = new Set(['web_search', 'see_image']);
  for (const [name, description, kind, schema, fn] of defs) {
    tools.register({ name, description, kind, schema, fn, external: EXTERNAL.has(name) });
  }
  return defs.length;
}
