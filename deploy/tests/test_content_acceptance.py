import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class PublishedContentAcceptanceTests(unittest.TestCase):
    def run_check(self, change=None):
        script = (pathlib.Path(__file__).resolve().parents[1] / "scripts" / "acceptance-test.sh").read_text(encoding="utf-8")
        code = script.split("# BEGIN_DYNAMIC_CONTENT_CHECK\n", 1)[1].split("# END_DYNAMIC_CONTENT_CHECK", 1)[0]
        with tempfile.TemporaryDirectory(prefix="etp-content-acceptance-") as directory:
            database = pathlib.Path(directory) / "test.db"
            with sqlite3.connect(database) as db:
                db.executescript("""
                    CREATE TABLE app_meta(key TEXT, value TEXT);
                    INSERT INTO app_meta VALUES ('content_version','99');
                    CREATE TABLE categories(id TEXT,name TEXT,kind TEXT,sort_order INTEGER,status TEXT);
                    INSERT INTO categories VALUES ('new-category','管理员新题库','sentence',31,'published');
                    INSERT INTO categories VALUES ('hidden-category','草稿','word',1,'draft');
                    CREATE TABLE items(id TEXT,item_key TEXT,category_id TEXT,kind TEXT,english TEXT,meaning TEXT,pronunciation TEXT,sort_order INTEGER,revision INTEGER,status TEXT);
                    INSERT INTO items VALUES ('new-item','md-unique','new-category','sentence','Hello.','你好。','哈喽',8,3,'published');
                    INSERT INTO items VALUES ('hidden-item','hidden-key','hidden-category','word','Hidden','隐藏','',1,1,'published');
                """)
            db.close()
            payload = {"version": "99", "categories": [{"id": "new-category", "name": "管理员新题库", "kind": "sentence", "sortOrder": 31}],
                       "items": [{"id": "new-item", "key": "md-unique", "categoryId": "new-category", "kind": "sentence", "english": "Hello.", "meaning": "你好。", "pronunciation": "哈喽", "sortOrder": 8, "revision": 3}]}
            if change:
                change(payload)
            path = pathlib.Path(directory) / "content.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return subprocess.run([sys.executable, "-c", code, str(path), str(database)], capture_output=True, text=True)

    def test_accepts_current_imported_content_without_seed_counts(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_changed_meaning(self):
        result = self.run_check(lambda value: value["items"][0].update(meaning="Wrong"))
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_duplicate_item_ids(self):
        result = self.run_check(lambda value: value["items"].append(value["items"][0]))
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_version_race(self):
        result = self.run_check(lambda value: value.update(version="old"))
        self.assertNotEqual(result.returncode, 0)
