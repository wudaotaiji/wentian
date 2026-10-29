"""実HTTPの商取引負荷と互換性ルールの性能を検証します。実決済は行いません。"""
from pathlib import Path
import subprocess

# 合成データをメモリー内の専用台帳へ投入し、本番の住所・注文・在庫に触れません。
# TypeScript版の検証入口を使い、PowerShell版と同じ基準・証跡を生成します。
subprocess.run(['node', '--import', 'tsx', 'src/commerce-verify.ts'],
               cwd=Path(__file__).resolve().parents[1], check=True)
