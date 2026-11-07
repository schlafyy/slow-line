'use strict';

const API = 'https://en.wikipedia.org/w/api.php';
const TARGET_WORDS = 1150; // five minutes at 230 words a minute
const WPM = 230;

// Each topic is a line. Members of these WikiProject assessment categories are Talk: pages.
const LINES = {
  H: { name: 'History', cats: ['FA-Class history articles', 'GA-Class history articles', 'FA-Class military history articles', 'GA-Class military history articles'] },
  J: { name: 'Japan', cats: ['FA-Class Japanese military history articles', 'GA-Class Japanese military history articles', 'FA-Class Japan-related articles'] },
  S: { name: 'Science', cats: ['FA-Class physics articles', 'GA-Class physics articles', 'FA-Class Astronomy articles', 'GA-Class Astronomy articles', 'FA-Class Chemistry articles'] },
  C: { name: 'Cars', cats: ['FA-Class Automobile articles', 'GA-Class Automobile articles', 'FA-Class motorsport articles', 'GA-Class motorsport articles', 'FA-Class Formula One articles', 'GA-Class Formula One articles'] },
};

const END_SECTIONS = /^(see also|notes|references|footnotes|citations|sources|bibliography|further reading|external links|works cited|notes and references|explanatory notes|cited sources|general and cited sources|primary sources|secondary sources)$/i;

// ---------- chapters (pure, tested in test.js) ----------

// blocks: [{h: level, text}] headings and [{html, w}] content. Cuts at a heading once a chapter has
// most of its five minutes, mid-section only when a section runs far past it.
function splitChapters(blocks, target = TARGET_WORDS) {
  const groups = [];
  let cur = [], words = 0;
  for (const b of blocks) {
    if (cur.length && words >= target * (b.h ? 0.75 : 1.4)) { groups.push(cur); cur = []; words = 0; }
    cur.push(b);
    words += b.w || 0;
  }
  if (cur.length) {
    if (groups.length && words < target * 0.4) groups[groups.length - 1].push(...cur);
    else groups.push(cur);
  }
  let heading = null;
  return groups.map(g => {
    const label = g[0].h ? g[0].text : heading ? heading + ' (continued)' : 'Opening';
    for (const b of g) if (b.h) heading = b.text;
    return { label, blocks: g, words: g.reduce((n, b) => n + (b.w || 0), 0) };
  });
}

if (typeof module !== 'undefined') { module.exports = { splitChapters }; }
else boot();

// ---------- everything below runs in the browser ----------

