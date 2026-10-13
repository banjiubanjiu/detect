"""Offline regressions: python -m unittest discover -s tests -v."""

import io
import json
import os
import runpy
import sys
import tempfile
import unittest
from concurrent.futures import CancelledError
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from threading import Barrier, Event
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect
import translate_pending


class TranslationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sources = self.root / "data" / "sources"
        self.source_dir = self.sources / "web"
        self.source_dir.mkdir(parents=True)
        # Make the fallback available, so accidentally falling through is detected.
        (self.root / "bin").mkdir()
        (self.root / "bin" / "trans").touch()
        self.stdout = io.StringIO()
        self.stderr = io.StringIO()
        for context in (
            patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}),
            patch.object(Path, "home", return_value=self.root),
            patch.object(translate_pending, "SOURCES_DIR", self.sources),
            patch.object(sys, "argv", ["translate_pending.py"]),
            patch.object(collect.time, "sleep"),
            redirect_stdout(self.stdout),
            redirect_stderr(self.stderr),
        ):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)
        self.fallback = patch.object(collect.subprocess, "run").start()
        self.addCleanup(patch.stopall)
        self.fallback.return_value.returncode = 1

    def make_sources(self, count):
        paths = []
        for i in range(count):
            path = self.source_dir / f"article-{i:03d}.md"
            path.write_text(f"# Article {i}\n\n" + "English article content. " * 20)
            os.utime(path, (1000 + i, 1000 + i))
            paths.append(path)
        return paths

    @staticmethod
    def payment_error():
        return HTTPError("https://openrouter.ai/api/v1/chat/completions",
                         402, "Payment Required", {}, None)

    @staticmethod
    def response():
        return io.BytesIO(json.dumps({
            "choices": [{"message": {"content": "翻译内容。" * 100}}]
        }).encode())

    def test_payment_error_propagates_without_fallback_or_file_log(self):
        source, = self.make_sources(1)
        stop = Event()
        with patch.object(collect.urllib.request, "urlopen", side_effect=self.payment_error()):
            with self.assertRaises(collect.TranslationPaymentRequired):
                collect.translate_file(source, stop_event=stop)
        self.assertTrue(stop.is_set())
        self.assertFalse(source.with_suffix(".zh.md").exists())
        self.fallback.assert_not_called()
        self.assertEqual(self.stderr.getvalue(), "")

    def test_concurrent_payment_errors_stop_60_file_batch_once(self):
        self.make_sources(389)
        barrier = Barrier(translate_pending.WORKERS)

        def fail_together(*args, **kwargs):
            barrier.wait(timeout=10)
            raise self.payment_error()

        with patch.object(collect.urllib.request, "urlopen", side_effect=fail_together) as request:
            self.assertEqual(translate_pending.main(), 1)
        self.assertEqual(request.call_count, translate_pending.WORKERS)
        self.assertEqual(self.stderr.getvalue().count("HTTP 402"), 1)
        self.assertIn("credits/billing", self.stderr.getvalue())
        self.assertIn("rerun the workflow", self.stderr.getvalue())
        self.assertIn("0 成功 / 10 失败", self.stdout.getvalue())
        self.assertIn("已取消/跳过: 50 篇", self.stdout.getvalue())
        self.assertIn("剩余待翻译: 389 篇", self.stdout.getvalue())
        self.fallback.assert_not_called()
        self.assertFalse(list(self.source_dir.glob("*.zh.md")))

    def test_payment_error_after_success_still_fails_and_leaves_rest_pending(self):
        self.make_sources(4)
        with patch.object(translate_pending, "WORKERS", 1), patch.object(
            collect.urllib.request, "urlopen",
            side_effect=[self.response(), self.payment_error()],
        ) as request:
            self.assertEqual(translate_pending.main(), 1)
        self.assertEqual(request.call_count, 2)
        self.assertIn("1 成功 / 1 失败", self.stdout.getvalue())
        self.assertIn("剩余待翻译: 3 篇", self.stdout.getvalue())
        self.assertEqual(len(list(self.source_dir.glob("*.zh.md"))), 1)
        self.fallback.assert_not_called()

    def test_ordinary_provider_and_response_errors_remain_isolated(self):
        self.make_sources(6)
        errors = [HTTPError("https://openrouter.ai", code, "file error", {}, None)
                  for code in (400, 429, 500)]
        errors += [URLError("connection failed"), io.BytesIO(b"not json"), self.response()]
        with patch.object(translate_pending, "WORKERS", 1), patch.object(
            collect.urllib.request, "urlopen", side_effect=errors,
        ) as request:
            self.assertEqual(translate_pending.main(), 0)
        self.assertEqual(request.call_count, 6)
        self.assertEqual(self.fallback.call_count, 5)
        self.assertIn("1 成功 / 5 失败", self.stdout.getvalue())
        self.assertNotIn("batch stopped", self.stderr.getvalue())

    def test_unexpected_file_exception_does_not_stop_batch(self):
        self.make_sources(3)
        with patch.object(translate_pending, "translate_file", side_effect=OSError("bad file")) as translate:
            self.assertEqual(translate_pending.main(), 1)
        self.assertEqual(translate.call_count, 3)
        self.assertIn("0 成功 / 3 失败", self.stdout.getvalue())
        self.assertNotIn("已取消", self.stdout.getvalue())

    def test_stop_is_checked_before_provider_request(self):
        source, = self.make_sources(1)
        stop = Event()
        original_request = collect.urllib.request.Request

        def stop_during_preparation(*args, **kwargs):
            stop.set()
            return original_request(*args, **kwargs)

        with patch.object(collect.urllib.request, "Request", side_effect=stop_during_preparation), patch.object(
            collect.urllib.request, "urlopen",
        ) as request:
            with self.assertRaises(CancelledError):
                collect.translate_file(source, stop_event=stop)
        request.assert_not_called()
        self.fallback.assert_not_called()

    def test_stopped_batch_does_not_start_fallback(self):
        source, = self.make_sources(1)
        stop = Event()

        def other_worker_stopped_batch(*args, **kwargs):
            stop.set()
            raise URLError("file error")

        with patch.object(collect.urllib.request, "urlopen", side_effect=other_worker_stopped_batch):
            with self.assertRaises(CancelledError):
                collect.translate_file(source, stop_event=stop)
        self.fallback.assert_not_called()

    def test_empty_batch_succeeds_without_provider_calls(self):
        with patch.object(collect.urllib.request, "urlopen") as request:
            self.assertEqual(translate_pending.main(), 0)
        request.assert_not_called()

    def test_cli_exits_nonzero_on_payment_error(self):
        self.make_sources(1)
        # Execute the real __main__ / sys.exit path against temporary source files.
        script = self.root / "scripts" / "translate_pending.py"
        script.parent.mkdir()
        script.write_text(Path(translate_pending.__file__).read_text())
        with patch.object(collect.urllib.request, "urlopen", side_effect=self.payment_error()):
            with self.assertRaises(SystemExit) as result:
                runpy.run_path(str(script), run_name="__main__")
        self.assertEqual(result.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
