import gzip
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from audit_git_privacy import audit


class GitPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "local-source"
        (self.source / "conversation").mkdir(parents=True)
        self.original = "합성 비공개 문장으로 만든 Git 경계 검사용 문자열입니다. " * 5
        for split in ("train", "validation"):
            with gzip.open(self.source / f"conversation/source_dialogues.{split}.jsonl.gz", "wt", encoding="utf-8") as stream:
                stream.write(json.dumps({"utterances": [{"speaker": "synthetic", "text": self.original}]}) + "\n")
        self.git("init", "--quiet")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL)

    def stage(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())
        self.git("add", "--", path)

    def test_detects_index_content_even_when_worktree_has_been_sanitized(self):
        self.stage("input.json", json.dumps({"original": self.original}))
        (self.root / "input.json").write_text('{}')
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual(report["exact_source_text_files"], 1)
        self.assertNotIn(self.original, json.dumps(report, ensure_ascii=False))

    def test_cached_removal_preserves_local_copy_and_clears_findings(self):
        self.stage("private/input.json", json.dumps({"original": self.original}))
        self.git("rm", "--cached", "--quiet", "private/input.json")
        self.assertTrue((self.root / "private/input.json").is_file())
        self.assertTrue(audit(self.root, self.source)["passed"])

    def test_newly_ignored_tracked_path_is_rejected_without_matching_text(self):
        self.stage("private/metadata.json", '{}')
        self.stage(".gitignore", 'private/\n')
        report = audit(self.root, self.source)
        self.assertEqual(report["findings"][0]["reasons"], ["tracked_but_ignored"])

    def test_invalid_json_fails_closed(self):
        self.stage("broken.json", '{"secret":')
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(report["errors"], [{"path": "broken.json", "error_type": "JSONDecodeError"}])

    def test_duplicate_keys_fail_closed_at_every_object_depth(self):
        original = json.dumps(self.original, ensure_ascii=False)
        cases = {
            "root": '{"text":' + original + ',"text":"clean"}',
            "nested": '{"outer":{"text":' + original + ',"text":"clean"}}',
            "replaced-object": '{"outer":{"text":' + original + '},"outer":{}}',
            "array": '[{"text":' + original + ',"text":null}]',
            "escaped-key": '{"text":' + original + ',"te\\u0078t":"clean"}',
            "empty-key": '{"":' + original + ',"":"clean"}',
            "identical-clean-values": '{"text":"clean","text":"clean"}',
        }
        for name, content in cases.items():
            path = name + ".json"
            self.stage(path, content)
            (self.root / path).write_text('{}')
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual({error["path"] for error in report["errors"]},
                         {name + ".json" for name in cases})
        self.assertEqual({error["error_type"] for error in report["errors"]}, {"DuplicateJSONKeyError"})
        self.assertNotIn(self.original, json.dumps(report, ensure_ascii=False))

    def test_duplicate_jsonl_and_ndjson_fail_closed(self):
        content = '{}\n{"text":' + json.dumps(self.original) + ',"text":"clean"}\n'
        for suffix in ("jsonl", "ndjson"):
            for encoding in ("utf-8", "utf-8-sig"):
                self.stage(f"{encoding}.{suffix}", content.encode(encoding))
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 4)
        self.assertEqual({error["error_type"] for error in report["errors"]}, {"DuplicateJSONKeyError"})

    def test_gzip_duplicate_json_keys_fail_closed(self):
        content = '{"text":' + json.dumps(self.original) + ',"text":"clean"}'
        for suffix in ("json", "jsonl", "ndjson"):
            self.stage(f"duplicate.{suffix}.gz", gzip.compress(content.encode("utf-8-sig")))
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 3)
        self.assertEqual({error["error_type"] for error in report["errors"]}, {"DuplicateJSONKeyError"})

    def test_office_embedded_duplicate_json_keys_fail_closed(self):
        content = '{"text":' + json.dumps(self.original) + ',"text":"clean"}'
        for extension, main in (("pptx", "ppt/presentation.xml"),
                                ("docx", "word/document.xml"), ("xlsx", "xl/workbook.xml")):
            for suffix in ("json", "jsonl", "ndjson.gz"):
                archive = io.BytesIO()
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr("[Content_Types].xml", '<Types/>')
                    bundle.writestr("_rels/.rels", '<Relationships/>')
                    bundle.writestr(main, '<document/>')
                    data = gzip.compress(content.encode()) if suffix.endswith(".gz") else content.encode()
                    bundle.writestr("embeddings/input." + suffix, data)
                self.stage(suffix + "." + extension, archive.getvalue())
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 9)
        self.assertEqual({error["error_type"] for error in report["errors"]}, {"DuplicateJSONKeyError"})

    def test_repeated_keys_in_distinct_objects_are_allowed(self):
        # Keys in different objects/records are independent, as are distinct
        # decoded keys; the duplicate policy must not normalize arbitrary keys.
        self.stage("clean.json", '{"items":[{"text":1},{"text":2}],"text":3,"Text":4,"Ａ":5,"A":6}')
        for suffix in ("jsonl", "ndjson"):
            self.stage("clean." + suffix, '{"text":1}\n{"text":2}\n')
        report = audit(self.root, self.source)
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["coverage"], {"json": 1, "jsonl": 2})

    def test_cli_rejects_duplicate_keys_without_printing_keys_or_source(self):
        key = "synthetic-private-key-not-for-output"
        self.stage("input.json", json.dumps({key: self.original})[:-1] + ',' + json.dumps(key) + ':"clean"}')
        (self.root / "input.json").write_text('{}')
        output = self.root / "audit.json"
        process = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("audit_git_privacy.py")),
                                  "--root", str(self.root), "--source-dir", str(self.source),
                                  "--scope", "staged", "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertFalse(json.loads(process.stdout)["passed"])
        self.assertEqual(json.loads(process.stdout)["parse_errors"], 1)
        self.assertEqual(json.loads(output.read_text())["errors"],
                         [{"path": "input.json", "error_type": "DuplicateJSONKeyError"}])
        displayed = process.stdout + process.stderr + output.read_text()
        self.assertNotIn(self.original, displayed)
        self.assertNotIn(key, displayed)

    def test_duplicate_keys_in_source_prevent_a_successful_audit(self):
        record = json.dumps({"utterances": [{"speaker": "synthetic", "text": self.original}]})
        with gzip.open(self.source / "conversation/source_dialogues.train.jsonl.gz", "wt", encoding="utf-8") as stream:
            stream.write(record[:-1] + ',"utterances":[]}\n')
        self.stage("clean.json", '{}')
        with self.assertRaises(ValueError):
            audit(self.root, self.source)
        process = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("audit_git_privacy.py")),
                                  "--root", str(self.root), "--source-dir", str(self.source)],
                                 capture_output=True, text=True)
        self.assertEqual(process.returncode, 2)
        self.assertEqual(json.loads(process.stdout),
                         {"passed": False, "audit_incomplete": True, "error_type": "DuplicateJSONKeyError"})
        self.assertNotIn(self.original, process.stdout + process.stderr)

    def test_utf16_json_cannot_bypass_index_audit(self):
        payload = {"original": self.original}
        content = json.dumps(payload, ensure_ascii=False).encode("utf-16")
        self.assertEqual(json.loads(content), payload)
        self.stage("input.json", content)
        (self.root / "input.json").write_text('{}')
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertNotIn("binary_not_scanned", report["coverage"])
        self.assertTrue(report["errors"] or report["exact_source_text_files"])
        self.assertNotIn(self.original, json.dumps(report, ensure_ascii=False))

    def test_utf8_json_formats_scan_values_with_optional_bom(self):
        for suffix in ("json", "jsonl", "ndjson"):
            for encoding in ("utf-8", "utf-8-sig"):
                for escaped in (False, True):
                    with self.subTest(suffix=suffix, encoding=encoding, escaped=escaped):
                        path = f"{encoding}-{escaped}.{suffix}"
                        content = json.dumps({"original": self.original}, ensure_ascii=escaped)
                        if suffix != "json":
                            content = '{}\n' + content + '\n'
                        self.stage(path, content.encode(encoding))
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual(report["exact_source_text_files"], 12)
        self.assertEqual(report["coverage"], {"json": 4, "jsonl": 8})
        self.assertEqual(report["errors"], [])

    def test_nonmatching_utf8_bom_json_formats_can_pass(self):
        for suffix in ("json", "jsonl", "ndjson"):
            self.stage(f"clean.{suffix}", '{"text":"독립 합성 테스트"}'.encode("utf-8-sig"))
        report = audit(self.root, self.source)
        self.assertTrue(report["passed"])
        self.assertEqual(report["coverage"], {"json": 1, "jsonl": 2})

    def test_non_utf8_json_formats_fail_closed(self):
        encodings = ("utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be", "cp949")
        for suffix in ("json", "jsonl", "ndjson"):
            for encoding in encodings:
                self.stage(f"{encoding}.{suffix}", json.dumps({"text": "합성 테스트"}, ensure_ascii=False).encode(encoding))
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 21)
        self.assertEqual(report["coverage"], {})

    def test_nul_and_malformed_utf8_json_formats_fail_closed(self):
        for suffix in ("json", "jsonl", "ndjson"):
            for name, content in (("nul", b'{"text":"not\x00json"}'),
                                  ("trailing-nul", b'{}\x00'),
                                  ("invalid-byte", b'{"text":"\xff"}'),
                                  ("truncated-utf8", b'{"text":"\xe3\x81')):
                self.stage(f"{name}.{suffix}", content)
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 12)
        self.assertEqual(report["coverage"], {})

    def test_gzip_json_encoding_boundary_is_enforced(self):
        content = json.dumps({"original": self.original}, ensure_ascii=False)
        for suffix in ("json", "jsonl", "ndjson"):
            for encoding in ("utf-8-sig", "utf-16", "utf-32"):
                self.stage(f"{encoding}.{suffix}.gz", gzip.compress(content.encode(encoding)))
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(report["exact_source_text_files"], 3)
        self.assertEqual(len(report["errors"]), 6)
        self.assertNotIn("binary_not_scanned", report["coverage"])

    def test_office_embedded_json_encoding_cannot_bypass_audit(self):
        for suffix, content in (("json", json.dumps({"original": self.original}).encode("utf-16")),
                                ("jsonl", b'\x89PNG\r\n\x1a\n')):
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("[Content_Types].xml", '<Types/>')
                bundle.writestr("_rels/.rels", '<Relationships/>')
                bundle.writestr("ppt/presentation.xml", '<presentation/>')
                bundle.writestr("ppt/embeddings/input." + suffix, content)
            self.stage(suffix + ".pptx", archive.getvalue())
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 2)
        self.assertEqual(report["coverage"], {})

    def test_cli_rejects_non_utf8_without_printing_source(self):
        self.stage("input.json", json.dumps({"original": self.original}, ensure_ascii=False).encode("utf-16"))
        (self.root / "input.json").write_text('{}')
        output = self.root / "audit.json"
        process = subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("audit_git_privacy.py")),
                                  "--root", str(self.root), "--source-dir", str(self.source),
                                  "--scope", "staged", "--output", str(output)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertFalse(json.loads(process.stdout)["passed"])
        self.assertEqual(json.loads(process.stdout)["parse_errors"], 1)
        self.assertEqual(json.loads(output.read_text())["errors"],
                         [{"path": "input.json", "error_type": "UnicodeDecodeError"}])
        self.assertNotIn(self.original, process.stdout + process.stderr + output.read_text())

    def test_indexed_ignore_policy_cannot_be_hidden_by_unstaged_policy(self):
        self.stage("private/labels.csv", "1,0,1\n")
        self.stage(".gitignore", "private/\n")
        (self.root / ".gitignore").write_text("")
        report = audit(self.root, self.source, "staged")
        self.assertFalse(report["passed"])
        self.assertEqual(report["findings"][0]["reasons"], ["tracked_but_ignored"])

    def test_unstaged_ignore_policy_does_not_change_index_audit(self):
        self.stage("private/metadata.json", "{}")
        self.stage(".gitignore", "")
        (self.root / ".gitignore").write_text("private/\n")
        self.assertTrue(audit(self.root, self.source, "staged")["passed"])

    def test_exact_size_limit_is_rejected(self):
        self.stage("binary.bin", b'\x00' * (10 * 1024 * 1024))
        self.assertIn("file_ge_10MiB", audit(self.root, self.source)["findings"][0]["reasons"])

    def test_compressed_json_and_plain_paragraph_are_checked(self):
        self.stage("raw.json.gz", gzip.compress(json.dumps({"original": self.original}).encode()))
        self.stage("notes.md", "# heading\n\n" + self.original + "\n")
        self.assertEqual(audit(self.root, self.source)["exact_source_text_files"], 2)

    def test_missing_source_is_not_a_successful_audit(self):
        with self.assertRaises(FileNotFoundError):
            audit(self.root, self.root / "missing")

    def test_archives_and_renamed_compressed_data_fail_closed(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("input.json", json.dumps({"original": self.original}))
        for name, content in [("copy.zip", archive.getvalue()), ("renamed.bin", archive.getvalue()),
                              ("compressed.bin", gzip.compress(self.original.encode()))]:
            self.stage(name, content)
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 3)
        self.assertEqual({item["error_type"] for item in report["errors"]}, {"UnsupportedArchiveError"})

    def test_archive_renamed_as_office_cannot_pass_without_package_structure(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("source.json", json.dumps({"original": self.original}))
        for extension in ("pptx", "docx", "xlsx"):
            self.stage("renamed." + extension, archive.getvalue())
        report = audit(self.root, self.source)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["errors"]), 3)

    def test_office_structure_is_accepted_but_embedded_text_is_still_scanned(self):
        for include_source in (False, True):
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
                bundle.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
                bundle.writestr("ppt/presentation.xml", '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
                if include_source:
                    bundle.writestr("ppt/embeddings/source.json", json.dumps({"original": self.original}))
            self.stage("example.pptx", archive.getvalue())
            report = audit(self.root, self.source)
            self.assertEqual(report["passed"], not include_source)
            self.assertEqual(report["exact_source_text_files"], int(include_source))

    def test_nonmatching_synthetic_code_can_be_tracked(self):
        self.stage("example.json", json.dumps({"text": "독립 합성 테스트"}))
        self.assertTrue(audit(self.root, self.source)["passed"])

    def test_symlink_content_is_not_followed(self):
        (self.root / "secret.txt").write_text(self.original)
        (self.root / "link.txt").symlink_to("secret.txt")
        self.git("add", "link.txt")
        self.assertTrue(audit(self.root, self.source)["passed"])


if __name__ == "__main__":
    unittest.main()