function boot() {
  const MATHML = 'http://www.w3.org/1998/Math/MathML';
  const MATH_TAGS = new Set('math semantics mrow mi mo mn ms msup msub msubsup mfrac msqrt mroot mtext mspace mover munder munderover mtable mtr mtd mstyle mpadded mphantom menclose mfenced'.split(' '));
  const KEEP = { I: 'i', B: 'b', EM: 'em', STRONG: 'strong', SUB: 'sub', SUP: 'sup', BR: 'br', Q: 'q', CITE: 'cite', ABBR: 'abbr', SMALL: 'small', VAR: 'var', P: 'p', UL: 'ul', OL: 'ol', LI: 'li', DD: 'p', DT: 'p' };
  const DROP = 'style, script, link, meta, img, figure, table, .reference, .mw-ref, .noprint, .mw-editsection, .mwe-math-fallback-image-inline, .mwe-math-fallback-image-display, annotation, annotation-xml, .error, .sortkey, .mw-empty-elt';
  const BLOCK = { P: 'p', UL: 'ul', OL: 'ol', BLOCKQUOTE: 'blockquote', DL: 'div' };

  // Wikipedia HTML is untrusted: rebuild it from allowlisted tags with no attributes, unwrapping the rest.
  function clean(src) {
    const frag = document.createDocumentFragment();
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { frag.append(n.data.normalize('NFC')); continue; } // NFC: accents attach even when a fallback font draws them
      if (n.nodeType !== 1 || n.matches(DROP)) continue;
      let el = null;
      if (n.namespaceURI === MATHML) {
        if (!MATH_TAGS.has(n.localName)) continue;
        el = document.createElementNS(MATHML, n.localName);
        if (n.localName === 'math' && n.getAttribute('display') === 'block') el.setAttribute('display', 'block');
      } else if (KEEP[n.tagName]) {
        el = document.createElement(KEEP[n.tagName]);
      }
      if (el) { el.append(clean(n)); frag.append(el); }
      else frag.append(clean(n));
    }
    return frag;
  }

  function toBlocks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('.mw-parser-output') || doc.body;
    const blocks = [];
    for (const n of root.children) {
      const h = n.matches('.mw-heading') ? n.querySelector('h2, h3, h4') : n.matches('h2, h3, h4') ? n : null;
      if (h) {
        blocks.push({ h: +h.localName[1], text: h.textContent.trim().normalize('NFC') });
        continue;
      }
      const tag = BLOCK[n.tagName];
      if (!tag || n.matches(DROP)) continue;
      const el = document.createElement(tag);
      if (tag === 'div') el.className = 'indent';
      el.append(clean(n));
      const text = el.textContent.trim();
      if (!text) continue;
      blocks.push({ html: el.outerHTML, w: text.split(/\s+/).length });
    }
    // cut the trailing run of See also / Notes / References; an early "Sources" section in an ancient-history article stays
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].h !== 2) continue;
      if (!END_SECTIONS.test(blocks[i].text)) break;
      blocks.length = i;
    }
    // drop headings with nothing under them (sections that were only tables or images)
    return blocks.filter((b, i) => {
      if (!b.h) return true;
      const next = blocks[i + 1];
      return next && !(next.h && next.h <= b.h);
    });
  }

  // ---------- Wikipedia, paced ----------

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let queue = Promise.resolve();
  // Wikipedia answers 429 to bursts: one request at a time, 400 ms apart.
  function wiki(params) {
    const run = queue.then(async () => {
      const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
      const res = await fetch(url, { headers: { 'Api-User-Agent': 'SlowLine/0.1 (personal reading app)' } });
      if (!res.ok) throw new Error('Wikipedia answered ' + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error.info);
      return data;
    });
    queue = run.catch(() => {}).then(() => sleep(400));
    return run;
  }

  async function pickTitle(code) {
    const cats = LINES[code].cats;
    for (let i = 0; i < 4; i++) {
      const cat = cats[Math.floor(Math.random() * cats.length)];
      // shortcut: a random starting letter, not a uniform pick over the whole category; fine for reading, upgrade if repeats get noticeable
      const prefix = String.fromCharCode(65 + Math.floor(Math.random() * 26));
      const d = await wiki({ action: 'query', list: 'categorymembers', cmtitle: 'Category:' + cat, cmnamespace: '1', cmlimit: '50', cmstartsortkeyprefix: prefix });
      const titles = d.query.categorymembers.map(m => m.title.replace(/^Talk:/, '')).filter(t => !state.seen.includes(t));
      if (titles.length) return titles[Math.floor(Math.random() * titles.length)];
    }
    throw new Error('No article found on this line.');
  }

  async function newArticle(code) {
    for (let i = 0; i < 3; i++) {
      const title = await pickTitle(code);
      seen(title);
      const d = await wiki({ action: 'parse', page: title, prop: 'text|revid', redirects: '1', disableeditsection: '1', disabletoc: '1' });
      const chapters = splitChapters(toBlocks(d.parse.text));
      if (chapters.reduce((n, c) => n + c.words, 0) < 600) continue; // under ~3 minutes is a post, not a chapter
      const a = { title: d.parse.title, revid: d.parse.revid, chapters };
      seen(a.title);
      putArticle(a);
      return a.title;
    }
    throw new Error('Wikipedia sent only short articles. Try again.');
  }

  // ---------- state ----------

  const KEY = 'slowline';
  const mem = new Map(); // articles stay readable this session even if storage is full
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch { state = null; }
  state = state || { line: 'H', lines: {}, seen: [] };

  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
  function seen(t) { if (!state.seen.includes(t)) state.seen.push(t); if (state.seen.length > 3000) state.seen.splice(0, 500); }
  function article(t) {
    if (!t) return null;
    if (!mem.has(t)) { try { const a = JSON.parse(localStorage.getItem('a:' + t)); if (a) mem.set(t, a); } catch {} }
    return mem.get(t) || null;
  }
  function putArticle(a) { mem.set(a.title, a); try { localStorage.setItem('a:' + a.title, JSON.stringify(a)); } catch {} }
  function dropArticle(t) { mem.delete(t); try { localStorage.removeItem('a:' + t); } catch {} }
  function line(code) { return (state.lines[code] ||= { no: 1, title: null, ch: 0, next: null, y: 0 }); }

  // forget stored articles no line points at any more
  try {
    const keep = new Set(Object.values(state.lines).flatMap(l => [l.title, l.next]));
    for (const k of Object.keys(localStorage)) if (k.startsWith('a:') && !keep.has(k.slice(2))) localStorage.removeItem(k);
  } catch {}

  // ---------- rendering ----------

  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = n => String(n).padStart(2, '0');
  const mins = w => Math.max(1, Math.round(w / WPM));
  const arrow = dir => `<svg class="arrow" viewBox="0 0 10 12" aria-hidden="true"><path d="${dir === 'left' ? 'M10 0v12L0 6z' : 'M0 0v12l10-6z'}"/></svg>`;
  const badge = (code, no, cls = '') => `<span class="badge ${cls}" aria-hidden="true"><span class="badge-line">${code}</span><span class="badge-no">${no}</span></span>`;

  function paintChips() {
    document.body.dataset.line = state.line;
    $('#chips').innerHTML = Object.entries(LINES).map(([c, l]) =>
      `<button class="chip" data-act="line" data-code="${c}" aria-label="${l.name} line" ${c === state.line ? 'aria-current="true"' : ''}>${c}</button>`).join('');
  }

  // the station name: the chapter's section, or the article title for its opening chapter
  const station = (a, i) => i === 0 ? a.title : a.chapters[i].label;
  const transfers = (code, savedOnly) => Object.entries(LINES)
    .filter(([c]) => c !== code && (!savedOnly || article(state.lines[c]?.title)))
    .map(([c, l]) => `<button class="transfer-chip" data-act="line" data-code="${c}" data-line="${c}">${badge(c, pad(state.lines[c]?.no || 1))}<span>${l.name}</span></button>`).join('');

  function paintStatus(code, title, sub, problem) {
    $('#sign-face').innerHTML = `${badge(code, '··')}<div class="sign-name"><h1>${esc(title)}</h1><p class="sign-sub">${esc(sub)}</p></div>`;
    $('#band').innerHTML = `<span class="band-prev">${arrow('left')}<span>${LINES[code].name} line</span></span>`;
    $('#fine').innerHTML = '';
    $('#text').innerHTML = problem ? `<p class="status">${esc(problem)}</p>` : '';
    const saved = problem ? transfers(code, true) : '';
    $('#arrive').innerHTML = !problem ? '' : `
      <button class="next-sign" data-act="retry"><span class="next-band"><span>Try again</span>${arrow('right')}</span></button>
      ${saved ? `<h2 class="transfer-title">Lines with chapters saved</h2><div class="transfer">${saved}</div>` : ''}`;
  }

  function paint(code, arriving) {
    const ln = line(code), a = article(ln.title), ch = a.chapters[ln.ch];
    const last = ln.ch + 1 >= a.chapters.length;
    const name = station(a, ln.ch);
    const prev = ln.ch > 0 ? station(a, ln.ch - 1) : null;
    const nextA = article(ln.next);
    const nextName = !last ? station(a, ln.ch + 1) : nextA ? nextA.title : 'Next article';
    const src = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(a.title)}&oldid=${a.revid}`;

    document.title = `${name} · Slow Line`;
    const sign = $('#sign');
    sign.classList.remove('arriving');
    if (arriving && !matchMedia('(prefers-reduced-motion: reduce)').matches) { void sign.offsetWidth; sign.classList.add('arriving'); }

    $('#sign-face').innerHTML = `${badge(code, pad(ln.no))}<div class="sign-name"><h1>${esc(name)}</h1><p class="sign-sub">${esc(ln.ch === 0 ? 'Opening' : a.title)}</p></div>`;
    $('#band').innerHTML =
      `<button class="band-prev" data-act="prev" ${prev ? '' : 'disabled'}>${arrow('left')}${prev ? badge(code, pad(ln.no - 1), 'mini') : ''}<span>${esc(prev || LINES[code].name + ' line')}</span></button>` +
      `<button class="band-next" data-act="next"><span>${esc(nextName)}</span>${badge(code, pad(ln.no + 1), 'mini')}${arrow('right')}</button>`;
    $('#fine').innerHTML =
      `Part ${ln.ch + 1} of ${a.chapters.length} · ${mins(ch.words)} min · From Wikipedia’s “<a href="${src}" target="_blank" rel="noopener">${esc(a.title)}</a>”, ` +
      `<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>`;
    // the sign already names the section, so don't repeat it as the column's first heading
    const blocks = ch.blocks[0].h && ch.blocks[0].text === name ? ch.blocks.slice(1) : ch.blocks;
    $('#text').innerHTML = blocks.map(b => b.h ? `<h${b.h}>${esc(b.text)}</h${b.h}>` : b.html).join('');
    paintArrive(code);
  }

  function paintArrive(code) {
    const ln = line(code), a = article(ln.title);
    if (!a) return;
    const last = ln.ch + 1 >= a.chapters.length, nextA = article(ln.next);
    const first = ln.no - ln.ch, done = a.chapters.length > 1 ? ln.ch / (a.chapters.length - 1) * 100 : 0;
    const diagram = a.chapters.map((c, i) => `<li class="${i < ln.ch ? 'past' : i === ln.ch ? 'here' : ''}"><span>${pad(first + i)}</span></li>`).join('');
    let name, band, ready = true;
    if (!last) { name = station(a, ln.ch + 1); band = `Keep reading · ${mins(a.chapters[ln.ch + 1].words)} min`; }
    else if (nextA) { name = nextA.title; band = `New article · ${mins(nextA.chapters[0].words)} min`; }
    else { ready = !busy[code]; name = ready ? 'Next article' : 'Finding the next article…'; band = `New article on the ${LINES[code].name} line`; }
    $('#arrive').innerHTML = `
      <p class="here-note">You are at part ${ln.ch + 1} of ${a.chapters.length}</p>
      <ol class="diagram" style="--done: ${done}%" aria-hidden="true">${diagram}</ol>
      <button class="next-sign" data-act="next" ${ready ? '' : 'aria-disabled="true"'}>
        <span class="next-face">${badge(code, pad(ln.no + 1))}<span class="next-name">${esc(name)}</span></span>
        <span class="next-band"><span>${esc(band)}</span>${arrow('right')}</span>
      </button>
      ${last ? '' : '<button class="quiet" data-act="skip">Leave this article for a new one</button>'}
      <h2 class="transfer-title">Transfer</h2>
      <div class="transfer">${transfers(code, false)}</div>`;
  }

  // ---------- flow ----------

  const busy = {};
  async function prefetch(code) {
    const ln = line(code);
    if (article(ln.next) || busy[code]) return;
    busy[code] = true;
    if (state.line === code && article(ln.title)) paintArrive(code);
    try { ln.next = await newArticle(code); save(); } catch { /* the next tap fetches instead */ }
    busy[code] = false;
    if (state.line === code) paintArrive(code);
  }

  async function show(code, arriving = false) {
    state.line = code;
    save();
    paintChips();
    const ln = line(code);
    if (!article(ln.title)) {
      paintStatus(code, 'Finding an article', `on the ${LINES[code].name} line`);
      try {
        // a prefetched article is already here: take it rather than fetch again
        if (article(ln.next)) { ln.title = ln.next; ln.next = null; }
        else ln.title = await newArticle(code);
        ln.ch = 0; ln.y = 0; save();
      } catch (e) {
        if (state.line === code) paintStatus(code, 'No train from Wikipedia', `on the ${LINES[code].name} line`,
          navigator.onLine === false ? 'You are offline, and this line has nothing saved yet. Connect and try again.' : e.message);
        return;
      }
      if (state.line !== code) return;
    }
    paint(code, arriving);
    scrollTo(0, arriving ? 0 : ln.y || 0);
    prefetch(code);
  }

  function rememberScroll() { if (state.lines[state.line]) { line(state.line).y = Math.round(scrollY); save(); } }

  function move(step) {
    const code = state.line, ln = line(code), a = article(ln.title);
    if (!a) return show(code);
    if (step === 'prev') { if (ln.ch === 0) return; ln.ch--; ln.no--; }
    else if (step === 'next' && ln.ch + 1 < a.chapters.length) { ln.ch++; ln.no++; }
    else { // end of the article, or leaving it: board the next one
      dropArticle(ln.title);
      ln.title = article(ln.next) ? ln.next : null;
      ln.next = null; ln.ch = 0; ln.no++;
    }
    ln.y = 0;
    save();
    show(code, true);
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
    const act = b.dataset.act;
    if (act === 'line') { if (b.dataset.code !== state.line) { rememberScroll(); show(b.dataset.code); } }
    else if (act === 'retry') show(state.line);
    else move(act);
  });
  addEventListener('pagehide', rememberScroll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) rememberScroll(); });
  addEventListener('online', () => { if (state.line) prefetch(state.line); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  show(state.line);
}
