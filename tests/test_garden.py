"""Meaningful import, archive, speech and browser regressions. No npm setup required."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from add_week import append_week, parse_docx

SOURCE = json.loads((ROOT / 'data/weeks.json').read_text())
PHONICS = json.loads((ROOT / 'data/phonics.json').read_text())
ROWS = [[('moon', '月亮'), ('boat', '小船')], [('ship', '船'), ('train', '火车')]]


def docx_bytes(rows=ROWS, merge=False):
    table = ''.join('<w:tr>' + ''.join('<w:tc>' + ('<w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' if merge else '') + '<w:p><w:r><w:t>' + escape(text) + '</w:t></w:r></w:p></w:tc>' for pair in row for text in pair) + '</w:tr>' for row in rows)
    xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl>' + table + '</w:tbl></w:body></w:document>'
    output = io.BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('word/document.xml', xml)
    return output.getvalue()


class CatalogueTests(unittest.TestCase):
    def test_source_and_phonics_coverage(self):
        week = SOURCE['weeks'][0]
        self.assertEqual(len(week['rows']), 43)
        self.assertEqual(sum(map(len, week['rows'])), 86)
        self.assertEqual([w['en'] for w in week['rows'][0]], ['keep', 'mind'])
        self.assertEqual([w['en'] for w in week['rows'][-1]], ['train', 'would rather'])
        for row in week['rows']:
            for word in row:
                entry = PHONICS[word['en'].lower()]
                self.assertTrue(entry['hint'])
                self.assertIn(entry['kind'], ['blend', 'syllables', 'phrase'])
                if entry['kind'] != 'phrase':
                    self.assertEqual(''.join(entry['parts']).lower(), word['en'].lower())

    def test_append_preserves_history_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = Path(directory) / 'next.docx'; doc.write_bytes(docx_bytes())
            catalogue = Path(directory) / 'weeks.json'; catalogue.write_text(json.dumps(SOURCE))
            original = json.loads(catalogue.read_text())['weeks'][0]
            append_week(doc, catalogue, '下一周', '2026-10-26')
            added = json.loads(catalogue.read_text())
            self.assertEqual(added['weeks'][1], original)
            self.assertEqual(added['weeks'][0]['rows'][0][0]['en'], 'moon')
            saved = catalogue.read_bytes()
            with self.assertRaisesRegex(ValueError, '相同内容'):
                append_week(doc, catalogue, '重复', '2026-11-02')
            self.assertEqual(catalogue.read_bytes(), saved)

    def test_unsupported_layout_and_bad_dates_do_not_change_catalogue(self):
        with tempfile.TemporaryDirectory() as directory:
            doc = Path(directory) / 'merged.docx'; doc.write_bytes(docx_bytes(merge=True))
            catalogue = Path(directory) / 'weeks.json'; catalogue.write_text(json.dumps(SOURCE))
            before = catalogue.read_bytes()
            with self.assertRaisesRegex(ValueError, '合并'):
                append_week(doc, catalogue, '测试', '2026-10-26')
            doc.write_bytes(docx_bytes())
            with self.assertRaises(ValueError):
                append_week(doc, catalogue, '测试', '2026-02-30')
            self.assertEqual(catalogue.read_bytes(), before)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


VOICE_STUB = """(() => {
window.__spoken = [];
window.__voices = [{name:'US voice', lang:'en-US', localService:true}, {name:'British voice', lang:'en-GB', localService:true}];
window.__voiceEvents = {};
window.SpeechSynthesisUtterance = class { constructor(text) {this.text=text;} };
Object.defineProperty(window,'speechSynthesis',{value:{
getVoices:()=>window.__voices,
addEventListener:(type,fn)=>window.__voiceEvents[type]=fn,
cancel:()=>{},
speak:u=>{window.__spoken.push({text:u.text,rate:u.rate,lang:u.lang,voice:u.voice.lang}); if(u.onstart)u.onstart();setTimeout(()=>{if(u.onend)u.onend();},20);}
}});
})()"""


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT.parent)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}/{ROOT.name}/'
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        self.context = self.browser.new_context(timezone_id='Asia/Shanghai')
        self.context.add_init_script(VOICE_STUB)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def load(self):
        self.page.goto(self.base)
        expect(self.page.locator('.word-card')).to_have_count(86)

    def upload(self, data=None, name='新词.docx'):
        self.page.click('#import-open')
        self.page.locator('#word-file').set_input_files({'name':name,'mimeType':'application/octet-stream','buffer': data if data is not None else docx_bytes()})

    def import_week(self):
        self.upload()
        expect(self.page.locator('#import-preview')).to_be_visible()
        self.page.fill('#import-name', '第 2 周')
        self.page.click('#import-confirm')
        expect(self.page.locator('.word-card')).to_have_count(4)

    def test_all_words_in_source_order_and_subpath_resources(self):
        requested = []
        self.page.on('request', lambda r: requested.append(r.url))
        self.load()
        expected = [w['en'] for row in SOURCE['weeks'][0]['rows'] for w in row]
        self.assertEqual(self.page.locator('.english').all_text_contents(), expected)
        self.assertEqual(self.page.locator('.word-row').count(), 43)
        self.assertTrue(all(u.startswith(self.base) for u in requested))

    def test_click_uk_voice_colors_original_text_without_popup_or_layout_shift(self):
        self.load()
        card = self.page.locator('.word-card').first
        card.scroll_into_view_if_needed()
        before = card.bounding_box()
        card.click()
        expect(self.page.locator('#phonics')).to_have_count(0)
        expect(self.page.locator('dialog[open]')).to_have_count(0)
        self.assertEqual(card.locator('.phonics-segment').all_text_contents(), ['k','ee','p'])
        self.assertEqual(card.locator('.english').inner_text(), 'keep')
        self.assertEqual(card.bounding_box(), before)
        colors = card.locator('.phonics-segment').evaluate_all('(parts) => parts.map(p=>getComputedStyle(p).color)')
        self.assertEqual(len(set(colors)), 3)
        self.assertEqual(self.page.evaluate('__spoken[0]'), {'text':'keep','rate':1,'lang':'en-GB','voice':'en-GB'})
        expect(self.page.locator('#voice-status')).to_be_hidden()
        card.click()
        self.assertEqual(self.page.evaluate('__spoken.length'), 2)
        self.assertEqual(card.locator('.phonics-segment').count(), 3)
        self.page.locator('.word-card').nth(1).click()
        expect(card.locator('.phonics-segment')).to_have_count(0)
        expect(card).to_have_attribute('aria-pressed', 'false')
        self.page.keyboard.press('Escape')
        expect(self.page.locator('.word-card').nth(1)).to_have_attribute('aria-pressed', 'false')

    def test_coloring_preserves_all_original_spelling_spaces_and_punctuation(self):
        self.load()
        result = self.page.locator('.word-card').evaluate_all('cards => cards.map(card => { const before=card.querySelector(".english").textContent; card.click(); return {before,after:card.querySelector(".english").textContent,groups:card.querySelectorAll(".phonics-segment").length}; })')
        self.assertEqual(len(result), 86)
        for word in result:
            self.assertEqual(word['before'], word['after'])
            self.assertGreater(word['groups'], 0, word['before'])

    def test_missing_uk_voice_never_uses_us_voice(self):
        self.load(); self.page.evaluate('__voices = __voices.filter(v=>v.lang==="en-US")')
        self.page.locator('.word-card').first.click()
        expect(self.page.locator('#voice-status')).to_contain_text('尚无可用英音')
        self.assertEqual(self.page.evaluate('__spoken.length'), 0)
        self.page.evaluate('__voices.push({name:"UK",lang:"en-GB",localService:true});__voiceEvents.voiceschanged()')
        expect(self.page.locator('#voice-status')).to_contain_text('已就绪')
        self.page.locator('.word-card').first.click()
        self.assertEqual(self.page.evaluate('__spoken.length'), 1)

    def test_speech_failure_is_visible(self):
        self.load()
        self.page.evaluate('() => {speechSynthesis.speak = u => u.onerror({error:"network"});}')
        self.page.locator('.word-card').first.click()
        expect(self.page.locator('#voice-status')).to_contain_text('没能播放')

    def test_incremental_import_archive_reload_and_unknown_phonics(self):
        self.load(); self.import_week()
        expect(self.page.locator('#local-tag')).to_be_visible()
        self.page.locator('.word-card').first.click()
        expect(self.page.locator('.word-card').first.locator('.phonics-segment')).to_have_count(0)
        self.assertEqual(self.page.evaluate('__spoken[0].text'), 'moon')
        self.page.reload()
        expect(self.page.locator('.word-card')).to_have_count(4)
        self.page.select_option('#week-select', SOURCE['weeks'][0]['id'])
        expect(self.page.locator('.word-card')).to_have_count(86)
        self.page.reload(); expect(self.page.locator('.word-card')).to_have_count(86)
        expect(self.page.locator('#week-select option')).to_have_count(2)

    def test_duplicate_import_rejected_without_modification(self):
        self.load(); self.import_week(); self.upload()
        expect(self.page.locator('#import-error')).to_contain_text('已经在花园里')
        expect(self.page.locator('#week-select option')).to_have_count(2)
        expect(self.page.locator('#import-preview')).to_be_hidden()

    def test_export_and_restore_merges_without_replacing_published_week(self):
        self.load(); self.import_week()
        with self.page.expect_download() as result: self.page.click('#backup')
        backup = Path(result.value.path()).read_bytes()
        self.assertEqual(len(json.loads(backup)['weeks']), 2)
        self.page.evaluate('localStorage.clear()'); self.page.reload()
        expect(self.page.locator('.word-card')).to_have_count(86)
        self.upload(backup, '词表备份.json')
        expect(self.page.locator('#import-preview')).to_be_visible()
        self.page.click('#import-confirm')
        expect(self.page.locator('#week-select option')).to_have_count(2)
        self.page.select_option('#week-select', SOURCE['weeks'][0]['id'])
        expect(self.page.locator('.word-card')).to_have_count(86)

    def test_corrupt_files_and_merged_tables_rejected(self):
        self.load()
        for payload,name,match in [(b'bad','bad.docx','无法打开'), (b'{bad','bad.json','JSON'), (docx_bytes(merge=True),'merged.docx','合并单元格')]:
            self.upload(payload,name)
            expect(self.page.locator('#import-error')).to_contain_text(match)
            self.page.locator('[data-close="import-dialog"]').click()
        expect(self.page.locator('#week-select option')).to_have_count(1)

    def test_quota_failure_retains_previous_weeks(self):
        self.load(); self.upload()
        expect(self.page.locator('#import-preview')).to_be_visible()
        self.page.evaluate('() => {Storage.prototype.setItem = () => {throw new DOMException("full","QuotaExceededError")};}')
        self.page.click('#import-confirm')
        expect(self.page.locator('#import-error')).to_contain_text('空间不足')
        expect(self.page.locator('#week-select option')).to_have_count(1)
        self.assertIsNone(self.page.evaluate('localStorage.getItem("maimai-garden-collections-v2")'))

    def test_corrupt_local_storage_is_not_overwritten(self):
        self.load(); self.page.evaluate('localStorage.setItem("maimai-garden-collections-v2", "broken")'); self.page.reload()
        expect(self.page.locator('#notice')).to_contain_text('无法读取')
        self.upload(); expect(self.page.locator('#import-preview')).to_be_visible(); self.page.click('#import-confirm')
        expect(self.page.locator('#import-error')).to_contain_text('暂不写入')
        self.assertEqual(self.page.evaluate('localStorage.getItem("maimai-garden-collections-v2")'), 'broken')

    def test_untrusted_word_text_is_not_html(self):
        self.load(); self.upload(docx_bytes([[('moon','<img src=x onerror=alert(1)>')]]))
        expect(self.page.locator('#import-preview')).to_be_visible(); self.page.click('#import-confirm')
        expect(self.page.locator('.word-card')).to_have_count(1)
        expect(self.page.locator('.chinese')).to_have_text('<img src=x onerror=alert(1)>')
        self.assertEqual(self.page.locator('#word-list img').count(), 0)

    def test_mobile_inline_coloring_and_help(self):
        self.page.set_viewport_size({'width':390,'height':844}); self.load()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        card = self.page.locator('.word-card').nth(85)
        card.scroll_into_view_if_needed()
        before = card.bounding_box()
        card.click()
        self.assertEqual(card.locator('.english').inner_text(), 'would rather')
        self.assertEqual(card.bounding_box(), before)
        expect(self.page.locator('#phonics')).to_have_count(0)
        expect(self.page.locator('dialog[open]')).to_have_count(0)
        self.page.click('#help-open')
        expect(self.page.locator('#help-dialog')).to_be_visible()
        self.page.keyboard.press('Escape'); expect(self.page.locator('#help-dialog')).to_be_hidden()

    def test_new_published_week_opens_latest_and_keeps_history(self):
        self.load()
        new = {'id':'2026-10-26','title':'新一周','date':'2026-10-26','rows':[[{'en':'moon','zh':'月亮'}]]}
        self.page.route('**/data/weeks.json', lambda route: route.fulfill(json={'version':1,'weeks':[new,*SOURCE['weeks']]}))
        self.page.reload(); expect(self.page.locator('.word-card')).to_have_count(1)
        expect(self.page.locator('#week-select')).to_have_value(new['id'])
        self.page.select_option('#week-select', SOURCE['weeks'][0]['id'])
        expect(self.page.locator('.word-card')).to_have_count(86)

    def test_catalogue_network_failure_preserves_local_data(self):
        self.load(); self.import_week()
        self.page.route('**/data/weeks.json', lambda route: route.fulfill(status=503, body='unavailable'))
        self.page.reload(); expect(self.page.locator('.word-card')).to_have_count(4)
        expect(self.page.locator('#notice')).to_contain_text('加载成功')


if __name__ == '__main__':
    unittest.main()
