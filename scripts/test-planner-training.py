"""モデルを取得せず、データ分離と危険判定の評価条件を検証する。"""
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
import hashlib
import os
import sys
from types import SimpleNamespace
from unittest import mock

# ハイフン付きファイルを固定パスで読み込み、PyTorchの導入なしに純粋関数を試験する。
spec = importlib.util.spec_from_file_location("train_planner", Path(__file__).with_name("train-planner.py"))
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
reproduce_spec = importlib.util.spec_from_file_location("reproduce_planner", Path(__file__).with_name("reproduce-planner-training.py"))
reproduce = importlib.util.module_from_spec(reproduce_spec)
reproduce_spec.loader.exec_module(reproduce)
quality_spec = importlib.util.spec_from_file_location("improve_planner", Path(__file__).with_name("improve-planner.py"))
quality = importlib.util.module_from_spec(quality_spec)
quality_spec.loader.exec_module(quality)


class TrainingTests(unittest.TestCase):
    """学習と評価の独立性、および誤書込み判定の拒否を確認する。"""
    def rows(self):
        """確認済みの架空例だけを返す。利用者の履歴は読み込まない。"""
        return [{"input": f"挨拶{i}", "reviewed": True, "label": {"intent": "chat", "operation": "answer", "tools": [], "required_capabilities": ["text"]}} for i in range(25)]

    def test_split(self):
        """順番を変えても分離が同じで、入力の重複は拒否される。"""
        training, evaluation = engine.split_examples(self.rows())
        self.assertEqual(len(evaluation), 5)
        self.assertTrue(set(row["input"] for row in training).isdisjoint(row["input"] for row in evaluation))
        self.assertEqual((training, evaluation), engine.split_examples(list(reversed(self.rows()))))
        with self.assertRaises(ValueError):
            engine.split_examples(self.rows() + self.rows()[:1])

    def test_evaluation(self):
        """正解率だけで誤書込みを許可せず、構文不正も不合格にする。"""
        rows = self.rows()
        predictions = [json.dumps(row["label"]) for row in rows]
        self.assertTrue(engine.score_predictions(rows, predictions)["passed"])
        predictions[0] = json.dumps({"intent": "local_tool", "operation": "write", "tools": ["write_file"]})
        report = engine.score_predictions(rows, predictions)
        self.assertGreater(report["accuracy"], 0.9)
        self.assertEqual(report["unsafeWrites"], 1)
        self.assertFalse(report["passed"])
        self.assertFalse(engine.score_predictions(rows, ["不正"] * len(rows))["passed"])

    def test_fixed_split(self):
        """固定評価例を訓練へ混入させず、分割指定の欠落も拒否する。"""
        rows = self.rows()
        for index, row in enumerate(rows):
            row["split"] = "train" if index < 20 else "evaluation"
        training, evaluation = engine.split_examples(rows)
        self.assertEqual(training, rows[:20])
        self.assertEqual(evaluation, rows[20:])
        del rows[0]["split"]
        with self.assertRaises(ValueError):
            engine.split_examples(rows)

    def test_reproduction_integrity(self):
        """再現実行前の検査で、データ変更と保存範囲外の参照を拒否する。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            data = root / "dataset.jsonl"
            data.write_bytes(b"original")
            entry = {"path": data.name, "bytes": 8, "sha256": hashlib.sha256(b"original").hexdigest()}
            manifest = root / "model-manifest.json"
            manifest.write_text(json.dumps({"files": [entry]}), encoding="utf-8")
            reproduce.verify_source(root)
            data.write_bytes(b"modified")
            with self.assertRaises(ValueError):
                reproduce.verify_source(root)
            entry["path"] = "../outside.jsonl"
            manifest.write_text(json.dumps({"files": [entry]}), encoding="utf-8")
            with self.assertRaises(ValueError):
                reproduce.verify_source(root)

    def test_cuda_workspace_before_initialization(self):
        """CUDA初期化前に決定的演算の設定を行い、明示設定は保持する。"""
        for explicit in (None, ':16:8'):
            environment = {} if explicit is None else {'CUBLAS_WORKSPACE_CONFIG': explicit}

            def initialize_threads(_count):
                # GPUなしの試験でも、torch初期化時点の設定順序を確認します。
                self.assertEqual(os.environ['CUBLAS_WORKSPACE_CONFIG'], explicit or ':4096:8')

            fake_torch = SimpleNamespace(set_num_threads=initialize_threads, cuda=SimpleNamespace(is_available=lambda: False))
            fake_transformers = SimpleNamespace(AutoModelForCausalLM=object, AutoTokenizer=object)
            with mock.patch.dict(os.environ, environment, clear=True), mock.patch.dict(sys.modules, {'torch':fake_torch, 'transformers':fake_transformers}):
                with self.assertRaisesRegex(RuntimeError, 'CUDA'):
                    engine.load_model(Path('unused-gpu-fixture'), device='cuda')

    def test_reproduction_preserves_refinement_settings(self):
        """補習の再現コマンドが親重み・モデル版・学習率・対象層を保持することを確認します。"""
        with tempfile.TemporaryDirectory() as temporary:
            source=Path(temporary)/'source-job'
            source.mkdir()
            (source/'parent-adapter').mkdir()
            (source/'parent-adapter/adapter_model.safetensors').write_bytes(b'parent')
            config={'baseModel':engine.BASE_MODEL,'revision':engine.BASE_REVISION,'steps':600,'seed':42,'device':'cuda',
                    'learningRate':0.0001,'rank':16,'targetModules':'all-linear','evaluationBatchSize':4,
                    'parentAdapterPath':'parent-adapter','parentAdapterSha256':hashlib.sha256(b'parent').hexdigest()}
            (source/'training-config.json').write_text(json.dumps(config),encoding='utf-8')
            for name in ['dataset.jsonl','prompt.json']:(source/name).write_text('{}',encoding='utf-8')
            target=Path(temporary)/'new-job'
            def capture(command,**_kwargs):
                # 実際の学習を起動せず、保存設定から生成された引数だけを検収します。
                self.assertEqual(command[command.index('--learning-rate')+1],'0.0001')
                self.assertEqual(command[command.index('--lora-rank')+1],'16')
                self.assertEqual(command[command.index('--evaluation-batch-size')+1],'4')
                self.assertIn('--all-linear',command)
                self.assertEqual(command[command.index('--resume-adapter')+1],str(source/'parent-adapter'))
                raise InterruptedError('試験のため学習開始前に停止')
            with mock.patch.object(reproduce,'verify_source'),mock.patch.object(reproduce.subprocess,'run',side_effect=capture),mock.patch.object(sys,'argv',['reproduce','--source',str(source),'--output',str(target)]):
                with self.assertRaises(InterruptedError):reproduce.main()

    def test_quality_evaluation_is_independent(self):
        """改善用の教師例と、既存評価・新規最終評価の入力が重ならないことを確認する。"""
        original = quality.module('quality_test_original', 'prepare-planner-dataset.py')
        training, final = quality.training_examples(), quality.final_examples()
        old_evaluation = {row['input'] for row in original.build_rows() if row['split']=='evaluation'}
        inputs = {row['input'] for row in training}
        final_inputs = {row['input'] for row in final}
        self.assertTrue(inputs.isdisjoint(old_evaluation))
        self.assertTrue(inputs.isdisjoint(final_inputs))
        self.assertTrue(final_inputs.isdisjoint(old_evaluation))
        self.assertEqual(len(final_inputs),120)
        for language in ['ja','zh','en']:
            self.assertEqual(sum(row['label']['language']==language for row in final),40)
        self.assertTrue(engine.score_predictions(final,[json.dumps(row['label']) for row in final])['passed'])

    def test_untrusted_model_configuration_is_rejected(self):
        """保存設定を改変しても任意モデルや可変リビジョンを読み込まない。"""
        fake_torch=SimpleNamespace(set_num_threads=lambda _:None, cuda=SimpleNamespace(is_available=lambda:False))
        fake_transformers=SimpleNamespace(AutoModelForCausalLM=object, AutoTokenizer=object)
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(sys.modules,{'torch':fake_torch,'transformers':fake_transformers}):
            root=Path(temporary)
            for config in [{'baseModel':'untrusted/model','revision':engine.BASE_REVISION}, {'baseModel':engine.BASE_MODEL,'revision':'main'}]:
                (root/'training-config.json').write_text(json.dumps(config),encoding='utf-8')
                with self.assertRaisesRegex(ValueError,'基盤モデル'):
                    engine.load_model(root,device='cpu')


if __name__ == "__main__":
    unittest.main()
