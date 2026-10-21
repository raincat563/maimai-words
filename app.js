(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const STORE = 'maimai-garden-collections-v2';
  const SELECTION = 'maimai-garden-selected-v2';
  const LATEST = 'maimai-garden-latest-published-v2';
  const CHILDREN = { maimai: '麦麦', xiaoyu: '小屿', damiao: '大喵' };
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-5 4H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
  let published = [], local = [], weeks = [], phonics = {};
  let selected = '', child = 'maimai', activeWord = null, anchor = null, pending = null;
  let toastTimer, importGeneration = 0, speechGeneration = 0, activeUtterance = null, activeAudio = null;
  let audioFiles = {};
  let storageReadable = true;
  const count = week => week.rows.reduce((n, row) => n + row.length, 0);
  const signature = week => JSON.stringify([week.child || 'maimai', week.rows.map(row => row.map(({ en, zh }) => [en, zh]))]);
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const uid = () => 'local-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
  function notice(text) { $('#notice').textContent = text; $('#notice').hidden = !text; }

  function validateData(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.weeks) || !data.weeks.length || data.weeks.length > 100) throw Error('词表备份格式不正确；需要本站导出的词表备份。');
    let total = 0;
    const ids = new Set();
    return data.weeks.map(week => {
      if (!week || typeof week.id !== 'string' || !week.id || week.id.length > 100 || ids.has(week.id) || typeof week.title !== 'string' || !week.title.trim() || week.title.length > 60 || typeof week.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(week.date) || !Array.isArray(week.rows) || !week.rows.length || week.rows.length > 1000) throw Error('词表名称、日期、编号或行数不正确。');
      ids.add(week.id);
      const rows = week.rows.map(row => {
        if (!Array.isArray(row) || !row.length || row.length > 3) throw Error('每行需要 1–3 组英文和中文。');
        return row.map(word => {
          if (!word || typeof word.en !== 'string' || typeof word.zh !== 'string' || !word.en.trim() || !word.zh.trim() || word.en.length > 150 || word.zh.length > 300) throw Error('词表中的英文或中文不完整。');
          if (++total > 8000) throw Error('一次最多支持 8,000 项，请分开备份。');
          return { en: word.en.trim(), zh: word.zh.trim() };
        });
      });
      if (rows.flat().length > 2000) throw Error('每周词表最多支持 2,000 项。');
      const childId = week.child || 'maimai';
      if (!Object.hasOwn(CHILDREN, childId)) throw Error('词表所属孩子不正确。');
      const sectionHeaders = week.sectionHeaders === undefined ? [] : week.sectionHeaders;
      if (!Array.isArray(sectionHeaders) || sectionHeaders.length > 20) throw Error('词汇分类格式不正确。');
      let previousRow = -1;
      sectionHeaders.forEach(section => {
        if (!section || typeof section.title !== 'string' || !section.title.trim() || section.title.length > 30 || !Number.isInteger(section.beforeRow) || section.beforeRow <= previousRow || section.beforeRow >= rows.length) throw Error('词汇分类标题或位置不正确。');
        previousRow = section.beforeRow;
      });
      return { id: week.id, child: childId, title: week.title.trim(), date: week.date, source: typeof week.source === 'string' ? week.source.slice(0, 150) : '', rows, ...(sectionHeaders.length ? { sectionHeaders } : {}) };
    });
  }
  function readLocal() {
    try {
      const saved = localStorage.getItem(STORE);
      if (saved) local = validateData(JSON.parse(saved));
      selected = localStorage.getItem(SELECTION) || '';
    } catch (_) {
      storageReadable = false;
      notice('浏览器中的词表暂时无法读取。网站词表仍可使用；为保护原有数据，暂不覆盖本地记录。可先备份或在普通浏览模式中打开。');
    }
  }
  function rebuild() {
    const known = new Set(published.filter(w => w.child === child).map(signature));
    weeks = [...local.filter(w => w.child === child && !known.has(signature(w))).map(w => ({ ...w, isLocal: true })), ...published.filter(w => w.child === child)];
    weeks.sort((a, b) => b.date.localeCompare(a.date));
    if (!weeks.some(w => w.id === selected)) selected = weeks[0]?.id || '';
    const select = $('#week-select'); select.replaceChildren();
    weeks.forEach(w => { const o = el('option', '', `${w.title} · ${w.date.slice(5).replace('-', '/')} ${w.isLocal ? '（此设备）' : ''}`); o.value = w.id; select.append(o); });
    select.value = selected; select.disabled = !weeks.length; $('#backup').disabled = !weeks.length;
    render();
  }
  function render() {
    clearActiveWord();
    const week = weeks.find(w => w.id === selected), list = $('#word-list');
    list.replaceChildren(); list.setAttribute('aria-busy', 'false');
    if (!week) { $('#word-count').textContent = '— 项'; $('#local-tag').hidden = true; $('#list-date').textContent = ''; list.append(el('p', 'loading', `${CHILDREN[child]}还没有词表，导入第一周的单词吧。`)); return; }
    $('#word-count').textContent = count(week) + ' 项'; $('#local-tag').hidden = !week.isLocal;
    $('#list-date').textContent = week.isLocal ? '仅此浏览器' : '已发布 · ' + week.date.replaceAll('-', '.');
    let i = 0;
    week.rows.forEach((row, rowIndex) => {
      const section = (week.sectionHeaders || []).find(item => item.beforeRow === rowIndex);
      if (section) list.append(el('h3', 'vocab-section-label', section.title));
      const line = el('div', 'word-row'); line.style.setProperty('--columns', row.length);
      row.forEach(word => {
        const button = el('button', 'word-card'); button.type = 'button'; button.dataset.index = i;
        button.setAttribute('aria-label', word.en + '，' + word.zh + '，听英音和拼读');
        button.setAttribute('aria-pressed', 'false');
        const info = el('span', 'word-info'), text = el('span', 'word-text');
        const en = el('span', 'english', word.en); en.lang = 'en';
        text.append(en, el('span', 'chinese', word.zh)); info.append(el('span', 'word-number', String(++i).padStart(2, '0')), text);
        const speaker = el('span', 'speaker'); speaker.setAttribute('aria-hidden', 'true'); speaker.innerHTML = icon;
        button.append(info, speaker); button.onclick = () => playWord(word, button); line.append(button);
      }); list.append(line);
    });
  }
  function clearActiveWord() {
    speechGeneration++; if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (activeAudio) { activeAudio.pause(); activeAudio.currentTime = 0; activeAudio = null; }
    if (anchor) {
      anchor.setAttribute('aria-pressed', 'false'); anchor.classList.remove('speaking');
      anchor.querySelector('.english').textContent = activeWord.en;
    }
    activeWord = null; activeUtterance = null; anchor = null; voiceStatus('');
  }
  function colorWord(node, word, entry) {
    if (!entry) return;
    const groups = (entry.inlineParts || entry.parts).flatMap(part => part.split(/[-\s]+/))
      .map(part => part.replace(/[^a-z]/gi, '')).filter(Boolean);
    // Only project reviewed groups when every letter matches the original spelling.
    if (groups.join('').toLowerCase() !== word.replace(/[^a-z]/gi, '').toLowerCase()) return;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    groups.forEach((group, index) => {
      const separatorStart = offset;
      while (offset < word.length && !/[a-z]/i.test(word[offset])) offset++;
      fragment.append(document.createTextNode(word.slice(separatorStart, offset)));
      const start = offset;
      let letters = 0;
      while (offset < word.length && letters < group.length) {
        if (/[a-z]/i.test(word[offset])) letters++;
        offset++;
      }
      fragment.append(el('span', 'phonics-segment tone-' + index % 3, word.slice(start, offset)));
    });
    fragment.append(document.createTextNode(word.slice(offset)));
    node.replaceChildren(fragment);
  }
  function playWord(word, button) {
    clearActiveWord(); activeWord = word; anchor = button; button.setAttribute('aria-pressed', 'true');
    const key = word.en.toLowerCase().trim();
    colorWord(button.querySelector('.english'), word.en, Object.hasOwn(phonics, key) ? phonics[key] : null);
    speak();
  }
  function speechVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices();
    const british = voices.filter(v => /^en-(?:gb|uk)(?:-|$)/i.test(v.lang.replaceAll('_', '-')))
      .sort((a, b) => Number(b.localService) - Number(a.localService))[0];
    if (british) return { voice: british, isBritish: true };
    const english = voices.filter(v => /^en(?:[-_]|$)/i.test(v.lang))
      .sort((a, b) => Number(b.localService) - Number(a.localService))[0];
    return english ? { voice: english, isBritish: false } : null;
  }
  function waitForSpeechVoice() {
    const current = speechVoice();
    if (current || !('speechSynthesis' in window)) return Promise.resolve(current);
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        speechSynthesis.removeEventListener('voiceschanged', finish);
        resolve(speechVoice());
      };
      const timer = setTimeout(finish, 1800);
      speechSynthesis.addEventListener('voiceschanged', finish);
    });
  }
  function voiceStatus(text) { $('#voice-status').textContent = text; $('#voice-status').hidden = !text; }
  function playAudioFile(path, token) {
    const audio = new Audio('./' + path);
    activeAudio = audio;
    audio.onplay = () => { if (token === speechGeneration) anchor?.classList.add('speaking'); };
    audio.onended = () => { if (token === speechGeneration) { anchor?.classList.remove('speaking'); activeAudio = null; } };
    audio.onerror = () => { if (token === speechGeneration) { anchor?.classList.remove('speaking'); activeAudio = null; voiceStatus('网页英音没有加载成功，请刷新页面后再试。'); } };
    voiceStatus('');
    audio.play().catch(() => { if (token === speechGeneration) { activeAudio = null; voiceStatus('网页英音没有加载成功，请检查网络后再试。'); } });
  }
  async function speak() {
    if (!activeWord) return;
    const token = ++speechGeneration;
    const key = activeWord.en.toLowerCase().trim();
    const currentVoice = speechVoice();
    if (currentVoice?.isBritish) { playWithVoice(currentVoice, token); return; }
    if (audioFiles[key]) { playAudioFile(audioFiles[key], token); return; }
    if (!('speechSynthesis' in window)) { voiceStatus('这个词的英音音频还没有准备好，请联系我更新词表。'); return; }
    speechSynthesis.cancel();
    const selection = await waitForSpeechVoice();
    if (token !== speechGeneration || !activeWord) return;
    if (!selection) { voiceStatus('这个词没有网页英音，设备也没有英语语音；请联系我补充发音。'); return; }
    playWithVoice(selection, token);
  }
  function playWithVoice(selection, token) {
    if (!activeWord) return;
    const entry = Object.hasOwn(phonics, activeWord.en.toLowerCase().trim()) ? phonics[activeWord.en.toLowerCase().trim()] : null;
    const u = new SpeechSynthesisUtterance(entry?.say || activeWord.en);
    activeUtterance = u; u.voice = selection.voice; u.lang = selection.voice.lang || 'en-GB'; u.rate = 1; u.pitch = 1;
    voiceStatus(selection.isBritish ? '' : '正在使用设备提供的英语发音。');
    u.onstart = () => { if (token !== speechGeneration) return; anchor?.classList.add('speaking'); };
    u.onend = () => { if (token !== speechGeneration) return; anchor?.classList.remove('speaking'); activeUtterance = null; };
    u.onerror = e => {
      if (token !== speechGeneration || ['canceled', 'interrupted'].includes(e.error)) return;
      anchor?.classList.remove('speaking'); activeUtterance = null;
      const key = activeWord?.en.toLowerCase().trim();
      if (key && audioFiles[key]) playAudioFile(audioFiles[key], token);
      else voiceStatus('设备语音暂时没能播放，请检查语音设置和设备音量，再点一次单词。');
    };
    speechSynthesis.speak(u);
  }
  function showImport() {
    clearActiveWord(); pending = null; importGeneration++;
    $('#import-preview').hidden = true; $('#import-error').hidden = true; $('#word-file').value = '';
    $('#import-dialog').showModal();
  }
  function importError(message) { $('#import-error').textContent = message; $('#import-error').hidden = false; }
  async function onFile() {
    const file = $('#word-file').files[0], generation = ++importGeneration;
    pending = null; $('#import-preview').hidden = true; $('#import-error').hidden = true;
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw Error('文件超过 5 MB，请精简文件后再导入。');
      let candidates, warning = '';
      if (/\.json$/i.test(file.name)) candidates = validateData(JSON.parse(await file.text()));
      else {
        const parsed = await MaimaiDocx.parseFile(file); warning = parsed.warning;
        candidates = [{ id: uid(), title: file.name.replace(/\.docx$/i, '').slice(0, 60) || '新一周单词', date: today(), source: file.name, rows: parsed.rows }];
      }
      if (generation !== importGeneration || !$('#import-dialog').open) return;
      candidates = candidates.map(w => ({ ...w, child }));
      const known = new Set(weeks.map(signature));
      candidates = candidates.filter(w => { const s = signature(w); if (known.has(s)) return false; known.add(s); return true; });
      if (!candidates.length) throw Error('这些词表已经在花园里了，不用重复导入。');
      pending = candidates;
      $('#import-name').value = candidates[0].title; $('#import-name').disabled = candidates.length > 1;
      const preview = $('#preview-list'); preview.replaceChildren();
      candidates.flatMap(w => w.rows.flat()).slice(0, 6).forEach(w => { const row = el('div', 'preview-row'); row.append(el('span', '', w.en), el('span', '', w.zh)); preview.append(row); });
      $('#preview-count').textContent = `将新增 ${candidates.length} 份词表，共 ${candidates.reduce((n, w) => n + count(w), 0)} 项，已有词表不会被覆盖。` + (warning ? ' ' + warning : '');
      $('#import-preview').hidden = false;
    } catch (error) { if (generation === importGeneration) importError(error instanceof SyntaxError ? '备份文件不是有效的 JSON，请使用本站导出的词表备份。' : error.message); }
  }
  function confirmImport() {
    if (!pending) return;
    if (!storageReadable) { importError('无法安全读取已有本地词表，暂不写入。请先备份或换普通浏览模式。'); return; }
    const name = $('#import-name').value.trim();
    if (!name) { importError('先给这一周起个名字吧。'); return; }
    const additions = pending.map(w => ({ ...w, child, id: uid(), title: pending.length === 1 ? name : w.title }));
    const next = [...additions, ...local];
    try {
      validateData({ version: 1, weeks: [...published, ...next] });
      localStorage.setItem(STORE, JSON.stringify({ version: 1, weeks: next }));
    } catch (error) { importError('没有保存成功，原有词表仍保留。' + (error.name === 'QuotaExceededError' ? '浏览器空间不足，请先备份并清理其他网站数据。' : error.message)); return; }
    local = next; selected = additions[0].id; pending = null; $('#import-dialog').close(); rebuild();
    try { localStorage.setItem(SELECTION, selected); } catch (_) { /* Collection itself has already been saved. */ }
    toast(`${CHILDREN[child]}的新词表已加入此设备，旧词表都还在。`);
  }
  function backup() {
    const ownWeeks = [...local.filter(w => w.child === child), ...published.filter(w => w.child === child)];
    const blob = new Blob([JSON.stringify({ version: 1, weeks: ownWeeks.map(({ isLocal, ...w }) => w) }, null, 2)], { type: 'application/json' });
    const a = el('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = `${CHILDREN[child]}的词表备份-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function init() {
    $('#help-open').onclick = () => { clearActiveWord(); $('#help-dialog').showModal(); };
    $('#import-open').onclick = showImport; $('#word-file').onchange = onFile; $('#import-confirm').onclick = confirmImport;
    $('[data-close="import-dialog"]').onclick = () => { importGeneration++; pending = null; $('#import-dialog').close(); };
    $('[data-close="help-dialog"]').onclick = () => $('#help-dialog').close();
    $('#import-dialog').addEventListener('cancel', () => { importGeneration++; pending = null; });
    $('#backup').onclick = backup;
    $('#child-select').onchange = e => { child = e.target.value; selected = ''; rebuild(); try { localStorage.setItem('maimai-garden-child-v1', child); } catch (_) {} };
    $('#week-select').onchange = e => { selected = e.target.value; render(); try { localStorage.setItem(SELECTION, selected); } catch (_) {} };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') clearActiveWord(); });
    if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', () => { if (activeWord && !activeUtterance && speechVoice()) voiceStatus('英语语音已就绪，再点单词即可播放。'); }); }
    readLocal();
    try { child = localStorage.getItem('maimai-garden-child-v1') || 'maimai'; } catch (_) {}
    if (!Object.hasOwn(CHILDREN, child)) child = 'maimai';
    $('#child-select').value = child;
    const [dataResult, phonicsResult, audioResult] = await Promise.allSettled([
      fetch('./data/weeks.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw Error('词表读取失败'); return r.json(); }).then(validateData),
      fetch('./data/phonics.json').then(r => { if (!r.ok) throw Error('拼读提示读取失败'); return r.json(); }),
      fetch('./data/audio.json?v=3ada842', { cache: 'no-cache' }).then(r => { if (!r.ok) throw Error('英音音频目录读取失败'); return r.json(); })
    ]);
    if (dataResult.status === 'fulfilled') {
      published = dataResult.value;
      const latest = [...published].sort((a, b) => b.date.localeCompare(a.date))[0]?.id;
      try {
        const seen = localStorage.getItem(LATEST);
        if (seen && seen !== latest) selected = latest;
        if (latest) localStorage.setItem(LATEST, latest);
      } catch (_) { /* Published collections do not require browser storage. */ }
    }
    else notice('网站词表暂时没有加载成功，请刷新重试。已有的本地词表仍可使用，也可以导入备份。');
    if (phonicsResult.status === 'fulfilled') phonics = phonicsResult.value;
    else { if (dataResult.status === 'fulfilled' && storageReadable) notice('拼读提示暂时没有加载成功，请刷新重试；词表和设备英音仍可使用。'); }
    if (audioResult.status === 'fulfilled') audioFiles = audioResult.value;
    // Local IDs cannot mask the website's published collections.
    const publishedIds = new Set(published.map(w => w.id));
    local = local.map(w => publishedIds.has(w.id) ? { ...w, id: uid() } : w);
    rebuild();
  }
  init().catch(() => { notice('页面暂时没能打开，请刷新后重试。'); $('#word-list').setAttribute('aria-busy', 'false'); });
})();
