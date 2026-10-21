/* DOCX reading stays on this device. fflate is vendored with its MIT licence. */
(() => {
  'use strict';
  const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const MAX_XML = 4 * 1024 * 1024;
  const vocabHeading = /^(核心词汇|认知词汇|认读词汇|重点词汇|重点单词|核心单词|词汇表|单词表|vocabulary|core vocabulary|key vocabulary|recognition vocabulary|word list)$/i;
  const stopHeading = /^(语法|语法知识|grammar|homework|作业|练习|练习题|reading|writing|课文|句型|sentence patterns?)/i;
  const clean = text => text.replace(/\s+/g, ' ').trim();
  const textOf = node => clean(Array.from(node.getElementsByTagNameNS(NS, 't'), n => n.textContent).join(''));
  const children = (node, name) => Array.from(node.children).filter(n => n.namespaceURI === NS && n.localName === name);
  const isHeader = cells => cells.every((s, i) => (i % 2 ? /^(中文|释义|意思|meaning|chinese)$/i : /^(英文|单词|english|word|words)$/i).test(s));
  const looksLikeVocabulary = row => row.every(({ en }) => {
    const text = en.trim();
    return text.length <= 48 && text.split(/\s+/).length <= 4 && !/[.!?]/.test(text) && !(/^(i|you|he|she|it|we|they)\s+(am|are|is|was|were|have|has|do|does|did|can|will|would)\b/i.test(text));
  });

  function pairs(cells, rowNumber) {
    if (cells.every(s => !s)) return [];
    if (isHeader(cells)) return [];
    if (cells.length % 2 || cells.length > 6) throw Error(`第 ${rowNumber} 行不是成对的“英文｜中文”，请检查表格。`);
    const row = [];
    for (let i = 0; i < cells.length; i += 2) {
      const en = cells[i], zh = cells[i + 1];
      if (!en && !zh) continue;
      if (!en || !zh || !/[a-z]/i.test(en) || /[\u3400-\u9fff]/.test(en) || en.length > 150 || zh.length > 300) {
        throw Error(`第 ${rowNumber} 行的英文或中文不完整，请使用“英文｜中文”的表格。`);
      }
      row.push({ en, zh });
    }
    return row;
  }

  function parseXML(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('此文件含有不支持的 XML 内容，请另存为普通 .docx。');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw Error('Word 内容损坏，请重新另存为 .docx。');
    const body = doc.getElementsByTagNameNS(NS, 'body')[0];
    if (!body) throw Error('没有找到 Word 正文。');
    const rows = [];
    let rowNumber = 0;
    let plainSkipped = false;
    const blocks = Array.from(body.children);
    const isVocabHeading = block => block.localName === 'p' && vocabHeading.test(textOf(block).replace(/[【】\[\]（）()：:]/g, '').trim());
    const isStopHeading = block => block.localName === 'p' && stopHeading.test(textOf(block).trim());
    const hasVocabularySections = blocks.some(isVocabHeading);
    let inVocabularySection = !hasVocabularySections;
    for (const block of blocks) {
      if (isVocabHeading(block)) { inVocabularySection = true; continue; }
      if (isStopHeading(block)) { inVocabularySection = false; continue; }
      if (!inVocabularySection) continue;
      if (block.localName === 'tbl') {
        for (const tr of children(block, 'tr')) {
          rowNumber++;
          const cells = children(tr, 'tc');
          if (cells.some(c => c.getElementsByTagNameNS(NS, 'gridSpan').length || c.getElementsByTagNameNS(NS, 'vMerge').length || c.getElementsByTagNameNS(NS, 'tbl').length)) {
            throw Error('暂不支持合并单元格或嵌套表格，请改为普通的“英文｜中文”表格后导入。');
          }
          let row;
          try { row = pairs(cells.map(textOf), rowNumber); }
          catch (error) { if (hasVocabularySections) throw error; plainSkipped = true; continue; }
          if (row.length) {
            const vocabularyRow = hasVocabularySections ? row : row.filter(word => looksLikeVocabulary([word]));
            if (vocabularyRow.length !== row.length) plainSkipped = true;
            if (vocabularyRow.length) rows.push(vocabularyRow);
          }
        }
      } else if (block.localName === 'p') {
        const raw = Array.from(block.getElementsByTagNameNS(NS, 'r')).map(r => Array.from(r.children).map(n => n.localName === 'tab' ? '\t' : n.localName === 't' ? n.textContent : '').join('')).join('');
        const cells = raw.split('\t').map(clean);
        if (cells.length > 1) {
          let row;
          try { row = pairs(cells, ++rowNumber); }
          catch (error) { if (hasVocabularySections) throw error; plainSkipped = true; continue; }
          if (row.length) {
            const vocabularyRow = hasVocabularySections ? row : row.filter(word => looksLikeVocabulary([word]));
            if (vocabularyRow.length !== row.length) plainSkipped = true;
            if (vocabularyRow.length) rows.push(vocabularyRow);
          }
        } else if (clean(raw)) plainSkipped = true;
      }
    }
    if (!rows.length) throw Error('没有找到单词表。请使用“英文｜中文”的表格，或用 Tab 分隔英文和中文。');
    if (rows.length > 1000 || rows.flat().length > 2000) throw Error('一份文件最多支持 2,000 项，请按周拆分。');
    return { rows, warning: plainSkipped ? '已忽略词汇标题以外或不符合词条格式的内容，请核对下方预览。' : '' };
  }

  async function parseFile(file) {
    if (file.size > 5 * 1024 * 1024) throw Error('文件超过 5 MB，请精简单词文件后再导入。');
    if (!/\.docx$/i.test(file.name)) throw Error('请选择 .docx 文件；旧版 .doc 请先另存为 .docx。');
    let files;
    try {
      files = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()), { filter(entry) {
        if (entry.name !== 'word/document.xml') return false;
        if (entry.originalSize > MAX_XML) throw Error('Word 正文过大，请按周拆分。');
        return true;
      } });
    } catch (e) {
      if (e.message.includes('正文过大')) throw e;
      throw Error('无法打开这个 Word 文件，请确认它是未加密的 .docx 文件。');
    }
    const content = files['word/document.xml'];
    if (!content || content.length > MAX_XML) throw Error('文件中没有可读取的 Word 正文，或正文过大。');
    return parseXML(new TextDecoder('utf-8', { fatal: true }).decode(content));
  }
  window.MaimaiDocx = { parseFile, parseXML };
})();
