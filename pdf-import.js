/* Extract explicit vocabulary tables from text-based PDFs, entirely in the browser. */
(() => {
  'use strict';
  const vocabularyHeading = /^(核心词汇|认知词汇|认读词汇|重点词汇|重点单词|核心单词|词汇表|单词表|单词|vocabulary|core vocabulary|key vocabulary|recognition vocabulary|word list)$/i;
  const stopHeading = /^(?:重点语法|语法知识|语法|作业|练习题?|课文|句型|句子默写|短文翻译|口语(?:\/写作)?|写作|grammar|homework|reading|writing|sentence patterns?)$/i;
  const headerCell = /^(汉语含义|中文含义|英语单词|英文单词|单词|释义|meaning|chinese|english|word|vocabulary)$/i;
  const hasChinese = value => /[\u3400-\u9fff]/.test(value);
  const clean = value => value.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const cleanMeaning = value => clean(value).normalize('NFKC').replace(/\s*[（(](?:adj|adv|n|v|pron|prep|conj|num)(?:\.[^）)]*)?[）)]\s*/gi, ' ').trim();
  const isEnglish = value => {
    const text = clean(value).replace(/^[\d.、)）]+\s*/, '').replace(/[，。；;:：]+$/, '').trim();
    return text.length <= 48 && /^(?:[A-Za-z]|\()[A-Za-z'’\-/().…]*(?:\s+[A-Za-z'’\-/().…]+)*$/.test(text) && /[A-Za-z]/.test(text) && !headerCell.test(text);
  };
  const englishText = value => clean(value).replace(/^[\d.、)）]+\s*/, '').replace(/[，。；;:：]+$/, '').trim();

  function groupLines(items) {
    const lines = [];
    for (const item of items.filter(item => item.str && item.str.trim()).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
      const y = item.transform[5];
      let line = lines.find(candidate => Math.abs(candidate.y - y) <= 1.8);
      if (!line) { line = { y, items: [] }; lines.push(line); }
      line.items.push({ x: item.transform[4], width: item.width || 0, str: item.str });
    }
    return lines.sort((a, b) => b.y - a.y).map(line => {
      const cells = [];
      for (const item of line.items.sort((a, b) => a.x - b.x)) {
        const previous = cells[cells.length - 1];
        if (previous && item.x - (previous.x + previous.width) < 12) {
          const gap = item.x - (previous.x + previous.width);
          previous.text += gap > 2 ? ' ' + item.str : item.str;
          previous.width = Math.max(previous.width, item.x + item.width - previous.x);
        } else cells.push({ x: item.x, width: item.width, text: item.str });
      }
      return { y: line.y, cells: cells.map(cell => ({ x: cell.x, text: clean(cell.text) })).filter(cell => cell.text) };
    });
  }

  function heading(text) {
    const normalized = clean(text).normalize('NFKC').replace(/[【】\[\]（）()]/g, '').replace(/[：:]$/, '').trim();
    if (stopHeading.test(normalized)) return { stop: true };
    if (vocabularyHeading.test(normalized)) {
      if (/认知词汇/i.test(normalized)) return { title: '认知词汇' };
      if (/认读词汇/i.test(normalized)) return { title: '认读词汇' };
      if (/核心/.test(normalized)) return { title: '核心词汇' };
      if (/重点/.test(normalized)) return { title: '重点词汇' };
      return { title: '词汇' };
    }
    return null;
  }

  function parseLines(pages) {
    const sections = [];
    let active = false, category = '词汇', pendingEnglish = null;
    const add = (en, zh, section) => {
      en = englishText(en); zh = cleanMeaning(zh);
      if (!isEnglish(en) || !hasChinese(zh) || zh.length > 100 || /[A-Za-z]{3,}/.test(zh)) return;
      let target = sections.find(item => item.title === section);
      if (!target) { target = { title: section, words: [] }; sections.push(target); }
      const key = en.toLowerCase();
      if (!target.words.some(word => word.en.toLowerCase() === key)) target.words.push({ en, zh });
    };
    for (const page of pages) for (const line of page.lines) {
      const text = line.cells.map(cell => cell.text).join(' ');
      const label = heading(text);
      if (label?.stop) { active = false; pendingEnglish = null; continue; }
      if (label?.title) { active = true; category = label.title; pendingEnglish = null; continue; }
      if (!active || line.cells.some(cell => headerCell.test(cell.text))) { pendingEnglish = null; continue; }
      const english = line.cells.filter(cell => isEnglish(cell.text));
      const chinese = line.cells.map(cell => ({ ...cell, text: cleanMeaning(cell.text) })).filter(cell => hasChinese(cell.text) && !/[A-Za-z]{3,}/.test(cell.text));
      const pairByPosition = (englishCells, chineseCells) => {
        const usedChinese = new Set(), unmatchedEnglish = [];
        for (const cell of englishCells) {
          const match = chineseCells.map((candidate, index) => ({ candidate, index, distance: Math.abs(candidate.x - cell.x) })).filter(item => !usedChinese.has(item.index)).sort((a, b) => a.distance - b.distance)[0];
          if (match) { usedChinese.add(match.index); add(cell.text, match.candidate.text, category); }
          else unmatchedEnglish.push(cell);
        }
        return unmatchedEnglish;
      };
      // Paired cells on the same baseline, as in a bilingual vocabulary table.
      if (english.length && chinese.length) {
        const unmatched = pairByPosition(english, chinese);
        pendingEnglish = unmatched.length ? { page: page.number, y: line.y, category, cells: unmatched } : null;
      } else if (english.length) {
        pendingEnglish = { page: page.number, y: line.y, category, cells: english };
      } else if (chinese.length && pendingEnglish && pendingEnglish.page === page.number && pendingEnglish.category === category && pendingEnglish.y - line.y <= 40) {
        const unmatched = pairByPosition(pendingEnglish.cells, chinese);
        pendingEnglish = unmatched.length ? { ...pendingEnglish, cells: unmatched } : null;
      } else pendingEnglish = null;
    }
    const useful = sections.filter(section => section.words.length);
    const total = useful.reduce((sum, section) => sum + section.words.length, 0);
    if (!total) throw Error('没有识别到清晰的词汇表。PDF 需包含可复制的文字及“核心词汇/认知词汇/词汇表”等标题；扫描图片版暂不支持自动识别。');
    if (total > 2000) throw Error('识别到超过 2,000 个词，请按周拆分 PDF。');
    const rows = [], sectionHeaders = [];
    for (const section of useful) {
      sectionHeaders.push({ title: section.title, beforeRow: rows.length });
      for (let i = 0; i < section.words.length; i += 2) rows.push(section.words.slice(i, i + 2));
    }
    return { rows, sectionHeaders };
  }

  async function parseFile(file) {
    if (file.size > 10 * 1024 * 1024) throw Error('PDF 超过 10 MB，请压缩文件后再导入。');
    const pdfjs = await import('./vendor/pdfjs-4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs-4.10.38/pdf.worker.min.mjs', document.baseURI).href;
    let documentTask;
    try {
      documentTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
      const pdf = await documentTask.promise;
      if (pdf.numPages > 60) { await pdf.destroy(); throw Error('PDF 超过 60 页，请只上传单周词汇课件。'); }
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push({ number, lines: groupLines(content.items) });
        page.cleanup();
      }
      await pdf.destroy();
      return parseLines(pages);
    } catch (error) {
      if (error.message.includes('超过 60 页') || error.message.includes('没有识别到') || error.message.includes('超过 2,000')) throw error;
      throw Error('PDF 无法读取。请确认文件未加密且有可复制文字；扫描版或图片版需要 OCR 后再上传。');
    }
  }

  window.MaimaiPdf = { parseFile };
})();
