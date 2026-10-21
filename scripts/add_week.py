#!/usr/bin/env python3
"""Append one DOCX week to the published catalogue; never replace older weeks."""
import argparse
from datetime import date
import json
from pathlib import Path
import re
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile, BadZipFile

ROOT = Path(__file__).resolve().parents[1]
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
W = '{' + NS['w'] + '}'


def parse_docx(path):
    if path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError('文件超过 5 MB')
    with ZipFile(path) as archive:
        if archive.getinfo('word/document.xml').file_size > 4 * 1024 * 1024:
            raise ValueError('Word 正文超过 4 MB')
        xml = archive.read('word/document.xml')
    if re.search(br'<!DOCTYPE|<!ENTITY', xml, re.I):
        raise ValueError('不支持 XML DTD 或实体')
    body = ET.fromstring(xml).find('w:body', NS)
    if body is None:
        raise ValueError('没有找到 Word 正文')
    rows, skipped = [], False

    def add(cells):
        if not any(cells):
            return
        if all(re.fullmatch(r'中文|释义|意思|meaning|chinese' if i % 2 else r'英文|单词|english|word|words', s, re.I) for i, s in enumerate(cells)):
            return
        if len(cells) % 2 or len(cells) > 6:
            raise ValueError('每行需要 1–3 组“英文｜中文”')
        row = []
        for en, zh in zip(cells[::2], cells[1::2]):
            if not en and not zh:
                continue
            if not en or not zh or not re.search('[a-z]', en, re.I) or re.search('[\u3400-\u9fff]', en) or len(en) > 150 or len(zh) > 300:
                raise ValueError(f'英文或中文不完整：{en!r} / {zh!r}')
            row.append({'en': en, 'zh': zh})
        if row:
            rows.append(row)

    def clean(s):
        return ' '.join(s.split())

    for block in body:
        if block.tag == W + 'tbl':
            for tr in block.findall('w:tr', NS):
                cells = tr.findall('w:tc', NS)
                if any(c.find('.//w:gridSpan', NS) is not None or c.find('.//w:vMerge', NS) is not None or c.find('.//w:tbl', NS) is not None for c in cells):
                    raise ValueError('暂不支持合并单元格或嵌套表格')
                add([clean(''.join(t.text or '' for t in c.findall('.//w:t', NS))) for c in cells])
        elif block.tag == W + 'p':
            raw = ''.join('\t' if n.tag == W + 'tab' else (n.text or '') if n.tag == W + 't' else '' for run in block.findall('.//w:r', NS) for n in run)
            if '\t' in raw:
                add([clean(s) for s in raw.split('\t')])
            elif raw.strip():
                skipped = True
    if not rows or len(rows) > 1000 or sum(map(len, rows)) > 2000:
        raise ValueError('需要 1–2,000 项单词，最多 1,000 行')
    return rows, skipped


def append_week(path, catalogue, title, day, identity=None, child='maimai'):
    date.fromisoformat(day)
    if not title.strip() or len(title) > 60:
        raise ValueError('标题需要 1–60 个字')
    rows, skipped = parse_docx(path)
    data = json.loads(catalogue.read_text()) if catalogue.exists() else {'version': 1, 'weeks': []}
    if data.get('version') != 1 or not isinstance(data.get('weeks'), list):
        raise ValueError('现有词表格式不正确，未修改文件')
    if child not in ('maimai', 'xiaoyu'):
        raise ValueError('孩子编号只能是 maimai 或 xiaoyu')
    if any(week.get('child', 'maimai') == child and week['rows'] == rows for week in data['weeks']):
        raise ValueError('相同内容的词表已经存在，未重复添加')
    identities = {week['id'] for week in data['weeks']}
    identity = identity or day
    if identity in identities:
        raise ValueError('该编号已存在，请指定不同的 --id；旧词表不会被覆盖')
    if len(data['weeks']) >= 100 or sum(sum(map(len, w['rows'])) for w in data['weeks']) + sum(map(len, rows)) > 8000:
        raise ValueError('目前最多支持 100 周、合计 8,000 项，请先归档')
    week = {'id': identity, 'child': child, 'title': title.strip(), 'date': day, 'source': path.name, 'rows': rows}
    data['weeks'].append(week)
    data['weeks'].sort(key=lambda w: w['date'], reverse=True)
    # Atomic replacement: parsing/validation failures never truncate the catalogue.
    temp = catalogue.with_suffix('.json.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.replace(catalogue)
    return week, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--title', required=True)
    parser.add_argument('--date', required=True, help='YYYY-MM-DD，中国当地日期')
    parser.add_argument('--id', help='默认用日期，同日多份时指定不同编号')
    parser.add_argument('--child', choices=('maimai', 'xiaoyu'), default='maimai', help='词表所属孩子，默认 maimai')
    args = parser.parse_args()
    catalogue = ROOT / 'data' / 'weeks.json'
    try:
        week, skipped = append_week(args.file, catalogue, args.title, args.date, args.id, args.child)
    except (ValueError, OSError, KeyError, BadZipFile, ET.ParseError) as error:
        sys.exit(f'未导入：{error}')
    print(f'已新增 {week["title"]}：{sum(map(len, week["rows"]))} 项；旧词表保留。')
    if skipped:
        print('提示：已忽略表格外的普通标题或段落，请核对原文件。')
    known = json.loads((ROOT / 'data' / 'phonics.json').read_text())
    missing = [w['en'] for row in week['rows'] for w in row if w['en'].lower().strip() not in known]
    if missing:
        print('以下词语的拼读提示需核对后补入 data/phonics.json：' + '、'.join(missing))
    print('下一步：浏览器核对顺序和发音，运行测试；提交并发布到 GitHub Pages 后，其他设备才会看到。')


if __name__ == '__main__':
    main()
