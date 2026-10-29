"""SQLiteのバックアップ（Backup）APIで、稼働中の取引台帳を一貫した状態で退避します。"""
from pathlib import Path
import argparse
import sqlite3

parser = argparse.ArgumentParser(description='商取引台帳の退避。既存の退避ファイルは上書きしません。')
parser.add_argument('--database', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = args.database.resolve()
target = args.output.resolve()
# 空の台帳作成や既存データ破壊を避け、対象を明示的に検証します。
if not source.is_file() or target.exists() or source == target:
    raise SystemExit('入力台帳が存在しないか、出力先が既に存在します。')
target.parent.mkdir(parents=True, exist_ok=True)
# 読み取り専用で接続し、WALを含む論理状態をSQLite自身に複製させます。
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
    with sqlite3.connect(target) as backup:
        original.backup(backup)
        if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise SystemExit('退避台帳の整合性検査に失敗しました。')
print(f'取引台帳を退避しました: {target}')
